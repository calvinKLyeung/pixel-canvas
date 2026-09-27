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

function showNotice(text: string) {
    noticeElem.textContent = text;
}

/** Messages for the close codes the server uses to turn people away. */
const CLOSE_REASONS: Record<number, string> = {
    4001: "Log in to enter this room.",
    4003: "This room is private. Open it from the lobby and enter its code.",
    4004: "This room doesn't exist, or its owner deleted it.",
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

function connect() {
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
        statusElem.textContent = CLOSE_REASONS[e.code] ?? "disconnected";
        if (e.code === 4001) openLogin(() => { location.href = "/"; });
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

/** Send a brush-sized square centred on (cx, cy). */
function stamp(cx: number, cy: number) {
    if (!board || sock?.readyState !== WebSocket.OPEN) return;
    const colour = currentColour();
    const r = Math.floor(Number(brushElem.value) / 2);
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= boardW || y < 0 || y >= boardH) continue;
            // Already that colour: a big brush dragged along overlaps itself constantly,
            // and resending those would multiply the traffic for no change.
            if (board[index(x, y, boardW)] === colour) continue;
            sock.send(encodePlace({ x, y, colour }));
        }
    }
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
    stamp(pos[0], pos[1]);
})

canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const pos = toBoard(e);
    if (!pos) return;
    const [x, y] = pos;
    if (x === lastX && y === lastY) return; // move to same pixel = nothing to do

    // fill the gap, since the last event to what just happened
    line(lastX, lastY, x, y, (px, py) => {
        if (px === lastX && py === lastY) return; // same as starting point = nothing to paint
        stamp(px, py);
    });
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
