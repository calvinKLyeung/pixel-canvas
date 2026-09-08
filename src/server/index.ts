import Fastify from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import { join } from "node:path";

import { W, H, index} from "../shared/constants.js";
import { PALETTE_SIZE } from "../shared/palette.js";
import { board } from "./board.js";
import { dirty, markDirty, TICK_HZ, startTicker } from "./hub.js";
import { deflateSync } from "node:zlib";
import { renderPng } from "./export.js";
import { MSG, viewOf, decodePlace, encodeDelta, type Pixel } from "../shared/protocols.js";



const PORT = Number(process.env.PORT ?? 8000);

const app = Fastify({ logger: true });

/** Always First */
await app.register(fastifyStatic, {
    root: join(process.cwd(), "public"),
});
await app.register(websocket);

/** All currently connected browsers */
const clients = new Set<WebSocket>();

app.get("/ws", { websocket: true }, (sock: WebSocket) => {
    // add socket to clients
    clients.add(sock);
    // sock.send(JSON.stringify({ t: "snapshot", board: Array.from(board) }));
    sock.send(encodeSnapshot());
    app.log.info(`connected - now have ${clients.size} websockets in total`);


    // broadcast to all clients
    sock.on("message", (data: Buffer) => {
        // nothing to read lol
        if (data.length < 1) return;

        const view = viewOf(data);  // handles buffer offsets for us

        if (view.getUint8(0) !== MSG.PLACE) return;
        if (data.length !== 6) return;   // wrong size means must be malformed data, drop this shit

        const { x, y, colour } = decodePlace(view);

        // Types no longer exists at runtime, have to validate everything coming from the wire
        // drop out of bound numbers
        if (x >= W || y >= H || colour >= PALETTE_SIZE) return;

        const idx = index(x, y);
        board[idx] = colour;
        markDirty(idx, colour);
    });

    sock.on("close", () => {
        clients.delete(sock);
        app.log.info(`disconnected - now have ${clients.size} websockets total`);
    });

    sock.on("error", (err) => {
        app.log.error(err);
        clients.delete(sock);
    })
});

app.get("/board.png", async (req, reply) => {
    // relabel unknown data in query to known strings
    const qs = req.query as { scale?: string; grid?: string; alpha?: string };

    // clamp everything from query string
    // scale too big will allocate too many pixels to img and kill the process lol
    const scale = Math.min(Math.max(Number(qs.scale) || 4, 1), 16);
    const grid = qs.grid === "1";
    const alpha = qs.alpha === "1";
    // scale=1 means unscaled 256x256 img
    // format if client edits an export and re-import

    const png = await renderPng(scale, grid, alpha);
    return reply
        .type("image/png") // this matters, tell the browser this is an image and not binary garbage
        .header("Cache-Control", "no-cache") // stop app pinning stale canvas when using the img
        .send(png);
})



/** ========== flush ========== */
function flush(): void {
    if (dirty.size == 0) return;

    const pixels: Pixel[] = []
    for (const [boardIdx, colour] of dirty) {
        pixels.push({ x: boardIdx % W, y: Math.floor(boardIdx / W), colour})
    }
    dirty.clear();

    const payload = encodeDelta(pixels);

    const dead: WebSocket[] = [];
    for (const client of clients) {
        try{
            client.send(payload);
        } catch {
            dead.push(client);
        }
    }
    // always remove AFTER marked dead, not during dead
    for (const d of dead) {
        clients.delete(d);
    }
}


/** should run once after everything is wired up */
app.addHook("onReady", async () => {
    startTicker(flush);
    app.log.info(`ticking at ${TICK_HZ}Hz`);
})

// build the snapshot of the board with header and compressed board data
function encodeSnapshot(): Buffer {
    const header = Buffer.alloc(5);     // need 5 bytes
    header.writeUInt8(MSG.SNAPSHOT, 0); // byte 0    8  bits
    header.writeUInt16LE(W, 1);         // byte 1-2  16 bits
    header.writeUInt16LE(H, 3);         // byte 3-4  16 bits
    return Buffer.concat([header, deflateSync(board)]);
}







/** Always Last */
await app.listen({ port: PORT, host: "0.0.0.0" });