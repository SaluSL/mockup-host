export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

/**
 * In-memory is the right scope: one process, one server, and a limiter that
 * forgets everything on restart is acceptable for a personal panel.
 */
export function createRateLimiter({ windowMs, max }: RateLimiterOptions) {
  const buckets = new Map<string, { count: number; startedAt: number }>();

  return {
    check(key: string, now: number = Date.now()): boolean {
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.startedAt >= windowMs) {
        buckets.set(key, { count: 1, startedAt: now });
        return true;
      }
      if (bucket.count >= max) return false;
      bucket.count += 1;
      return true;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
