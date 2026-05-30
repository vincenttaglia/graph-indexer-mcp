import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { Config } from '../config.js';

/** Path the MCP StreamableHTTP protocol is served on. */
const MCP_PATH = '/mcp';

/**
 * Extract the caller's bearer token from the `Authorization` header and stash it
 * on `req.auth` so the SDK surfaces it as `extra.authInfo` to message handlers
 * (and, via register.ts, as the RequestContext identity).
 *
 * IMPORTANT — pass-through, NOT validation. We deliberately do NOT verify the
 * token here. In `k8s-rbac` mode the real validation is a Kubernetes TokenReview
 * (plus a SubjectAccessReview for the grant), performed later by the authorizer.
 * In `static` mode the token is ignored entirely. This function's only job is to
 * make the raw token visible to the one chokepoint (`checkAccess`) so per-tool
 * authorization can see the caller. The synthetic `clientId`/`scopes` fields exist
 * only to satisfy the SDK's `AuthInfo` shape; they carry no security meaning.
 */
function extractBearerAuth(req: IncomingMessage): AuthInfo | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const token = raw.trim();
  if (token.length === 0) return undefined;
  return {
    token,
    // Unverified placeholders — validation happens downstream (TokenReview).
    clientId: 'http-bearer',
    scopes: [],
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Host the MCP server over the StreamableHTTP transport on a plain Node `http`
 * server (no express/fastify — keeps the dependency list lean).
 *
 * Session handling follows the SDK's stateful pattern: an `initialize` request
 * (no `Mcp-Session-Id` header) spins up a fresh `StreamableHTTPServerTransport`
 * with a generated session id; subsequent requests are routed to the existing
 * transport by their `Mcp-Session-Id` header. This lets multiple clients share
 * one `http` server.
 *
 * Health endpoints:
 *   - `GET /healthz` — liveness: 200 as soon as the process is up.
 *   - `GET /readyz`  — readiness: 200 only once `server.connect()` has succeeded
 *     for at least one transport path, else 503. (In k8s-rbac mode the
 *     authorizer's SAR self-check has already run in index.ts before we bind.)
 */
export async function startHttpTransport(
  server: McpServer,
  config: Config,
): Promise<{ close(): Promise<void> }> {
  // Active sessions, keyed by the SDK-generated session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Readiness flips true after the first successful server.connect(). Because the
  // McpServer can only be connected to a single transport at a time in this SDK,
  // we connect lazily per-session; the first successful connect marks us ready.
  let ready = false;

  const handleMcp = async (
    req: IncomingMessage & { auth?: AuthInfo },
    res: ServerResponse,
  ): Promise<void> => {
    // Surface the bearer token to handlers (see extractBearerAuth doc comment).
    req.auth = extractBearerAuth(req);

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;

    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      // New session: only POST (an `initialize` request) may open one. The SDK
      // enforces the JSON-RPC semantics; we just hand it a fresh transport.
      if (req.method !== 'POST') {
        writeJson(res, 400, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'No valid session: expected an initialize POST.',
          },
          id: null,
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport as StreamableHTTPServerTransport);
        },
        onsessionclosed: (id) => {
          transports.delete(id);
        },
      });

      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id) transports.delete(id);
      };

      // Connect this transport to the shared McpServer. The SDK supports
      // multiple concurrent StreamableHTTP transports bound to one server.
      await server.connect(transport);
      ready = true;
    }

    await transport.handleRequest(req, res);
  };

  const httpServer: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    // Strip query string for path matching.
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/';

    if (path === '/healthz' && method === 'GET') {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    if (path === '/readyz' && method === 'GET') {
      if (ready) {
        writeJson(res, 200, { status: 'ready' });
      } else {
        writeJson(res, 503, { status: 'not_ready' });
      }
      return;
    }

    if (path === MCP_PATH) {
      void handleMcp(req, res).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[mcp] http request error: ${detail}\n`);
        if (!res.headersSent) {
          writeJson(res, 500, {
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        } else {
          res.end();
        }
      });
      return;
    }

    writeJson(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(config.httpPort, config.httpHost, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  process.stderr.write(
    `[mcp] http transport listening on ${config.httpHost}:${config.httpPort} (mcp=${MCP_PATH}, healthz=/healthz, readyz=/readyz)\n`,
  );

  return {
    async close(): Promise<void> {
      // Stop accepting new connections, then tear down active sessions.
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      ready = false;
      const pending = [...transports.values()].map(async (t) => {
        try {
          await t.close();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[mcp] http transport close error: ${detail}\n`,
          );
        }
      });
      transports.clear();
      await Promise.all(pending);
    },
  };
}
