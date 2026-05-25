import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';

import {
  checkAccess,
  registerToolPermission,
  type PermissionClass,
} from '../access-control.js';

/**
 * Per-request context the SDK passes alongside the parsed args. Exposes the
 * client's abort signal, request id, session id, auth info, and notification
 * helpers. Handlers should observe `extra.signal` for cancellable long-running
 * I/O (graphman, Postgres, gateway calls).
 */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// =============================================================================
// Tools
// =============================================================================

type InferArgs<TSchema extends ZodRawShape | undefined> = TSchema extends ZodRawShape
  ? z.infer<z.ZodObject<TSchema>>
  : Record<string, never>;

export interface IndexerToolDefinition<TSchema extends ZodRawShape | undefined = undefined> {
  /** MCP tool name (snake_case). Must be unique server-wide. */
  name: string;
  /** Permission class — gates execution via access-control. */
  permissionClass: PermissionClass;
  /** Human-readable summary shown to the model. */
  description: string;
  /** Optional Zod shape for input validation. Omit for zero-arg tools. */
  inputSchema?: TSchema;
  /**
   * Handler. Throw or return `{ isError: true }` for failures.
   * Observe `extra.signal` for client-initiated cancellation.
   */
  handler: (
    args: InferArgs<TSchema>,
    extra: ToolExtra,
  ) => Promise<CallToolResult> | CallToolResult;
}

/**
 * Register an MCP tool with access control baked in.
 *
 *   - Records the permission class so `checkAccess` knows about it.
 *   - Appends a "[Requires permission: …]" hint to the description so clients
 *     (and Claude) can see what each tool needs.
 *   - On call, runs `checkAccess` first; denied calls return an `isError`
 *     `CallToolResult` rather than executing the handler.
 *   - Forwards the SDK's `RequestHandlerExtra` (abort signal, request id,
 *     session/auth info) so handlers can honor cancellation.
 *
 * Stage 1 data-source modules should be the only callers of this function.
 */
export function registerIndexerTool<TSchema extends ZodRawShape | undefined = undefined>(
  server: McpServer,
  def: IndexerToolDefinition<TSchema>,
): void {
  registerToolPermission(def.name, def.permissionClass);

  const annotatedDescription = `${def.description}\n\n[Requires permission: ${def.permissionClass}]`;

  const runUserHandler = async (
    rawArgs: unknown,
    extra: ToolExtra,
  ): Promise<CallToolResult> => {
    const check = checkAccess(def.name);
    if (!check.allowed) {
      return {
        content: [
          {
            type: 'text',
            text: check.reason ?? `Access denied for tool "${def.name}".`,
          },
        ],
        isError: true,
      };
    }
    try {
      return await def.handler(rawArgs as InferArgs<TSchema>, extra);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Tool "${def.name}" failed: ${detail}` }],
        isError: true,
      };
    }
  };

  // McpServer's callback signatures differ for zero-arg vs. arg'd tools:
  //   with schema:   (args, extra) => CallToolResult
  //   no schema:     (extra)       => CallToolResult
  // The cast localizes the branching so user-facing handlers stay clean.
  type AnyCb = Parameters<McpServer['registerTool']>[2];

  if (def.inputSchema) {
    const cb = ((args: unknown, extra: ToolExtra) =>
      runUserHandler(args, extra)) as AnyCb;
    server.registerTool(
      def.name,
      {
        description: annotatedDescription,
        inputSchema: def.inputSchema,
      },
      cb,
    );
  } else {
    const cb = ((extra: ToolExtra) => runUserHandler({}, extra)) as AnyCb;
    server.registerTool(def.name, { description: annotatedDescription }, cb);
  }
}

// =============================================================================
// Resources
// =============================================================================

export interface IndexerResourceDefinition {
  /** Stable internal name (used by MCP for diagnostics). */
  name: string;
  /** Concrete URI, e.g. `indexer://config`. */
  uri: string;
  description: string;
  mimeType?: string;
  /** Observe `extra.signal` for cancellable resource reads. */
  handler: (uri: URL, extra: ToolExtra) => Promise<ReadResourceResult> | ReadResourceResult;
}

export function registerIndexerResource(
  server: McpServer,
  def: IndexerResourceDefinition,
): void {
  server.registerResource(
    def.name,
    def.uri,
    { description: def.description, mimeType: def.mimeType },
    async (uri, extra) => def.handler(uri, extra as ToolExtra),
  );
}

// =============================================================================
// Prompts
// =============================================================================

export interface IndexerPromptDefinition<TSchema extends ZodRawShape | undefined = undefined> {
  name: string;
  description: string;
  argsSchema?: TSchema;
  handler: (
    args: InferArgs<TSchema>,
    extra: ToolExtra,
  ) => Promise<GetPromptResult> | GetPromptResult;
}

export function registerIndexerPrompt<TSchema extends ZodRawShape | undefined = undefined>(
  server: McpServer,
  def: IndexerPromptDefinition<TSchema>,
): void {
  // The SDK's registerPrompt is heavily overloaded on the Args generic, and TS
  // can't narrow our TSchema union (`ZodRawShape | undefined`) to the concrete
  // overload branch. Cast through a relaxed signature to bypass overload
  // selection; the public IndexerPromptDefinition keeps the call-site types
  // honest.
  const register = server.registerPrompt.bind(server) as unknown as (
    name: string,
    config: { description: string; argsSchema?: ZodRawShape },
    cb: (
      argsOrExtra: Record<string, unknown> | ToolExtra,
      extra?: ToolExtra,
    ) => Promise<GetPromptResult> | GetPromptResult,
  ) => void;

  if (def.argsSchema) {
    register(
      def.name,
      { description: def.description, argsSchema: def.argsSchema },
      (args, extra) =>
        def.handler(args as InferArgs<TSchema>, extra as ToolExtra),
    );
  } else {
    register(def.name, { description: def.description }, (extra) =>
      def.handler({} as InferArgs<TSchema>, extra as ToolExtra),
    );
  }
}
