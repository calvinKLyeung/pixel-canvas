import { index} from "../shared/constants.js";
import { line } from "../shared/line.js";
import { cssColour, PALETTE, EMPTY } from "../shared/palette.js";
import { initRenderer, render } from "./render.js";
import { initOverlay } from "./overlay.js";

import {encodePlace, decodeDelta, MSG, viewOf} from "../shared/protocols.js";
import { inflate } from "./decode.js";



const statusElem = document.getElementById("status")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlayElem = document.getElementById("overlay") as HTMLCanvasElement;

// https : wss   http : ws
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
// sends the upgrade request, causes the 101
const canvasId = new URLSearchParams(location.search).get("c") ?? "main";
const sock = new WebSocket(`${protocol}//${location.host}/ws?c=${encodeURIComponent(canvasId)}`);

// The download links are static HTML, so point them at the canvas we are actually on
for (const id of ["download", "download-grid"]) {
    const link = document.getElementById(id) as HTMLAnchorElement;
    link.href += `&c=${encodeURIComponent(canvasId)}`;
}
// !!! ensure sock uses array buffer instead of default Blob that require async !!!
sock.binaryType = "arraybuffer";


// board - size is unknown until the SNAPSHOT header arrives, so nothing to draw yet
let board: Uint8Array | null = null;
let boardW = 0, boardH = 0;

/** Send out PLACE pixel */
function sendPlace(x: number, y: number, colour: number) {
    // make sure socket still in OPEN state
    if (sock.readyState !== WebSocket.OPEN) return;
    sock.send(encodePlace({ x, y, colour }));
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

let selectedColour = 5;
const paletteElem = document.getElementById("palette")!;
PALETTE.forEach((_, i) => {
    const button = document.createElement("button");

    button.style.cssText =
        `background:${cssColour(i)};width:32px;height:32px;` +
        `border:2px solid ${i === selectedColour ? "#000" : "transparent"};` +
        `padding:0;margin:2px;display:inline-block`;

    button.addEventListener("click", (e) => {
        selectedColour = i;
        // redraw boarder to highlight selection
        [...paletteElem.children].forEach((elem, j) => {
            (elem as HTMLElement).style.borderColor = j === i ? "#000" : "transparent";
        });
    });

    paletteElem.appendChild(button);
});


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
    const pos = toBoard(e);
    if (!pos) return;
    e.preventDefault(); // cancel browser built-in reaction to the event
    canvas.setPointerCapture(e.pointerId); // keep the events if we leave the canvas
    drawing = true;
    [lastX, lastY] = pos;
    sendPlace(pos[0], pos[1], selectedColour); // paint the pixel with selected Colour
})

// TODO milestone 05: a cooldown makes drag useless - a one-second stroke is ~100
// placements and almost all come back REJECTED. Live mode goes click-only there, and
// drag moves to the 05b draft layer where painting is free.
canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const pos = toBoard(e);
    if (!pos) return;
    const [x, y] = pos;
    if (x === lastX && y === lastY) return; // move to same pixel = nothing to do

    // fill the gap, since the last event to what just happened
    line(lastX, lastY, x, y, (px, py) => {
        if (px === lastX && py === lastY) return; // same as starting point = nothing to paint
        sendPlace(px, py, selectedColour)
    });  // paint the pixel with selected Colour
    [lastX, lastY] = [x, y];
})

function endStroke(e: PointerEvent) {
    if (!drawing) return;
    drawing = false;
    canvas.releasePointerCapture(e.pointerId);
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke)
