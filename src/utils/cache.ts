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
 *
 * `generation` is captured at registration. If `invalidate`/`clear`/`set`
 * bumps the per-key generation while the fetch is in flight, the resolved
 * value is silently dropped instead of overwriting fresh state — this
 * prevents a pre-mutation read from clobbering a post-mutation invalidate.
 */
interface InflightEntry<V> {
  promise: Promise<V>;
  generation: number;
}

export class TtlCache<K, V> {
  private readonly ttlMs: number;
  private readonly maxEntries: number | undefined;
  private readonly label: string;
  private readonly store: Map<K, CacheEntry<V>> = new Map();
  private readonly inflight: Map<K, InflightEntry<V>> = new Map();
  /**
   * Per-key monotonic counter. Bumped by `invalidate`/`clear`/`set` so any
   * in-flight fetch registered against an older generation knows its result
   * is now stale and must NOT be written back to `store`. Without this, a
   * graphman mutation's `invalidate(deploymentId)` could be silently
   * defeated by a pre-mutation read settling afterward.
   */
  private readonly generations: Map<K, number> = new Map();

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.label = opts.label ?? 'cache';
  }

  /** Increment and return the per-key generation; creates the entry if absent. */
  private bumpGeneration(key: K): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  /** Current generation for `key`, defaulting to 0 if never seen. */
  private currentGeneration(key: K): number {
    return this.generations.get(key) ?? 0;
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

  /**
   * Stores `value` with a timestamp of now. Honors `maxEntries` eviction.
   *
   * Bumps the per-key generation so any concurrently in-flight fetch will
   * NOT clobber `value` when it eventually resolves. Coalesced callers
   * already awaiting that in-flight still receive the older value for
   * their own use; only the cache write is suppressed.
   */
  set(key: K, value: V): void {
    this.bumpGeneration(key);
    this.writeStore(key, value);
  }

  /**
   * Internal store write that does NOT bump the generation. Used by
   * `getOrFetch` to persist a freshly-resolved value when its captured
   * generation still matches the current generation.
   */
  private writeStore(key: K, value: V): void {
    // Re-insert to refresh insertion order (so eviction picks truly oldest).
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.maxEntries !== undefined && this.store.size > this.maxEntries) {
      // Map iteration order is insertion order; first key is oldest.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
  }

  /**
   * Evicts one entry. No-op for the store if absent, but ALWAYS bumps the
   * per-key generation and drops the in-flight slot so any pre-invalidation
   * fetch settling afterward cannot resurrect stale data.
   */
  invalidate(key: K): void {
    this.store.delete(key);
    this.bumpGeneration(key);
    // Future calls re-fetch immediately rather than coalescing onto a
    // possibly-stale in-flight; the existing in-flight promise still
    // resolves for any awaiters, but its result will be dropped.
    this.inflight.delete(key);
  }

  /**
   * Evicts everything. Does NOT cancel in-flight fetches, but bumps every
   * known key's generation so their resolved values cannot repopulate.
   */
  clear(): void {
    this.store.clear();
    // Bump every key we've ever tracked — including keys currently in flight
    // but absent from `store` (e.g. first-time miss still resolving).
    const keys = new Set<K>();
    for (const k of this.generations.keys()) keys.add(k);
    for (const k of this.inflight.keys()) keys.add(k);
    for (const k of keys) this.bumpGeneration(k);
    this.inflight.clear();
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
    // Capture the generation at registration. If invalidate/clear/set
    // bumps this key's generation while we're fetching, our resolved value
    // is stale and MUST NOT be written back to `store`.
    const gen = this.currentGeneration(key);
    let promise!: Promise<V>;
    promise = (async () => {
      try {
        const value = await fetcher(fetchOpts);
        if (this.currentGeneration(key) === gen) {
          // Our generation is still current — safe to persist. Use the
          // internal write so we don't bump the generation ourselves
          // (which would invalidate any other in-flight fetches that
          // started at the same generation).
          this.writeStore(key, value);
        } else {
          process.stderr.write(
            `[cache ${this.label} ${tag}] superseded (gen ${gen} != ${this.currentGeneration(key)}); dropping fetched value\n`,
          );
        }
        return value;
      } finally {
        // Only clear the inflight slot if it's still us — invalidate()
        // may have already removed/replaced it with a newer fetch, and
        // we must not delete a successor's slot.
        if (this.inflight.get(key)?.promise === promise) {
          this.inflight.delete(key);
        }
      }
    })();
    this.inflight.set(key, { promise, generation: gen });
    // First caller: their signal is already forwarded into `fetcher` via
    // `fetchOpts.signal`, so a cancellation propagates all the way down to
    // the underlying HTTP request. No `raceWithSignal` wrapping needed.
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
