import { index} from "../shared/constants.js";
import { line } from "../shared/line.js";
import { cssColour, PALETTE, EMPTY } from "../shared/palette.js";
import { initRenderer, render } from "./render.js";
import { initOverlay, drawOverlay } from "./overlay.js";

import {encodePlace, decodeDelta, decodeRejected, MSG, viewOf} from "../shared/protocols.js";
import { inflate } from "./decode.js";
import { canPaint, startCooldown } from "./cooldown.js";
import {
    draft, bindCanvas, addDraft, removeDraft, clearDraft, save, sweepOldDrafts, toXY, MAX_DRAFT,
} from "./draft.js";
import { me, mountAuth } from "./auth.js";



const statusElem = document.getElementById("status")!;
const noticeElem = document.getElementById("notice")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlayElem = document.getElementById("overlay") as HTMLCanvasElement;

// Filled into the page by pageFor() on the server. Only used for display - the server
// enforces the real cooldown and the real ownership check.
const page = document.body.dataset;
const cooldownMs = Number(page.cooldownMs) || 0;
const ownerId = Number(page.ownerId) || null;
const canvasName = page.name ?? "";

// https : wss   http : ws
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
// sends the upgrade request, causes the 101
// The id is in the path now (/c/<id>). ?c= is still read so an old link that somehow
// skipped the redirect still lands on the right board rather than silently on main.
const pathId = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
const canvasId = pathId
    ? decodeURIComponent(pathId)
    : new URLSearchParams(location.search).get("c") ?? "main";
const sock = new WebSocket(`${protocol}//${location.host}/ws?c=${encodeURIComponent(canvasId)}`);

// The download links are static HTML, so point them at the canvas we are actually on
for (const id of ["download", "download-grid"]) {
    const link = document.getElementById(id) as HTMLAnchorElement;
    link.href += `&c=${encodeURIComponent(canvasId)}`;
}
// !!! ensure sock uses array buffer instead of default Blob that require async !!!
sock.binaryType = "arraybuffer";

mountAuth(document.getElementById("auth")!);
sweepOldDrafts();


// board - size is unknown until the SNAPSHOT header arrives, so nothing to draw yet
let board: Uint8Array | null = null;
let boardW = 0, boardH = 0;

function showNotice(text: string) {
    noticeElem.textContent = text;
}

/**========== callbacks reacting to lifecycle events ==========*/

sock.addEventListener("open", (msg) => {
    // the canvas stays blank until the snapshot lands - say so, it isn't broken
    statusElem.textContent = "connected - loading canvas";
});


sock.addEventListener("message", async (e) => {
    const data = e.data as ArrayBuffer;
    // Binary -> use the new protocol
    const view = viewOf(e.data as ArrayBuffer);

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
                // The draft is stored as board indices, so it needs the width first.
                bindCanvas(canvasId, w, refreshDraft);
                refreshDraft();
            }
            board.set(pixels);
            render(board);
            statusElem.textContent = "connected";
            break;
        }
        // server -> client, Place pixels
        case MSG.DELTA: {
            if (!board) return;     // deltas before the snapshot have nowhere to land
            let landed = false;
            for (const pixel of decodeDelta(view)) {
                const idx = index(pixel.x, pixel.y, boardW);
                board[idx] = pixel.colour;
                // A draft pixel only leaves the draft once the server confirms it here -
                // see tryCommit.
                if (draft.get(idx) === pixel.colour) {
                    draft.delete(idx);
                    landed = true;
                }
            }
            render(board);  // only do once per message, not pixel, render after pixels are settled
            if (landed) afterDraftChange();
            break;
        }
        // server -> client, we painted faster than the cooldown allows
        case MSG.REJECTED: {
            startCooldown(decodeRejected(view));
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


sock.addEventListener("close", (e) => {
    statusElem.textContent = "disconnected";
});

sock.addEventListener("error", (e) => {
    console.error("Websocket error", e);
    statusElem.textContent = "error = check the console";
})


/**========== tools: colour, eraser, brush, draft mode ==========*/

let selectedColour = 5;
const paletteElem = document.getElementById("palette")!;
const eraserElem = document.getElementById("eraser") as HTMLInputElement;

PALETTE.forEach((_, i) => {
    const button = document.createElement("button");

    button.style.cssText =
        `background:${cssColour(i)};width:32px;height:32px;` +
        `border:2px solid ${i === selectedColour ? "#000" : "transparent"};` +
        `padding:0;margin:2px;display:inline-block`;

    button.addEventListener("click", (e) => {
        selectedColour = i;
        eraserElem.checked = false;     // picking a colour means you want to paint
        // redraw boarder to highlight selection
        [...paletteElem.children].forEach((elem, j) => {
            (elem as HTMLElement).style.borderColor = j === i ? "#000" : "transparent";
        });
    });

    paletteElem.appendChild(button);
});

/** The eraser is just a colour: EMPTY, charged a cooldown like any other paint. */
const currentColour = () => (eraserElem.checked ? EMPTY : selectedColour);

/**
 * Brush sizes live only in the browser. A stamp becomes N² separate draft pixels, and
 * each one is sent, checked and charged on its own. There is no "big brush" message,
 * so a modified client has nothing to abuse.
 */
const BRUSH_SIZES = [1, 3, 5, 9] as const;
const brushElem = document.getElementById("brush") as HTMLSelectElement;
for (const n of BRUSH_SIZES) {
    // The cost is on the label: a 5x5 stamp is 25 cooldowns, and 8 of them fill a draft.
    brushElem.add(new Option(`${n}×${n} · ${n * n}px`, String(n)));
}

/**
 * Live mode sends each click straight to the server, one pixel. Draft mode queues
 * pixels locally - including by dragging, with brushes - and tryCommit drains them.
 * Drag is draft-only: with a cooldown, a one-second live drag is ~100 placements and
 * nearly all of them come back REJECTED.
 */
let drafting = false;
const draftModeElem = document.getElementById("draftmode") as HTMLInputElement;
draftModeElem.addEventListener("change", () => {
    drafting = draftModeElem.checked;
    brushElem.disabled = !drafting;    // live mode is one pixel per click
});
brushElem.disabled = true;


/**========== painting ==========*/

/** Live mode: one pixel straight to the server. */
function sendPlace(x: number, y: number) {
    // make sure socket still in OPEN state
    if (sock.readyState !== WebSocket.OPEN) return;
    sock.send(encodePlace({ x, y, colour: currentColour() }));
}

/** Draft mode: queue a brush-sized square centred on (cx, cy). */
function stamp(cx: number, cy: number) {
    const size = Number(brushElem.value);
    const r = Math.floor(size / 2);
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= boardW || y < 0 || y >= boardH) continue;
            if (!addDraft(x, y, currentColour())) {
                showNotice(`Draft is full (${MAX_DRAFT} pixels).`);
                return;
            }
        }
    }
}

function refreshDraft() {
    drawOverlay();
    updateDraftCount();
}

function afterDraftChange() {
    save();
    refreshDraft();
}

let drawing = false;
let lastX = -1, lastY = -1;

function toBoard(e: MouseEvent): [number, number] | null {
    if (!board) return null;    // no snapshot yet, nothing to paint on
    const rectangle = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rectangle.left) / rectangle.width * boardW);
    const y = Math.floor((e.clientY - rectangle.top) / rectangle.height * boardH);
    return (x < 0 || x >= boardW || y < 0 || y >= boardH) ? null : [x, y];
}

canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;  // right button is "remove from draft", see contextmenu
    const pos = toBoard(e);
    if (!pos) return;
    e.preventDefault(); // cancel browser built-in reaction to the event
    canvas.setPointerCapture(e.pointerId); // keep the events if we leave the canvas
    drawing = true;
    [lastX, lastY] = pos;
    if (drafting) {
        stamp(pos[0], pos[1]);
        afterDraftChange();
    } else {
        sendPlace(pos[0], pos[1]);
    }
})

canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    if (!drafting) return;      // live mode is click-only
    const pos = toBoard(e);
    if (!pos) return;
    const [x, y] = pos;
    if (x === lastX && y === lastY) return; // move to same pixel = nothing to do

    // fill the gap, since the last event to what just happened
    line(lastX, lastY, x, y, (px, py) => {
        if (px === lastX && py === lastY) return; // same as starting point = nothing to paint
        stamp(px, py);
    });
    afterDraftChange();
    [lastX, lastY] = [x, y];
})

function endStroke(e: PointerEvent) {
    if (!drawing) return;
    drawing = false;
    canvas.releasePointerCapture(e.pointerId);
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke)

/**
 * Right-click cancels a pending pixel, for free. Not the same as the eraser, which queues
 * an erase that costs a cooldown - mix the two up and fixing a mistake costs a token.
 */
canvas.addEventListener("contextmenu", (e) => {
    if (!drafting) return;
    e.preventDefault();                     // no browser menu over the board
    const pos = toBoard(e);
    if (!pos) return;
    removeDraft(pos[0], pos[1]);
    afterDraftChange();
});


/**========== draining the draft ==========*/

/**
 * Send the next draft pixel whenever the cooldown allows.
 *
 * The pixel is NOT removed when sent - only when a DELTA confirms it landed. If it is
 * rejected, or the connection blips, it is still queued and simply goes again on a later
 * tick. Deleting it here would make a refused pixel silently vanish from the drawing.
 */
function tryCommit() {
    if (!board || !canPaint() || sock.readyState !== WebSocket.OPEN) return;

    let skipped = false;
    for (const [idx, colour] of draft) {
        // Already that colour - sending it would spend a cooldown changing nothing.
        // Common with the eraser dragged over blank board.
        if (board[idx] === colour) {
            draft.delete(idx);
            skipped = true;
            continue;
        }
        const [x, y] = toXY(idx);
        sock.send(encodePlace({ x, y, colour }));
        break;
    }
    if (skipped) afterDraftChange();
}

setInterval(tryCommit, 250);

/** "38 queued" means nothing; "~3 min" says whether to wait or clear it. */
function updateDraftCount() {
    const n = draft.size;
    const seconds = Math.ceil((n * cooldownMs) / 1000);
    const eta = seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
    document.getElementById("draftcount")!.textContent = n === 0 ? "" : `${n} queued · ~${eta}`;
}

document.getElementById("cleardraft")!.addEventListener("click", () => {
    if (draft.size === 0) return;
    // Losing a 200-pixel sketch to a stray click is miserable.
    if (!confirm(`Discard ${draft.size} pending pixels?`)) return;
    clearDraft();
    refreshDraft();
});


/**========== owner: clear the whole canvas ==========*/

const clearAllElem = document.getElementById("clearall") as HTMLButtonElement;

// Shown only to whoever may use it. The server checks again - hiding a button is not security.
me.then(user => {
    if (user && (user.id === ownerId || user.isAdmin)) clearAllElem.hidden = false;
});

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
