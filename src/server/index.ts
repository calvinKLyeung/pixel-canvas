import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import { join } from "node:path";

import { DEFAULT_W, DEFAULT_H, index} from "../shared/constants.js";
import { PALETTE_SIZE } from "../shared/palette.js";
import {
    peekResident, loadCanvas, addClient, removeClient, broadcast, type Canvas, allResident,
    newCanvasId, MAIN_ID,
    type CanvasConfig
} from "./canvas.js";
import { saveCanvasConfig, listPublicCanvasConfigs } from "./db.js";
import { persistDirty } from "./redis.js";
import { TICK_HZ, startTicker } from "./hub.js";
import { deflateSync } from "node:zlib";
import { renderPng } from "./export.js";
import { MSG, viewOf, decodePlace, encodeDelta, MAX_DELTA_PIXELS, type Pixel } from "../shared/protocols.js";
import {type CreateRequest, validateCreate} from "../shared/canvasConfig.js";



const PORT = Number(process.env.PORT ?? 8000);

const app = Fastify({ logger: true });

/** Always First */
await app.register(fastifyStatic, {
    root: join(process.cwd(), "public"),
});
await app.register(websocket);

/**
 * main is the only canvas not created through POST /api/canvas, so nothing else ever
 * writes its config row - without this the landing page 4004s after a restart.
 */
async function ensureMain(): Promise<void> {
    saveCanvasConfig({
        id: MAIN_ID,
        name: MAIN_ID,
        w: DEFAULT_W,
        h: DEFAULT_H,
        cooldownMs: 0,
        ownerId: null,
        isPublic: true,
        createdAt: Date.now(),
    });

    // The save is a no-op if main already exists, so let loadCanvas read the row back
    // rather than trusting the defaults above: an existing main keeps its stored
    // dimensions and the board people have already painted on it.
    const canvas = await loadCanvas(MAIN_ID);
    if (!canvas) throw new Error(`could not load ${MAIN_ID} after saving its config`);
}
await ensureMain();

app.get("/ws", { websocket: true }, async (sock: WebSocket, req: FastifyRequest) => {
    const id = (req.query as { c?: string }).c ?? MAIN_ID;

    const canvas = await loadCanvas(id);
    if (!canvas) {
        sock.close(4004, "no such canvas");  // 4000-4999 is ours to define
        return;                              // reject before addClient, nothing to clean up
    }

    // The load above is this handler's first await, so the client may have given up during
    // it. Its close event has already fired, before the listener below exists to remove it,
    // so adding it now would leave a dead socket in canvas.clients forever.
    if (sock.readyState !== WebSocket.OPEN) return;

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
    const qs = req.query as { c?: string; scale?: string; grid?: string; alpha?: string };

    // same ?c= as /ws - without this every canvas exports main's board.
    // Loading an evicted canvas just to render it makes it resident again; the sweep
    // drops it on the next pass, since a PNG request leaves no clients behind.
    const canvas = await loadCanvas(qs.c ?? MAIN_ID);
    if (!canvas) return reply.code(404).send({ error: "no such canvas" });

    // clamp everything from query string
    // scale too big will allocate too many pixels to img and kill the process lol
    const scale = Math.min(Math.max(Number(qs.scale) || 4, 1), 16);
    const grid = qs.grid === "1";
    // Transparent by default, so a download matches the checkerboard on screen.
    // og:image is the exception and passes alpha=0: Discord and Slack composite a
    // transparent PNG onto their own background, where dark art vanishes in dark mode.
    const alpha = qs.alpha !== "0";
    // scale=1 means unscaled, one image pixel per board pixel
    // format if client edits an export and re-import

    const png = await renderPng(canvas, scale, grid, alpha);
    return reply
        .type("image/png") // this matters, tell the browser this is an image and not binary garbage
        .header("Cache-Control", "no-cache") // stop app pinning stale canvas when using the img
        .send(png);
})

app.post("/api/canvas", async (req, reply) => {
    const error = validateCreate(req.body);
    if (error) return reply.code(400).send({ error: error });

    // const user = userFromToken(req.cookies?.session); // always null for now
    const { name, w, h, cooldownMs } = req.body as CreateRequest;

    const cfg: CanvasConfig = {
        id: newCanvasId(),
        name,
        w,
        h,
        cooldownMs,
        // ownerId: user?.id ?? null,
        ownerId: null,
        isPublic: true,
        createdAt: Date.now(),
    }

    saveCanvasConfig(cfg);       // SQLite, so it survives a restart. Synchronous - no await.
    await loadCanvas(cfg.id);    // makes it resident and writes its blank board to Redis

    return { id: cfg.id };
});


app.get("/api/canvases", async () => {
    // Lists what exists, not what is loaded - an evicted canvas is still a canvas, and
    // before this the lobby quietly forgot every board nobody happened to be painting.
    return listPublicCanvasConfigs(40).map(cfg => ({
        id: cfg.id,
        name: cfg.name,
        w: cfg.w,
        h: cfg.h,
        // peek, not getResident: bumping lastActive here would mean an open lobby tab
        // keeps every canvas on it resident and the sweep never evicts anything.
        clients: peekResident(cfg.id)?.clients.size ?? 0,
    }));
});


/**
 *  flush during tick loop iteration of canvases
 *  Single loop at 20Hz iterating all resident canvases and flush
 *  */
function flushAll(): void {
    for (const canvas of allResident()) {
        if (canvas.dirty.size === 0) continue;

        // Hand the persist its own map rather than clearing this one: a place arriving
        // mid-flush then lands in the fresh map instead of one being drained.
        const dirty = canvas.dirty;
        canvas.dirty = new Map();

        const pixels: Pixel[] = []
        for (const [boardIdx, colour] of dirty) {
            pixels.push({ x: boardIdx % canvas.w, y: Math.floor(boardIdx / canvas.w), colour })
        }

        // Deliberately not awaited - the tick must not block on a network round trip. A
        // failed write loses those pixels from storage but not from memory, and the next
        // write to the same pixel repairs it.
        persistDirty(canvas, dirty).catch(err => app.log.error(err, "persisting board failed"));

        // The DELTA count is a u16, so a tick that dirties more pixels than that has to
        // go out as several frames - one oversized frame would wrap the count to 0 and
        // the client would drop every pixel in it silently.
        for (let i = 0; i < pixels.length; i += MAX_DELTA_PIXELS) {
            broadcast(canvas, encodeDelta(pixels.slice(i, i + MAX_DELTA_PIXELS)));
        }
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