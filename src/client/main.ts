import { index} from "../shared/constants.js";
import { line } from "../shared/line.js";
import { cssColour, PALETTE, EMPTY } from "../shared/palette.js";
import { initRenderer, render } from "./render.js";
import { initOverlay } from "./overlay.js";

import {encodePlace, decodeDelta, MSG, viewOf} from "../shared/protocols.js";
import { inflate } from "./decode.js";
import { me, renderAccount, openLogin } from "./auth.js";



const statusElem = document.getElementById("status")!;
const noticeElem = document.getElementById("notice")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlayElem = document.getElementById("overlay") as HTMLCanvasElement;

// Filled into the page by pageFor() on the server. Only decides what the page shows -
// the server does the real ownership check.
const page = document.body.dataset;
const ownerId = Number(page.ownerId) || null;
const canvasName = page.name ?? "";

/** The one room anyone may use without an account. Same id as the server's MAIN_ID. */
const MAIN_ID = "main";

// https : wss   http : ws
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
// The id is in the path now (/c/<id>). ?c= is still read so an old link that somehow
// skipped the redirect still lands on the right board rather than silently on main.
const pathId = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
const canvasId = pathId
    ? decodeURIComponent(pathId)
    : new URLSearchParams(location.search).get("c") ?? MAIN_ID;

// The download links are static HTML, so point them at the canvas we are actually on
for (const id of ["download", "download-grid"]) {
    const link = document.getElementById(id) as HTMLAnchorElement;
    link.href += `&c=${encodeURIComponent(canvasId)}`;
}

const user = await me;
renderAccount(document.getElementById("auth")!);

// The lobby is for accounts only: logged out, the link opens the login popup instead.
document.getElementById("lobbylink")!.addEventListener("click", (e) => {
    if (user) return;               // a normal link to the lobby
    e.preventDefault();
    openLogin();
});


// board - size is unknown until the SNAPSHOT header arrives, so nothing to draw yet
let board: Uint8Array | null = null;
let boardW = 0, boardH = 0;
let sock: WebSocket | null = null;

/**
 * Reconnecting needs no re-sync step of its own: the server opens every connection with a
 * SNAPSHOT, which replaces whatever deltas we missed while we were gone.
 * Declared up here because connect() first runs further down this module's top level.
 */
const RETRY_MIN_MS = 1_000, RETRY_MAX_MS = 30_000;
let retryMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** The server closed us with one of its own codes. Retrying would only be refused again. */
let refused = false;

function showNotice(text: string) {
    noticeElem.textContent = text;
}

/** Messages for the close codes the server uses to turn people away. */
const CLOSE_REASONS: Record<number, string> = {
    4001: "Log in to enter this room.",
    4003: "This room is private. Open it from the lobby and enter its code.",
    4004: "This room doesn't exist, or its owner deleted it.",
    4029: "Disconnected for sending too fast. Reload to carry on.",
};

// Everything but main needs an account. Ask for one before connecting at all - the
// server would only refuse the connection anyway.
if (canvasId !== MAIN_ID && !user) {
    statusElem.textContent = CLOSE_REASONS[4001]!;
    openLogin(() => { location.href = "/"; });
} else {
    connect();
}

/**========== the connection ==========*/

function scheduleReconnect() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

// A backgrounded phone tab is suspended and its socket dies without a word. Coming back to
// it, check straight away rather than leaving the person on a frozen board until the timer.
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || refused || !sock) return;
    if (sock.readyState === WebSocket.CLOSED || sock.readyState === WebSocket.CLOSING) connect();
});

function connect() {
    clearTimeout(retryTimer);
    // sends the upgrade request, causes the 101
    const ws = new WebSocket(`${protocol}//${location.host}/ws?c=${encodeURIComponent(canvasId)}`);
    sock = ws;
    // !!! ensure sock uses array buffer instead of default Blob that require async !!!
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
        // the canvas stays blank until the snapshot lands - say so, it isn't broken
        statusElem.textContent = "connected - loading canvas";
    });

    ws.addEventListener("message", async (e) => {
        const data = e.data as ArrayBuffer;
        // Binary -> use the new protocol
        const view = viewOf(data);

        // get type tag of MSG
        switch (view.getUint8(0)) {
            // server -> client, initial join
            case MSG.SNAPSHOT: {
                const w = view.getUint16(1, true);  // true = little endian
                const h = view.getUint16(3, true);  // true = little endian
                const body = data.slice(5); // index 5 onward, copy data
                const pixels = await inflate(body); // unpack Promise

                // is Snapshot but length mismatch
                if (pixels.length !== w * h) {
                    // something went wrong
                    console.error(`bad snapshot: got ${pixels.length}, when expecting ${w * h}`);
                    return;
                }
                // valid case - (re)size everything to whatever board the server sent
                if (!board || boardW !== w || boardH !== h) {
                    boardW = w;
                    boardH = h;
                    // EMPTY, not 0 - 0 is paintable white. The snapshot overwrites this
                    // immediately, but the board must never be briefly all-white.
                    board = new Uint8Array(w * h).fill(EMPTY);
                    initRenderer(canvas, w, h);
                    initOverlay(overlayElem, w, h);
                }
                board.set(pixels);
                render(board);
                statusElem.textContent = "connected";
                retryMs = RETRY_MIN_MS;     // only once we are properly back, not on open
                break;
            }
            // server -> client, Place pixels
            case MSG.DELTA: {
                if (!board) return;     // deltas before the snapshot have nowhere to land
                for (const pixel of decodeDelta(view)) {
                    board[index(pixel.x, pixel.y, boardW)] = pixel.colour;
                }
                render(board);  // only do once per message, not pixel, render after pixels are settled
                break;
            }
            // server -> client, the owner wiped the canvas
            case MSG.CLEAR: {
                if (!board) return;
                board.fill(EMPTY);
                render(board);
                break;
            }
            // some unknown data
            default:
                console.warn("unknown message type", view.getUint8(0));
        }
    });

    ws.addEventListener("close", (e) => {
        if (ws !== sock) return;    // an old socket closing after a newer one replaced it
        statusElem.textContent = CLOSE_REASONS[e.code] ?? "disconnected - reconnecting";
        if (e.code === 4001) openLogin(() => { location.href = "/"; });
        // 4000-4999 are the server turning us away on purpose; trying again gets the same answer.
        if (e.code >= 4000 && e.code < 5000) refused = true;
        else scheduleReconnect();
    });

    ws.addEventListener("error", (e) => {
        console.error("Websocket error", e);
        statusElem.textContent = "error = check the console";
    })
}


/**========== tools: colour, eraser, brush ==========*/

let selectedColour = 5;
const paletteElem = document.getElementById("palette")!;
const eraserElem = document.getElementById("eraser") as HTMLInputElement;

PALETTE.forEach((_, i) => {
    const button = document.createElement("button");

    button.style.cssText =
        `background:${cssColour(i)};width:32px;height:32px;` +
        `border:2px solid ${i === selectedColour ? "#000" : "transparent"};` +
        `padding:0;margin:2px;display:inline-block`;

    button.addEventListener("click", () => {
        selectedColour = i;
        eraserElem.checked = false;     // picking a colour means you want to paint
        // redraw boarder to highlight selection
        [...paletteElem.children].forEach((elem, j) => {
            (elem as HTMLElement).style.borderColor = j === i ? "#000" : "transparent";
        });
    });

    paletteElem.appendChild(button);
});

/** The eraser is just a colour: EMPTY, which the server accepts by name. */
const currentColour = () => (eraserElem.checked ? EMPTY : selectedColour);

/**
 * Brush sizes live only in the browser: a stamp is sent as N² ordinary pixels. There is
 * no "big brush" message, so the server has nothing new to validate.
 */
const BRUSH_SIZES = [1, 3, 5, 9] as const;
const brushElem = document.getElementById("brush") as HTMLSelectElement;
for (const n of BRUSH_SIZES) {
    brushElem.add(new Option(`${n}×${n}`, String(n)));
}


/**========== painting ==========*/

/**
 * Send a brush-sized square centred on (cx, cy), and paint it into `board` at once rather
 * than waiting for the server's delta - that round trip is at least a tick plus the
 * network, and the stroke visibly trails the cursor by it. The delta still overwrites
 * whatever we guessed, so if someone else won a pixel this tick, theirs shows a moment later.
 *
 * Returns whether anything changed, so the caller can render once per pointer event
 * instead of once per stamp.
 */
function stamp(cx: number, cy: number): boolean {
    if (!board || sock?.readyState !== WebSocket.OPEN) return false;
    const colour = currentColour();
    const r = Math.floor(Number(brushElem.value) / 2);
    let changed = false;
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= boardW || y < 0 || y >= boardH) continue;
            // Already that colour: a big brush dragged along overlaps itself constantly,
            // and resending those would multiply the traffic for no change. Because we
            // write to `board` below, this also skips pixels sent but not yet confirmed.
            const idx = index(x, y, boardW);
            if (board[idx] === colour) continue;
            board[idx] = colour;
            changed = true;
            sock.send(encodePlace({ x, y, colour }));
        }
    }
    return changed;
}

let drawing = false;
let lastX = -1, lastY = -1;

function toBoard(e: PointerEvent): [number, number] | null {
    if (!board) return null;    // no snapshot yet, nothing to paint on
    const rectangle = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rectangle.left) / rectangle.width * boardW);
    const y = Math.floor((e.clientY - rectangle.top) / rectangle.height * boardH);
    return (x < 0 || x >= boardW || y < 0 || y >= boardH) ? null : [x, y];
}

canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;  // left button / touch / pen only
    const pos = toBoard(e);
    if (!pos) return;
    e.preventDefault(); // cancel browser built-in reaction to the event
    canvas.setPointerCapture(e.pointerId); // keep the events if we leave the canvas
    drawing = true;
    [lastX, lastY] = pos;
    if (stamp(pos[0], pos[1])) render(board!);
})

canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const pos = toBoard(e);
    if (!pos) return;
    const [x, y] = pos;
    if (x === lastX && y === lastY) return; // move to same pixel = nothing to do

    // fill the gap, since the last event to what just happened
    let changed = false;
    line(lastX, lastY, x, y, (px, py) => {
        if (px === lastX && py === lastY) return; // same as starting point = nothing to paint
        if (stamp(px, py)) changed = true;
    });
    if (changed) render(board!);
    [lastX, lastY] = [x, y];
})

function endStroke(e: PointerEvent) {
    if (!drawing) return;
    drawing = false;
    canvas.releasePointerCapture(e.pointerId);
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke)


/**========== dev readout: add ?metrics to the URL ==========*/

if (new URLSearchParams(location.search).has("metrics")) {
    const metricsElem = document.getElementById("metrics")!;
    metricsElem.hidden = false;
    setInterval(async () => {
        const m = await (await fetch("/metrics")).json();
        // Behind the proxy each request can land on either process, hence the port.
        metricsElem.textContent =
            `:${m.port} · ${m.connections} conns · busy ${(m.busy * 100).toFixed(0)}% · ` +
            `loop p99 ${m.loopDelayP99Ms.toFixed(1)}ms · tick p99 ${m.tickMsP99.toFixed(2)}ms · ` +
            `fanout p99 ${m.fanoutMsP99.toFixed(2)}ms · ${(m.bytesOut / 1024).toFixed(1)} KB/s out`;
    }, 1000);
}


/**========== owner: days left before the inactivity purge ==========*/

// Only the owner is told: the countdown is about their login, and only they can reset it.
if (user?.deleteAt && user.id === ownerId) {
    const DAY_MS = 864e5;
    const daysLeft = Math.max(0, Math.ceil((user.deleteAt - Date.now()) / DAY_MS));
    const daysElem = document.getElementById("expiry-days")!;
    daysElem.textContent = daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;
    // The last week is when it needs noticing; before that it is just information.
    if (daysLeft <= 7) daysElem.style.color = "var(--pico-del-color)";
    document.getElementById("expiry-renew")!.addEventListener("click", () => {
        openLogin(() => {}, location.pathname + location.search);
    });
    document.getElementById("expiry")!.hidden = false;
}


/**========== owner: clear the whole canvas ==========*/

const clearAllElem = document.getElementById("clearall") as HTMLButtonElement;

// Shown only to whoever may use it. The server checks again - hiding a button is not security.
if (user && (user.id === ownerId || user.isAdmin)) clearAllElem.hidden = false;

clearAllElem.addEventListener("click", async () => {
    const typed = prompt(
        `This erases the canvas for everyone and cannot be undone.\n` +
        `Type the canvas name to confirm: ${canvasName}`);
    if (typed === null) return;

    const reply = await fetch(`/api/c/${encodeURIComponent(canvasId)}/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: typed }),
    });
    showNotice(reply.ok ? "Canvas cleared." : (await reply.json()).error ?? "Could not clear.");
});
