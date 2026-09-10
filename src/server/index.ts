import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import { join } from "node:path";

import { DEFAULT_W, DEFAULT_H, index} from "../shared/constants.js";
import { PALETTE_SIZE } from "../shared/palette.js";
import {createCanvas, putResident, getResident, addClient, removeClient, broadcast, type Canvas, allResident} from "./canvas.js";
import { TICK_HZ, startTicker } from "./hub.js";
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

/** The permanent default canvas. 04b.6 picks the canvas from the URL instead. */
const main: Canvas = createCanvas({
    id: "main",
    name: "main",
    w: DEFAULT_W,
    h: DEFAULT_H,
    cooldownMs: 0,
    ownerId: null,
    isPublic: true,
    createdAt: Date.now(),
});
putResident(main);

app.get("/ws", { websocket: true }, (sock: WebSocket, req: FastifyRequest) => {
    const id = (req.query as { c?: string }).c ?? "main";

    const canvas = getResident(id);
    if (!canvas) {
        sock.close(4004, "no such canvas");  // 4000-4999 is ours to define
        return;                              // reject before addClient, nothing to clean up
    }

    // add socket to clients
    addClient(sock, canvas);
    // sock.send(JSON.stringify({ t: "snapshot", board: Array.from(board) }));
    sock.send(encodeSnapshot(canvas));
    app.log.info(`connected to ${canvas.id} - now have ${canvas.clients.size} websockets in total`);


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
        if (x >= canvas.w || y >= canvas.h || colour >= PALETTE_SIZE) return;

        const idx = index(x, y, canvas.w);
        canvas.board[idx] = colour;
        canvas.dirty.set(idx, colour);    // last write wins
    });

    sock.on("close", () => {
        removeClient(sock);
        app.log.info(`disconnected from ${canvas.id} - now have ${canvas.clients.size} websockets total`);
    });

    sock.on("error", (err) => {
        app.log.error(err);
        removeClient(sock);
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
    // scale=1 means unscaled, one image pixel per board pixel
    // format if client edits an export and re-import

    const png = await renderPng(main, scale, grid, alpha);
    return reply
        .type("image/png") // this matters, tell the browser this is an image and not binary garbage
        .header("Cache-Control", "no-cache") // stop app pinning stale canvas when using the img
        .send(png);
})



/**
 *  flush during tick loop iteration of canvases
 *  Single loop at 20Hz iterating all resident canvases and flush
 *  */
function flushAll(): void {
    for (const canvas of allResident()) {
        if (canvas.dirty.size === 0) return;

        const pixels: Pixel[] = []
        for (const [boardIdx, colour] of canvas.dirty) {
            pixels.push({ x: boardIdx % canvas.w, y: Math.floor(boardIdx / canvas.w), colour })
        }
        canvas.dirty.clear();

        broadcast(canvas, encodeDelta(pixels));
    }
}


/** should run once after everything is wired up */
app.addHook("onReady", async () => {
    startTicker(flushAll);
    app.log.info(`ticking at ${TICK_HZ}Hz`);
})

// build the snapshot of the board with header and compressed board data
function encodeSnapshot(canvas: Canvas): Buffer {
    const header = Buffer.alloc(5);       // need 5 bytes
    header.writeUInt8(MSG.SNAPSHOT, 0);   // byte 0    8  bits
    header.writeUInt16LE(canvas.w, 1);    // byte 1-2  16 bits
    header.writeUInt16LE(canvas.h, 3);    // byte 3-4  16 bits
    return Buffer.concat([header, deflateSync(canvas.board)]);
}

/** Always Last */
await app.listen({ port: PORT, host: "0.0.0.0" });