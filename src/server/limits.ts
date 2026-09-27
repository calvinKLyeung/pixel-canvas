/**
 * Token bucket rate limiter, stored as a time instead of a token count.
 *
 * `readyAt` is when the bucket would be full again. Each paint pushes it forward by the
 * canvas's cooldown, and a paint is allowed while it is no more than (capacity - 1)
 * cooldowns ahead of now. For a single cooldown that is exactly a token bucket: a burst
 * of `capacity`, then one per cooldown.
 *
 * Why time and not tokens: one bucket is shared by every canvas you paint on, and canvases
 * have different cooldowns. With a token count the refill rate has to be one number, so
 * either a fast canvas refills tokens you then spend on a slow one, or a slow canvas you
 * joined first slows you down everywhere. Charging each paint its own canvas's cooldown in
 * time has neither problem - a 300s canvas costs 300s of budget no matter where the
 * budget came from.
 *
 * Nothing is refilled by a timer. Computing from `now` on demand means no background work
 * per client, which matters at 1,000 of them.
 */
export class Bucket {
    private readyAt: number;

    constructor(
        private readonly capacity = 3,
        now = performance.now(),
    ) {
        this.readyAt = now;
    }

    /** How far ahead of now readyAt may be before a paint costing `costMs` is refused. */
    private slack(costMs: number): number {
        return (this.capacity - 1) * costMs;
    }

    /** Spend one paint that costs `costMs`, if the budget allows it. */
    take(costMs: number, now = performance.now()): boolean {
        // Idle time is not banked beyond a full bucket: an old readyAt counts as now.
        const start = Math.max(this.readyAt, now);
        if (start - now > this.slack(costMs)) return false;
        this.readyAt = start + costMs;
        return true;
    }

    /** Milliseconds until a paint costing `costMs` would be allowed. 0 if it would be now. */
    msUntilNext(costMs: number, now = performance.now()): number {
        return Math.max(0, Math.ceil(this.readyAt - now - this.slack(costMs)));
    }

    /** A full bucket behaves exactly like a brand-new one, so forgetting it loses nothing. */
    isFull(now = performance.now()): boolean {
        return this.readyAt <= now;
    }
}

/**
 * One bucket per identity - user id when logged in, IP when not - shared by every canvas.
 * Per connection, refreshing the page reset the cooldown. Per canvas, creating canvases
 * (which is free) would multiply your paint rate.
 */
const buckets = new Map<string | number, Bucket>();

export function bucketFor(identity: string | number): Bucket {
    let bucket = buckets.get(identity);
    if (!bucket) {
        bucket = new Bucket();
        buckets.set(identity, bucket);
    }
    return bucket;
}

/**
 * Drop buckets that have refilled completely. Without this every IP that ever connected
 * stays in the map forever.
 *
 * Safe only because clients hold their identity, not a Bucket: every paint looks the
 * bucket up again. A client holding the object would keep painting from a bucket this
 * dropped while its next tab got a new one - two buckets for one person, double the rate.
 */
export function sweepBuckets(now = performance.now()): number {
    let dropped = 0;
    for (const [identity, bucket] of buckets) {
        if (bucket.isFull(now)) {
            buckets.delete(identity);
            dropped += 1;
        }
    }
    return dropped;
}
