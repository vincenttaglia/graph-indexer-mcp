/**
 * Generic TTL cache with request coalescing.
 *
 * Implements the caching contract described in design §4.1.2: per-instance
 * TTL, optional bounded size (insertion-order eviction), and `getOrFetch`
 * with in-flight de-duplication so concurrent callers for the same key share
 * one upstream request (thundering-herd protection).
 *
 * Logging: emits one-line stderr events tagged with the configured `label`,
 * matching the existing `[gql <label>] ...` convention. Pass a per-call
 * `keyLabel` to `getOrFetch` for richer messages.
 */

export interface TtlCacheOptions {
  /** Time-to-live for each entry, milliseconds. */
  ttlMs: number;
  /**
   * Optional max number of entries. When exceeded, the oldest INSERTED entry
   * is evicted (insertion-order eviction — a coarse LRU approximation that's
   * sufficient for §4.1.2 scale).
   */
  maxEntries?: number;
  /** Human-readable label for stderr logging (e.g. 'network_params'). */
  label?: string;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Per-key inflight coalescing token. The first caller installs this; later
 * callers attach their own `.then` to the SAME promise instead of starting
 * another fetch. The fetcher receives the FIRST caller's signal — subsequent
 * callers can still throw to *their* await via their own `opts.signal`, but
 * cancelling theirs does NOT cancel the upstream fetch (other coalesced
 * callers still depend on it).
 */
interface InflightEntry<V> {
  promise: Promise<V>;
}

export class TtlCache<K, V> {
  private readonly ttlMs: number;
  private readonly maxEntries: number | undefined;
  private readonly label: string;
  private readonly store: Map<K, CacheEntry<V>> = new Map();
  private readonly inflight: Map<K, InflightEntry<V>> = new Map();

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.label = opts.label ?? 'cache';
  }

  /** Returns the cached value if fresh, otherwise undefined (and evicts the stale entry). */
  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      // Active expiry: drop stale entries on read so memory doesn't grow
      // indefinitely for caches whose keys cycle.
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** True if a fresh entry exists for `key`. Side-effect: evicts an expired entry. */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /** Stores `value` with a timestamp of now. Honors `maxEntries` eviction. */
  set(key: K, value: V): void {
    // Re-insert to refresh insertion order (so eviction picks truly oldest).
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.maxEntries !== undefined && this.store.size > this.maxEntries) {
      // Map iteration order is insertion order; first key is oldest.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
  }

  /** Evicts one entry. No-op if absent. */
  invalidate(key: K): void {
    this.store.delete(key);
  }

  /** Evicts everything. Does NOT cancel in-flight fetches. */
  clear(): void {
    this.store.clear();
  }

  /**
   * Coalescing fetch:
   *   1. If a fresh entry exists for `key`, return it synchronously (wrapped
   *      in Promise.resolve). The caller's signal does NOT apply — a cache
   *      hit is essentially free.
   *   2. Else if a fetch for `key` is already in flight, await that same
   *      promise (request coalescing). The caller's own signal can still
   *      throw to *their* await without cancelling the upstream fetch.
   *   3. Else install an inflight slot, invoke `fetcher` with the FIRST
   *      caller's signal, store the result on settle, and clear the slot.
   *
   * The inflight slot is cleared on BOTH fulfillment and rejection — a
   * forgotten clear would pin a failed promise forever.
   */
  getOrFetch(
    key: K,
    fetcher: (opts: { signal?: AbortSignal }) => Promise<V>,
    opts?: { signal?: AbortSignal; keyLabel?: string },
  ): Promise<V> {
    const tag = opts?.keyLabel ?? String(key);

    const cached = this.get(key);
    if (cached !== undefined) {
      process.stderr.write(`[cache ${this.label} ${tag}] hit\n`);
      return Promise.resolve(cached);
    }

    const existing = this.inflight.get(key);
    if (existing) {
      process.stderr.write(
        `[cache ${this.label} ${tag}] coalesce (already in flight)\n`,
      );
      // Race the in-flight promise against the *caller's* signal. The
      // upstream fetch keeps running (other callers still need it); only
      // this caller's await throws.
      return this.raceWithSignal(existing.promise, opts?.signal);
    }

    process.stderr.write(`[cache ${this.label} ${tag}] miss -> fetch\n`);
    const fetchOpts: { signal?: AbortSignal } = {};
    if (opts?.signal) fetchOpts.signal = opts.signal;
    const promise = (async () => {
      try {
        const value = await fetcher(fetchOpts);
        this.set(key, value);
        return value;
      } finally {
        // Always clear the inflight slot — a forgotten clear on rejection
        // would pin a failed promise forever and break future retries.
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, { promise });
    return promise;
  }

  /**
   * Returns a promise that resolves/rejects with `source` UNLESS `signal`
   * fires first, in which case it rejects with the signal's reason. Does
   * not propagate the abort to `source`.
   */
  private raceWithSignal(source: Promise<V>, signal?: AbortSignal): Promise<V> {
    if (!signal) return source;
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    }
    return new Promise<V>((resolve, reject) => {
      const onAbort = (): void => {
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      source.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }
}
