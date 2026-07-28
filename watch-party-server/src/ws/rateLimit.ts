// Copyright (C) 2017-2026 Smart code 203358507

/**
 * Token-bucket rate limiting.
 *
 * A rate-limited message must never mutate canonical state (plan section 13),
 * so limiters are consulted before the payload is even validated.
 */
export class TokenBucket {
    private readonly ratePerSec: number;
    private readonly capacity: number;
    private tokens: number;
    private lastRefillMs: number;

    constructor(ratePerSec: number, burst: number, nowMs: number) {
        this.ratePerSec = ratePerSec;
        this.capacity = Math.max(1, burst);
        this.tokens = this.capacity;
        this.lastRefillMs = nowMs;
    }

    tryConsume(nowMs: number, cost = 1): boolean {
        // Clock going backwards must not mint tokens.
        const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
        this.lastRefillMs = nowMs;
        this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.ratePerSec);
        if (this.tokens < cost) {
            return false;
        }
        this.tokens -= cost;
        return true;
    }

    get available(): number {
        return this.tokens;
    }
}

/**
 * Per-key limiter with lazy eviction, used for per-IP connection limits.
 * Entries are dropped once fully refilled so the map cannot grow without bound.
 */
export class KeyedRateLimiter {
    private readonly buckets = new Map<string, TokenBucket>();
    private readonly ratePerSec: number;
    private readonly burst: number;

    constructor(options: { ratePerSec: number; burst: number }) {
        this.ratePerSec = options.ratePerSec;
        this.burst = options.burst;
    }

    tryConsume(key: string, nowMs: number, cost = 1): boolean {
        let bucket = this.buckets.get(key);
        if (bucket === undefined) {
            bucket = new TokenBucket(this.ratePerSec, this.burst, nowMs);
            this.buckets.set(key, bucket);
        }
        return bucket.tryConsume(nowMs, cost);
    }

    sweep(nowMs: number): void {
        for (const [key, bucket] of this.buckets) {
            // A bucket back at capacity carries no state worth keeping.
            if (bucket.tryConsume(nowMs, 0) && bucket.available >= this.burst) {
                this.buckets.delete(key);
            }
        }
    }

    get size(): number {
        return this.buckets.size;
    }
}
