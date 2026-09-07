import { W, H, index} from "../shared/constants.js";
import { line } from "../shared/line.js";
import { cssColour, PALETTE } from "../shared/palette.js";
import { initRenderer, render } from "./render.js";
import { initOverlay } from "./overlay.js";

import { MSG, viewOf } from "../shared/protocols.js";
import { inflate } from "./decode.js";



const statusElem = document.getElementById("status")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

// https : wss   http : ws
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const sock = new WebSocket(`${protocol}//${location.host}/ws`);
// !!! ensure sock uses array buffer instead of default Blob that require async !!!
sock.binaryType = "arraybuffer";


// board
const board: Uint8Array  = new Uint8Array(W * H);
initRenderer(canvas);
initOverlay(document.getElementById("overlay") as HTMLCanvasElement)
render(board); // paint white board with rendered RGBA

function sendPlace(x: number, y: number, c: number) {
    sock.send(JSON.stringify({ t: "place", x, y, c }));
}

sock.addEventListener("open", (msg) => {
    statusElem.textContent = "connected";
});


sock.addEventListener("message", async (e) => {
    // String -> old JSON path
    if (typeof e.data === "string") {
        const msg = JSON.parse(e.data);
        if (msg.t === "delta") {
            for (const pixel of msg.changes) {
                board[index(pixel.x, pixel.y)] = pixel.c;
            }
            render(board);
        }
        return;
    }

    // Binary -> use the new protocol
    const view = viewOf(e.data as ArrayBuffer);

    // get type of MSG
    switch (view.getUint8(0)) {
        case MSG.SNAPSHOT: {
            const w = view.getUint16(1, true);  // true = little endian
            const h = view.getUint16(3, true);  // true = little endian
            const body = (e.data as ArrayBuffer).slice(5); // index 5 onward, copy data
            const pixels = await inflate(body); // unpack Promise

            // is Snapshot but length mismatch
            if (pixels.length !== w * h) {
                // something went wrong
                console.error(`bad snapshot: got ${pixels.length}, when expecting ${w * h}`);
                return;
            }
            // valid case
            board.set(pixels);
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
    const rectangle = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rectangle.left) / rectangle.width * W);
    const y = Math.floor((e.clientY - rectangle.top) / rectangle.height * H);
    return (x < 0 || x >= W || y < 0 || y >= H) ? null : [x, y];
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
