const valueCache = new Map<string, { value: unknown; expiresAt: number }>();
const pendingCache = new Map<string, Promise<unknown>>();

function isExpired(entry: { expiresAt: number }): boolean {
  return entry.expiresAt !== 0 && Date.now() > entry.expiresAt;
}

export function peekApiCacheValue<T>(key: string): T | undefined {
  const entry = valueCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (isExpired(entry)) {
    valueCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function storeValue<T>(key: string, value: T, ttlMs: number): T {
  const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
  valueCache.set(key, { value, expiresAt });
  return value;
}

export function invalidateApiCache(prefix: string): void {
  for (const key of valueCache.keys()) {
    if (key.startsWith(prefix)) {
      valueCache.delete(key);
    }
  }
  for (const key of pendingCache.keys()) {
    if (key.startsWith(prefix)) {
      pendingCache.delete(key);
    }
  }
}

interface FetchWithCacheOptions {
  force?: boolean;
  ttlMs?: number;
}

export async function fetchWithApiCache<T>(
  key: string,
  loader: () => Promise<T>,
  options: FetchWithCacheOptions = {},
): Promise<T> {
  const { force = false, ttlMs = 60_000 } = options;

  if (!force) {
    const cached = peekApiCacheValue<T>(key);
    if (cached !== undefined) {
      return cached;
    }
    const pending = pendingCache.get(key) as Promise<T> | undefined;
    if (pending) {
      return pending;
    }
  }

  const promise = loader()
    .then((value) => storeValue(key, value, ttlMs))
    .finally(() => {
      pendingCache.delete(key);
    });

  pendingCache.set(key, promise);
  return promise;
}
