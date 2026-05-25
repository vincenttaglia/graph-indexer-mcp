import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

/**
 * Postgres client for graph-node's database. Read-only by intent — the methods
 * here only issue SELECT queries against system catalogs and the
 * `deployment_schemas` mapping table. Use a read-only role on the connection
 * string to enforce this at the database layer.
 *
 * graph-node stores each deployment's entity tables under a namespace named
 * `sgd<N>` (e.g., `sgd47`). The `public.deployment_schemas` table maps an
 * IPFS deployment hash (`subgraph` column) to that namespace (`name` column).
 */

export interface SubgraphSize {
  deploymentId: string;
  namespace: string;
  /** Total bytes, returned as a string to remain BigInt-safe. */
  sizeBytes: string;
}

export interface PostgresClient {
  /** Map a deployment IPFS hash to its `sgdN` schema name. Returns null if unknown. */
  getDeploymentNamespace(deploymentId: string): Promise<string | null>;
  /** Disk usage for one deployment. Returns null if the deployment is unknown. */
  getSubgraphSize(deploymentId: string): Promise<SubgraphSize | null>;
  /** Disk usage for every known deployment, sorted descending by size. */
  getAllSubgraphSizes(): Promise<SubgraphSize[]>;
  /** Release the underlying pool. Safe to call multiple times. */
  close(): Promise<void>;
}

interface DeploymentSchemaRow {
  subgraph: string;
  name: string;
}

interface TableNameRow {
  table_name: string;
}

interface SizeRow {
  size: string | null;
}

/**
 * Construct a Postgres client.
 *
 * Returns `null` when `connectionString` is undefined so callers can register
 * tools that surface a clear "not configured" error at call time without
 * blowing up at startup.
 */
export function createPostgresClient(
  connectionString: string | undefined,
): PostgresClient | null {
  if (!connectionString) return null;

  // Lazy pool init — defer the first TCP connect until a query actually runs.
  let pool: Pool | null = null;
  let closed = false;

  const getPool = (): Pool => {
    if (closed) {
      throw new Error('Postgres client has been closed');
    }
    if (!pool) {
      pool = new pg.Pool({
        connectionString,
        max: 5,
        // Use a sane application_name so DBAs can spot us in pg_stat_activity.
        application_name: 'graph-indexer-mcp',
      });
      // Surface pool-level errors instead of crashing the process.
      pool.on('error', (err) => {
        process.stderr.write(`[pg] pool error: ${err.message}\n`);
      });
    }
    return pool;
  };

  async function getDeploymentNamespace(
    deploymentId: string,
  ): Promise<string | null> {
    const res = await getPool().query<DeploymentSchemaRow>(
      'SELECT subgraph, name FROM public.deployment_schemas WHERE subgraph = $1 LIMIT 1',
      [deploymentId],
    );
    const row = res.rows[0];
    return row ? row.name : null;
  }

  /**
   * Sum `pg_total_relation_size` over every table in the given schema.
   *
   * We first check whether the schema actually exists via `to_regnamespace`
   * (returns NULL when absent). This distinguishes two cases that the previous
   * aggregate-with-COALESCE conflated:
   *   - schema exists but has zero base tables → return '0' (legitimate)
   *   - schema was dropped (or never created)  → return null
   *
   * Then we list table names via `information_schema.tables` (parameterized)
   * and compute the per-table size inside the query using `format` +
   * `quote_ident` so the schema/table identifiers are safely composed inside
   * Postgres — no string interpolation in Node.
   */
  async function sumSchemaSize(
    client: PoolClient | Pool,
    schema: string,
  ): Promise<string | null> {
    // Existence check first. `to_regnamespace` returns NULL for unknown
    // schemas rather than raising, which is exactly the branch we need.
    const nsRes = await client.query<{ exists: boolean }>(
      'SELECT to_regnamespace($1) IS NOT NULL AS exists',
      [schema],
    );
    if (!nsRes.rows[0]?.exists) return null;

    // The aggregate query joins to `information_schema.tables` to iterate the
    // tables, then constructs the qualified identifier with `format` +
    // `quote_ident` — so the schema string only ever reaches Postgres as a
    // bound parameter, never as raw SQL text. COALESCE to '0' here is now
    // unambiguous: schema exists, just has no base tables.
    const res = await client.query<SizeRow>(
      `SELECT COALESCE(SUM(pg_total_relation_size(
         format('%I.%I', table_schema, table_name)::regclass
       )), 0)::text AS size
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [schema],
    );
    const row = res.rows[0];
    return row ? row.size : '0';
  }

  async function getSubgraphSize(
    deploymentId: string,
  ): Promise<SubgraphSize | null> {
    const pool = getPool();
    const namespace = await getDeploymentNamespace(deploymentId);
    if (!namespace) return null;

    try {
      const sizeStr = await sumSchemaSize(pool, namespace);
      // If the schema has zero tables, COALESCE still produces '0' — but if
      // the schema was dropped between the two queries, an individual
      // `pg_total_relation_size` call inside the SUM can raise. Treat that
      // race as "deployment not found" and return null instead of throwing.
      if (sizeStr == null) return null;
      return { deploymentId, namespace, sizeBytes: sizeStr };
    } catch (err) {
      if (isMissingRelationError(err)) return null;
      throw err;
    }
  }

  async function getAllSubgraphSizes(): Promise<SubgraphSize[]> {
    const pool = getPool();
    const schemasRes = await pool.query<DeploymentSchemaRow>(
      'SELECT subgraph, name FROM public.deployment_schemas',
    );

    const results: SubgraphSize[] = [];
    for (const row of schemasRes.rows) {
      try {
        const sizeStr = await sumSchemaSize(pool, row.name);
        if (sizeStr == null) continue;
        results.push({
          deploymentId: row.subgraph,
          namespace: row.name,
          sizeBytes: sizeStr,
        });
      } catch (err) {
        // Per-deployment failures shouldn't poison the whole ranking — a
        // deployment whose schema disappears mid-iteration just drops out.
        if (isMissingRelationError(err)) continue;
        throw err;
      }
    }

    // Sort descending by size. BigInt to avoid Number-precision loss for
    // multi-TB sums.
    results.sort((a, b) => {
      const diff = BigInt(b.sizeBytes) - BigInt(a.sizeBytes);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    return results;
  }

  async function close(): Promise<void> {
    closed = true;
    if (pool) {
      const p = pool;
      pool = null;
      await p.end();
    }
  }

  return {
    getDeploymentNamespace,
    getSubgraphSize,
    getAllSubgraphSizes,
    close,
  };
}

/**
 * Detect "schema/table vanished" races. Postgres raises SQLSTATE 42P01
 * (undefined_table) when `regclass` cast targets a relation that no longer
 * exists between the listing and the size lookup.
 */
function isMissingRelationError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '42P01' || code === '3F000'; // undefined_table | invalid_schema_name
}
