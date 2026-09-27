import { describe, it, expect } from "vitest";
import { Bucket, bucketFor, sweepBuckets } from "../server/limits.js";

const COOLDOWN = 5_000;

describe("Bucket", () => {
    it("allows a burst up to capacity, then refuses", () => {
        const b = new Bucket(3, 0);
        expect(b.take(COOLDOWN, 0)).toBe(true);
        expect(b.take(COOLDOWN, 0)).toBe(true);
        expect(b.take(COOLDOWN, 0)).toBe(true);
        expect(b.take(COOLDOWN, 0)).toBe(false);      // bucket empty
    });

    it("refills over time", () => {
        const b = new Bucket(3, 0);
        b.take(COOLDOWN, 0); b.take(COOLDOWN, 0); b.take(COOLDOWN, 0);
        expect(b.take(COOLDOWN, 4_000)).toBe(false);  // not a full cooldown yet
        expect(b.take(COOLDOWN, 5_000)).toBe(true);
    });

    // Forget to clamp idle time and a client that sat for ten minutes can paint 120
    // pixels at once. Invisible in normal testing - nobody idles ten minutes while developing.
    it("never exceeds capacity", () => {
        const b = new Bucket(3, 0);
        b.take(COOLDOWN, 0);
        b.take(COOLDOWN, 600_000);                    // ten minutes later
        expect(b.take(COOLDOWN, 600_000)).toBe(true);
        expect(b.take(COOLDOWN, 600_000)).toBe(true);
        expect(b.take(COOLDOWN, 600_000)).toBe(false); // still only 3, not 120
    });

    it("reports a sensible wait", () => {
        const b = new Bucket(1, 0);
        expect(b.msUntilNext(COOLDOWN, 0)).toBe(0);
        b.take(COOLDOWN, 0);
        expect(b.msUntilNext(COOLDOWN, 0)).toBe(5_000);
        expect(b.msUntilNext(COOLDOWN, 2_500)).toBe(2_500);
    });

    // The reason the bucket stores a time: one bucket spans canvases with different cooldowns.
    it("does not let a fast canvas speed up a slow one", () => {
        const b = new Bucket(3, 0);
        const FAST = 1_000, SLOW = 300_000;
        for (let t = 0; t < 60_000; t += FAST) b.take(FAST, t);  // a minute on the fast canvas

        // The slow canvas still allows its burst, then nothing for a full slow cooldown...
        let placed = 0;
        while (b.take(SLOW, 60_000)) placed++;
        expect(placed).toBeLessThanOrEqual(3);
        expect(b.take(SLOW, 60_000 + SLOW - 1)).toBe(false);
        // ...and the fast canvas is paying for it too.
        expect(b.take(FAST, 60_000 + FAST)).toBe(false);
    });
});

describe("bucketFor", () => {
    it("gives the same identity the same bucket", () => {
        expect(bucketFor("1.2.3.4")).toBe(bucketFor("1.2.3.4"));
        expect(bucketFor("1.2.3.4")).not.toBe(bucketFor("5.6.7.8"));
    });

    it("sweeps only full buckets", () => {
        const now = performance.now();
        bucketFor("idle");
        const busy = bucketFor("busy");
        busy.take(COOLDOWN, now);
        sweepBuckets(now);
        expect(bucketFor("busy")).toBe(busy);          // still owes time, kept
    });
});
