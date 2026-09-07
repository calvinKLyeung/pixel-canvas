import { W, H, index} from "../shared/constants.js";
import { cssColour, PALETTE } from "../shared/palette.js";
import { initRenderer, render } from "./render.js";


const statusElem = document.getElementById("status")!;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

// https : wss   http : ws
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const sock = new WebSocket(`${protocol}//${location.host}/ws`);

// board
const board: Uint8Array  = new Uint8Array(W * H);
initRenderer(canvas);
render(board); // paint white board with rendered RGBA

function sendPlace(x: number, y: number, c: number) {
    sock.send(JSON.stringify({ t: "place", x, y, c }));
}

sock.addEventListener("open", (msg) => {
    statusElem.textContent = "connected";
});

sock.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === "snapshot") {
        board.set(msg.board);
    } else if (msg.t === "place") {
        board[index(msg.x, msg.y)] = msg.c;
    }
    render(board);
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

canvas.addEventListener("click", (e) => {
    const rectangle = canvas.getBoundingClientRect();

    // only matters when the click landed within target boundaries
    // display size 768 scale to board size 256
    const x = Math.floor((e.clientX - rectangle.left) / rectangle.width * W);
    const y = Math.floor((e.clientY - rectangle.top) / rectangle.height * H);

    // opt out if out of bound
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    // send t:"place" msg back to server
    sendPlace(x, y, selectedColour);
})
