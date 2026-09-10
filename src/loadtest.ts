import WebSocket from "ws";
// bots only hit `main`, so its defaults are the real dimensions.
// milestone 06 spreads bots across canvases - read w/h from the SNAPSHOT header then.
import { DEFAULT_W, DEFAULT_H } from "./shared/constants.js";
import { PALETTE_SIZE } from "./shared/palette.js";
import { encodePlace } from "./shared/protocols.js";

/** get shell input, otherwise fall back to default val*/
const URL = process.env.URL ?? "ws://localhost:8000/ws";
const BOTS = Number(process.env.BOTS ?? 20);

let sent = 0;

async function bot(id: number) {
    // open sockets at once to measure connection handler
    await new Promise(r => setTimeout(r, id * 50));  // wait my turn
    const ws = new WebSocket(URL);  // dial the server
    await new Promise(r => ws.once("open", r));  // wait for server to pick up

    setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(encodePlace({
            x: Math.floor(Math.random() * DEFAULT_W),
            y: Math.floor(Math.random() * DEFAULT_H),
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

console.log(`${BOTS} bots are connected`);