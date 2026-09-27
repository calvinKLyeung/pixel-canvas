import Fastify from "fastify";
import type { FastifyRequest, FastifyReply } from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import cookie from "@fastify/cookie";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { DEFAULT_W, DEFAULT_H, index} from "../shared/constants.js";
import { PALETTE_SIZE, EMPTY } from "../shared/palette.js";
import {
    peekResident, loadCanvas, addClient, removeClient, broadcast, type Canvas, allResident,
    newCanvasId, MAIN_ID, sweep,
    type CanvasConfig, type Client,
} from "./canvas.js";
import {
    saveCanvasConfig, getCanvasConfig, listPublicCanvasConfigs, setCanvasCooldown,
    saveDraft, loadDraft,
} from "./db.js";
import { persistDirty, writeBoard } from "./redis.js";
import { TICK_HZ, startTicker } from "./hub.js";
import { deflateSync } from "node:zlib";
import { renderPng } from "./export.js";
import {
    MSG, viewOf, decodePlace, encodeDelta, MAX_DELTA_PIXELS, type Pixel,
    encodeRejected, encodeClear,
} from "../shared/protocols.js";
import {type CreateRequest, validateCreate} from "../shared/canvasConfig.js";
import { Bucket, bucketFor, sweepBuckets } from "./limits.js";
import { register, login, issueSession, userFromToken, endSession, SESSION_DAYS } from "./auth.js";
import { MAX_DRAFT } from "../shared/draft.js";



const PORT = Number(process.env.PORT ?? 8000);

const app = Fastify({ logger: true });

/** Always First */
await app.register(fastifyStatic, {
    root: join(process.cwd(), "public"),
    // index.html is a template now, not a page - it is served through pageFor() so the
    // link preview describes the canvas being shared. Raw, it would show {{TITLE}}.
    index: false,
});
await app.register(cookie);
await app.register(websocket);

// Drafts are PUT as raw bytes in the DELTA format. bodyLimit turns an oversized one into a
// 413 before the handler runs - MAX_DRAFT is only enforced in the browser, which is not ours.
app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 3 + 5 * MAX_DRAFT },
    (_req, body, done) => done(null, body),
);

/** The landing canvas's cooldown. */
const MAIN_COOLDOWN_MS = 5_000;

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
        cooldownMs: MAIN_COOLDOWN_MS,
        ownerId: null,
        isPublic: true,
        createdAt: Date.now(),
    });
    // The save above never overwrites, and main rows from before the cooldown existed hold
    // 0 - which would make every paint on main free. The cooldown is safe to force;
    // the dimensions are not (see below).
    setCanvasCooldown(MAIN_ID, MAIN_COOLDOWN_MS);

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

    // The upgrade is an ordinary HTTP request, so the session cookie arrives with it and
    // there is nothing to add to the protocol. The bucket follows the person, not the
    // socket: refreshing gets a new socket and the same cooldown.
    const user = userFromToken(req.cookies.session);
    const client: Client = { sock, canvas, identity: user?.id ?? req.ip, userId: user?.id };

    // add socket to clients
    addClient(client);
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
        // drop out of bound numbers. EMPTY is an erase, priced below like any other colour.
        if (x >= canvas.w || y >= canvas.h) return;
        if (colour !== EMPTY && colour >= PALETTE_SIZE) return;

        // Validated first, charged second: garbage must not cost a token, or anyone could
        // drain someone else's bucket by sending it malformed messages.
        // Looked up per paint rather than held on the client - see sweepBuckets.
        const bucket = bucketFor(client.identity);
        if (!bucket.take(canvas.cooldownMs)) {
            sock.send(encodeRejected(bucket.msUntilNext(canvas.cooldownMs)));
            return;
        }

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

/**
 * The painting page, read once at boot. Its {{...}} holes are filled per canvas, because
 * crawlers do not run JavaScript: picking the canvas client-side would give every shared
 * link main's preview image and main's title.
 */
const pageTemplate = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/**
 * Canvas names are typed by whoever made the canvas and the Host header is whatever the
 * client sent, so neither reaches an HTML attribute unescaped. A canvas named
 * `"><script>` would otherwise run for everyone who opened it.
 */
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c);

const originOf = (req: FastifyRequest) =>
    `${req.protocol}://${req.headers.host ?? `localhost:${PORT}`}`;

function pageFor(cfg: CanvasConfig, origin: string): string {
    const id = encodeURIComponent(cfg.id);
    return pageTemplate
        .replaceAll("{{TITLE}}", escapeHtml(`${cfg.name} - pixel canvas`))
        .replaceAll("{{DESCRIPTION}}", escapeHtml(`A shared ${cfg.w}x${cfg.h} canvas anyone can paint on.`))
        .replaceAll("{{URL}}", escapeHtml(`${origin}/c/${id}`))
        .replaceAll("{{IMAGE}}", escapeHtml(`${origin}/board.png?alpha=0&c=${id}`))
        // For the page script: the draft time estimate and whether to offer clear-all.
        // The server still checks both - these only decide what the page shows.
        .replaceAll("{{NAME}}", escapeHtml(cfg.name))
        .replaceAll("{{COOLDOWN_MS}}", String(cfg.cooldownMs))
        .replaceAll("{{OWNER_ID}}", String(cfg.ownerId ?? ""));
}

/** The canonical URL for a canvas. */
app.get("/c/:id", async (req, reply) => {
    const { id } = req.params as { id: string };

    // Config only, deliberately not loadCanvas: a crawler fetching a link preview should
    // not pull a board into memory and push a live one out of it.
    const cfg = getCanvasConfig(id);
    if (!cfg) return reply.code(404).type("text/plain").send("no such canvas");

    return reply.type("text/html").send(pageFor(cfg, originOf(req)));
});

/** Older links were /?c=<id>, and bare / is the landing page. Both go to the real URL. */
app.get("/", async (req, reply) => {
    const id = (req.query as { c?: string }).c ?? MAIN_ID;
    return reply.redirect(`/c/${encodeURIComponent(id)}`, 302);
});

/** Static would serve the raw template here, placeholders and all. */
app.get("/index.html", async (_req, reply) => reply.redirect("/", 302));

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

    // Anonymous canvases are allowed and stay ownerless, which means nobody can clear them.
    const user = userFromToken(req.cookies.session);
    const { name, w, h, cooldownMs } = req.body as CreateRequest;

    const cfg: CanvasConfig = {
        id: newCanvasId(),
        name,
        w,
        h,
        cooldownMs,
        ownerId: user?.id ?? null,
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


/** ========== accounts ========== */

/**
 * httpOnly: page scripts cannot read it, so an XSS bug cannot steal the session.
 * secure: HTTPS only, so it cannot be sniffed - off in development, localhost is plain HTTP.
 * sameSite lax: not sent on cross-site POSTs, which blocks CSRF against our routes.
 */
function setSessionCookie(reply: FastifyReply, token: string) {
    reply.setCookie("session", token, {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: SESSION_DAYS * 24 * 3600,
    });
}

app.post("/api/register", async (req, reply) => {
    const { name, password } = (req.body ?? {}) as { name?: unknown; password?: unknown };
    const result = await register(name, password);
    if ("error" in result) return reply.code(400).send({ error: result.error });

    setSessionCookie(reply, issueSession(result.id));
    return { ok: true };
});

app.post("/api/login", async (req, reply) => {
    const { name, password } = (req.body ?? {}) as { name?: unknown; password?: unknown };
    const user = await login(name, password);
    // One message for "no such name" and "wrong password" - see login().
    if (!user) return reply.code(401).send({ error: "wrong name or password" });

    setSessionCookie(reply, issueSession(user.id));
    return { ok: true };
});

app.post("/api/logout", async (req, reply) => {
    endSession(req.cookies.session);     // the row, so a copied cookie stops working too
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
});

/** Who the page is logged in as. The cookie is httpOnly, so the page has to ask. */
app.get("/api/me", async (req, reply) => {
    const user = userFromToken(req.cookies.session);
    if (!user) return reply.code(401).send({ error: "not logged in" });
    return { id: user.id, name: user.name, isAdmin: user.isAdmin };
});


/** ========== server-side drafts, so a draft follows you between devices ========== */

app.put("/api/c/:cid/draft", async (req, reply) => {
    const user = userFromToken(req.cookies.session);
    if (!user) return reply.code(401).send();

    // Checked first so a bad id is a 404. Left to the foreign key it is a raw SQLite
    // error thrown into this handler, and the client sees a 500.
    const { cid } = req.params as { cid: string };
    if (!getCanvasConfig(cid)) return reply.code(404).send();

    // Only octet-stream bodies are Buffers; a JSON body would be an object here.
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send();

    saveDraft(user.id, cid, req.body);
    return { ok: true };
});

app.get("/api/c/:cid/draft", async (req, reply) => {
    const user = userFromToken(req.cookies.session);
    if (!user) return reply.code(401).send();

    const { cid } = req.params as { cid: string };
    const data = loadDraft(user.id, cid);
    // 204 is "never saved one here", which the page treats differently from an empty draft.
    if (!data) return reply.code(204).send();
    return reply.type("application/octet-stream").send(data);
});


/** ========== clearing a whole canvas ========== */

/**
 * Wipe a board everywhere at once. One Redis SET of the whole board rather than a
 * SETRANGE per pixel, and one CLEAR byte to clients rather than a delta of every pixel:
 * the normal write path is built for single pixels, and bulk changes want their own.
 */
async function clearCanvas(canvas: Canvas): Promise<void> {
    canvas.board.fill(EMPTY);
    // Pixels painted earlier this tick are about to be erased anyway. Left in, they would
    // flush as a delta after the CLEAR and put a few random pixels back.
    canvas.dirty.clear();
    await writeBoard(canvas);
    broadcast(canvas, encodeClear());
}

/** One clear per canvas per minute, so an owner cannot spam every viewer with them. */
const CLEAR_COOLDOWN_MS = 60_000;
const clearBuckets = new Map<string, Bucket>();

app.post("/api/c/:cid/clear", async (req, reply) => {
    const user = userFromToken(req.cookies.session);
    if (!user) return reply.code(401).send({ error: "log in first" });

    const { cid } = req.params as { cid: string };
    const canvas = await loadCanvas(cid);
    if (!canvas) return reply.code(404).send({ error: "no such canvas" });

    // main's ownerId is null, so only an admin can ever clear it - no special case needed.
    if (canvas.ownerId !== user.id && !user.isAdmin) {
        return reply.code(403).send({ error: "not your canvas" });
    }

    // This destroys other people's work for good, so make it hard to do by accident:
    // the caller has to type the canvas's name, like deleting a GitHub repository.
    const { confirmName } = (req.body ?? {}) as { confirmName?: unknown };
    if (confirmName !== canvas.name) {
        return reply.code(400).send({ error: "name does not match" });
    }

    let limit = clearBuckets.get(cid);
    if (!limit) clearBuckets.set(cid, limit = new Bucket(1));
    if (!limit.take(CLEAR_COOLDOWN_MS)) {
        return reply.code(429).send({ error: "cleared too recently, try again in a minute" });
    }

    await clearCanvas(canvas);
    app.log.info(`canvas ${cid} cleared by user ${user.id}`);
    return { ok: true };
});

// A board full of test scribbles gets in the way of testing almost everything else.
// No auth at all, so it must never be reachable by accident: opt-in, and loud about it.
if (process.env.DEV_TOOLS === "1") {
    app.post("/api/dev/c/:cid/clear", async (req, reply) => {
        const canvas = await loadCanvas((req.params as { cid: string }).cid);
        if (!canvas) return reply.code(404).send({ error: "no such canvas" });
        await clearCanvas(canvas);
        return { ok: true };
    });
    app.log.warn("DEV_TOOLS enabled - the unauthenticated dev clear route is open");
}


/**
 *  flush during tick loop iteration of canvases
 *  Single loop at 20Hz iterating all resident canvases and flush
 *  */
function flushAll(): void {
    for (const canvas of allResident()) flushCanvas(canvas);
}

/** Broadcast and persist one canvas's pending pixels. Also what eviction calls. */
function flushCanvas(canvas: Canvas): void {
    if (canvas.dirty.size === 0) return;

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


/** How often to look for canvases to drop from memory. */
const SWEEP_MS = 60_000;

/** should run once after everything is wired up */
app.addHook("onReady", async () => {
    startTicker(flushAll);
    app.log.info(`ticking at ${TICK_HZ}Hz`);

    setInterval(() => {
        for (const canvas of sweep(flushCanvas)) app.log.info(`evicted ${canvas.id}`);
        sweepBuckets();
    }, SWEEP_MS);
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