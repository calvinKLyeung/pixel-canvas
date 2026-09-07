/** map which pixels changed since the last flush, key = board index, val = colour
 * Buffer collecting all pending outbound updates from clicks */
export const dirty = new Map<number, number>();

/** Last write wins */
export function markDirty(idx: number, colour: number) {
    dirty.set(idx, colour);
}

/** frequency of sending out batch of updates back to client */
export const TICK_HZ = 20;

export function startTicker(flush: () => void) {
    const interval = 1000 / TICK_HZ;
    let next = performance.now();  // monotonic clock, returns ms float since fixed point, keep track of how long has it been?

    const loop = () => {
        next += interval;
        flush();

        let delay = next - performance.now();
        if (delay < 0) {
            // somehow took longer than one tick
            // reset target to now and move on
            next = performance.now();
            delay = 0;
        }
        setTimeout(loop, delay);  // alarm clock, yield (voluntarily give up thread), run loop again in ~50ms.
    };

    loop(); // recurse
}