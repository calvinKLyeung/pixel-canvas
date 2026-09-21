import WebSocket from "ws";
import { PALETTE_SIZE } from "./shared/palette.js";
import { encodePlace, MSG } from "./shared/protocols.js";

/** get shell input, otherwise fall back to default val*/
const URL = process.env.URL ?? "ws://localhost:8000/ws";
const BOTS = Number(process.env.BOTS ?? 20);
/**
 * Canvas ids to spread the bots over, round robin. The two shapes worth measuring are
 * every bot on one board and the same bots split across many: same placements per second,
 * but the second spreads them over more dirty maps and more broadcast sets per tick.
 */
const CANVASES = (process.env.CANVASES ?? "main").split(",");

let sent = 0;

async function bot(id: number) {
    // open sockets at once to measure connection handler
    await new Promise(r => setTimeout(r, id * 50));  // wait my turn
    const canvasId = CANVASES[id % CANVASES.length] ?? "main";
    const ws = new WebSocket(`${URL}?c=${encodeURIComponent(canvasId)}`);  // dial the server
    await new Promise(r => ws.once("open", r));  // wait for server to pick up

    // Take the dimensions from the board we actually joined. Assuming the defaults means
    // most places on a smaller canvas land out of bounds, where the server drops them
    // without a trace - the bots look busy and the board barely changes.
    const [w, h] = await new Promise<[number, number]>(resolve => {
        const onMessage = (data: Buffer) => {
            if (data[0] !== MSG.SNAPSHOT) return;
            ws.off("message", onMessage);
            resolve([data.readUInt16LE(1), data.readUInt16LE(3)]);
        };
        ws.on("message", onMessage);
    });

    setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(encodePlace({
            x: Math.floor(Math.random() * w),
            y: Math.floor(Math.random() * h),
            colour: Math.floor(Math.random() * PALETTE_SIZE),
        }));
        sent += 1;
    }, 500 + Math.random() * 1500);
}

setInterval(() => {
    console.log(`sent ${sent}/sec`);
    sent = 0;
}, 1000);

// start with bot(i) is called
await Promise.all(Array.from({ length: BOTS }, (_, i) => bot(i)));

console.log(`${BOTS} bots are connected across ${CANVASES.length}: ${CANVASES.join(", ")}`);