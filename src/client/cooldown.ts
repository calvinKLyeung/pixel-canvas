/**
 * The cooldown bar. Driven only by the server's REJECTED wait - a client-side guess would
 * drift, and the user would see a full bar, click, and be refused anyway.
 */
const wrap = document.getElementById("cooldown")!;
const bar  = document.getElementById("cdbar") as HTMLProgressElement;
const text = document.getElementById("cdtext")!;

let readyAt = 0;          // when we may paint again
let total   = 0;          // how long this cooldown is, for the bar

export function canPaint(): boolean {
    return performance.now() >= readyAt;
}

/** Called when the server refuses a placement. */
export function startCooldown(waitMs: number) {
    readyAt = performance.now() + waitMs;
    total = waitMs;
    wrap.style.display = "";
}

// requestAnimationFrame, not setInterval: it syncs to the display, pauses in a background
// tab, and gives a smooth bar for free.
function tick() {
    const left = readyAt - performance.now();
    if (left <= 0) {
        wrap.style.display = "none";
    } else {
        bar.value = ((total - left) / total) * 100;
        text.textContent = `${(left / 1000).toFixed(1)}s`;
    }
    requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
