import Fastify from "fastify";
import type { FastifyRequest, FastifyReply } from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import cookie from "@fastify/cookie";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { MAIN_SIZE, index} from "../shared/constants.js";
import { PALETTE_SIZE, EMPTY } from "../shared/palette.js";
import {
    peekResident, loadCanvas, addClient, removeClient, type Canvas, allResident,
    newCanvasId, newJoinCode, MAIN_ID, sweep, canEnter, readCanvas, dropResident, clientOf,
    applyFrame, sendPending, type CanvasConfig, type Client, withinFloodCap, FLOOD_BURST, ownerPainted,
} from "./canvas.js";
import {
    saveCanvasConfig, getCanvasConfig, getCanvasByOwner, listCanvases, setCanvasSize,
    setCanvasPrivacy, deleteCanvasConfig, addMember, type User,
    inactiveUserIds, deleteUser, deleteExpiredSessions, touchActive,
} from "./db.js";
import {
    persistDirty, clearBoard, deleteBoard, publishFrame, publishRoomEvent, onBusMessage,
    unsubscribeCanvas, type RoomEvent,
} from "./redis.js";
import { metrics, snapshot } from "./metrics.js";
import { TICK_HZ, startTicker } from "./hub.js";
import { deflateSync } from "node:zlib";
import { renderPng, thumbnail, pruneThumbnails } from "./export.js";
import {
    MSG, viewOf, decodePlace, encodeDelta, MAX_DELTA_PIXELS, type Pixel, encodeClear,
} from "../shared/protocols.js";
import {type CreateRequest, validateCreate} from "../shared/canvasConfig.js";
import {
    register, login, issueSession, userFromToken, endSession, SESSION_DAYS, INACTIVE_MS,
} from "./auth.js";



const PORT = Number(process.env.PORT ?? 8000);

// Deployed, TLS ends at the host's proxy and we are reached over plain HTTP. Trusting its
// X-Forwarded-Proto is what makes req.protocol say https, so og:url and og:image in
// pageFor() point at the real address rather than an http:// one that redirects or fails.
const app = Fastify({ logger: true, trustProxy: true });

/** Always First */
await app.register(fastifyStatic, {
    root: join(process.cwd(), "public"),
    // index.html is a template now, not a page - it is served through pageFor() so the
    // link preview describes the canvas being shared. Raw, it would show {{TITLE}}.
    index: false,
});
await app.register(cookie);
await app.register(websocket);

/**
 * main is the only canvas not created through POST /api/canvas, so nothing else ever
 * writes its config row - without this the landing page 4004s after a restart.
 */
async function ensureMain(): Promise<void> {
    saveCanvasConfig({
        id: MAIN_ID,
        name: MAIN_ID,
        w: MAIN_SIZE,
        h: MAIN_SIZE,
        ownerId: null,
        isPublic: true,
        joinCode: null,
        createdAt: Date.now(),
    });
    // The save above never overwrites, so an older, bigger main keeps its old size without
    // this. Forcing it means the stored board no longer fits, and loadCanvas below starts
    // main over blank - which is the price of shrinking it.
    setCanvasSize(MAIN_ID, MAIN_SIZE, MAIN_SIZE);

    const canvas = await loadCanvas(MAIN_ID);
    if (!canvas) throw new Error(`could not load ${MAIN_ID} after saving its config`);
}
await ensureMain();

app.get("/ws", { websocket: true }, async (sock: WebSocket, req: FastifyRequest) => {
    const id = (req.query as { c?: string }).c ?? MAIN_ID;

    // Checked on the config, before loadCanvas, so a refused visitor never pulls a board
    // into memory. The upgrade is an ordinary HTTP request, so the session cookie is here.
    const cfg = getCanvasConfig(id);
    if (!cfg) {
        sock.close(4004, "no such canvas");  // 4000-4999 is ours to define
        return;                              // reject before addClient, nothing to clean up
    }
    const user = userFromToken(req.cookies.session);
    if (!canEnter(cfg, user?.id)) {
        sock.close(user ? 4003 : 4001, user ? "private room" : "log in first");
        return;
    }

    const canvas = await loadCanvas(id);
    if (!canvas) {
        sock.close(4004, "no such canvas");  // deleted while we were checking
        return;
    }

    // The load above is this handler's first await, so the client may have given up during
    // it. Its close event has already fired, before the listener below exists to remove it,
    // so adding it now would leave a dead socket in canvas.clients forever.
    if (sock.readyState !== WebSocket.OPEN) return;

    const client: Client = {
        sock, canvas, userId: user?.id, floodTokens: FLOOD_BURST, floodAt: Date.now(), renewedAt: 0,
    };

    // add socket to clients
    addClient(client);
    // sock.send(JSON.stringify({ t: "snapshot", board: Array.from(board) }));
    sock.send(encodeSnapshot(canvas));
    app.log.info(`connected to ${canvas.id} - now have ${canvas.clients.size} websockets in total`);


    // broadcast to all clients
    sock.on("message", (data: Buffer) => {
        // Messages already buffered keep arriving after close(). Without this each one
        // would be parsed, and a flooded socket would count thousands of times below.
        if (sock.readyState !== WebSocket.OPEN) return;

        // Closed rather than dropped: ignoring a client sending thousands a second still
        // means parsing every one of them. A reconnect is its own rate limit.
        if (!withinFloodCap(client)) {
            metrics.flooded += 1;
            sock.close(4029, "too many messages");
            return;
        }

        // nothing to read lol
        if (data.length < 1) return;

        const view = viewOf(data);  // handles buffer offsets for us

        if (view.getUint8(0) !== MSG.PLACE) return;
        if (data.length !== 6) return;   // wrong size means must be malformed data, drop this shit

        const { x, y, colour } = decodePlace(view);

        // Types no longer exists at runtime, have to validate everything coming from the wire
        // drop out of bound numbers. EMPTY is allowed: that is the eraser.
        if (x >= canvas.w || y >= canvas.h) return;
        if (colour !== EMPTY && colour >= PALETTE_SIZE) return;

        metrics.pixelsIn += 1;
        if (ownerPainted(client)) touchActive(client.userId!);

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
        // For the page script, to decide whether to offer clear-all. The server still
        // checks - this only decides what the page shows.
        .replaceAll("{{NAME}}", escapeHtml(cfg.name))
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
    // readCanvas, not loadCanvas: the lobby fetches a thumbnail of every room over and over,
    // and loading each one would keep them all in memory for as long as a lobby is open.
    const canvas = await readCanvas(qs.c ?? MAIN_ID);
    if (!canvas) return reply.code(404).send({ error: "no such canvas" });

    // Every logged-in user may see every room's picture, private ones included - that is
    // what the lobby tiles are. Logged out, only public rooms, which keeps link previews
    // working for them.
    if (!canvas.isPublic && !userFromToken(req.cookies.session)) {
        return reply.code(401).send({ error: "log in first" });
    }

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

    // The lobby tile's exact request is the one worth caching - it is the one on a timer.
    const png = scale === 1 && !grid && alpha
        ? await thumbnail(canvas)
        : await renderPng(canvas, scale, grid, alpha);
    return reply
        .type("image/png") // this matters, tell the browser this is an image and not binary garbage
        .header("Cache-Control", "no-cache") // stop app pinning stale canvas when using the img
        .send(png);
})

/** ========== rooms ========== */

/** The logged-in user, or null after sending a 401. */
function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
    const user = userFromToken(req.cookies.session);
    if (!user) reply.code(401).send({ error: "log in first" });
    return user;
}

/** The room in the URL if this user owns it, or null after sending the right error. */
function requireOwnRoom(req: FastifyRequest, reply: FastifyReply): { user: User; cfg: CanvasConfig } | null {
    const user = requireUser(req, reply);
    if (!user) return null;
    const cfg = getCanvasConfig((req.params as { cid: string }).cid);
    if (!cfg) {
        reply.code(404).send({ error: "no such canvas" });
        return null;
    }
    if (cfg.ownerId !== user.id) {
        reply.code(403).send({ error: "not your canvas" });
        return null;
    }
    return { user, cfg };
}

/**
 * A room's settings changed, maybe on another process. Routes never act on their own
 * sockets directly: they publish, and every process - the one that handled the request
 * included - comes through here and fixes up the clients it holds.
 */
function onRoomEvent(id: string, event: RoomEvent) {
    const live = peekResident(id);
    if (!live) return;

    const cfg = event === "changed" ? getCanvasConfig(id) : null;
    if (!cfg) {
        // Deleted. Drop pending pixels first, or a flush would write them back to Redis
        // after the board was removed and leave an orphan key.
        live.dirty.clear();
        for (const sock of [...live.clients]) sock.close(4004, "canvas deleted");
        dropResident(id);
        unsubscribeCanvas(id);
        return;
    }

    // The resident copy of the config is what later checks read - keep it current.
    live.isPublic = cfg.isPublic;
    live.joinCode = cfg.joinCode;
    // Changing the lock should lock out whoever is already inside, too.
    for (const sock of [...live.clients]) {
        if (!canEnter(cfg, clientOf(sock)?.userId)) sock.close(4003, "private room");
    }
}

onBusMessage({ frame: applyFrame, room: onRoomEvent });

app.post("/api/canvas", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    const error = validateCreate(req.body);
    if (error) return reply.code(400).send({ error: error });

    // Checked here for a friendly message; the unique index is the real guard (see catch).
    if (getCanvasByOwner(user.id)) {
        return reply.code(409).send({ error: "you already have a room - delete it to make a new one" });
    }

    const { name, w, h, isPublic } = req.body as CreateRequest;
    const cfg: CanvasConfig = {
        id: newCanvasId(),
        name,
        w,
        h,
        ownerId: user.id,
        isPublic,
        // Made even for a public room, so turning it private later has a code ready.
        joinCode: newJoinCode(),
        createdAt: Date.now(),
    }

    try {
        saveCanvasConfig(cfg);   // SQLite, so it survives a restart. Synchronous - no await.
    } catch {
        return reply.code(409).send({ error: "you already have a room - delete it to make a new one" });
    }
    await loadCanvas(cfg.id);    // makes it resident and writes its blank board to Redis

    return { id: cfg.id };
});


/** The lobby: every room as a tile. Logged in only. */
app.get("/api/canvases", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    // Lists what exists, not what is loaded - an evicted canvas is still a canvas.
    return listCanvases(MAIN_ID, 60).map(cfg => {
        const mine = cfg.ownerId === user.id;
        return {
            id: cfg.id,
            name: cfg.name,
            w: cfg.w,
            h: cfg.h,
            ownerName: cfg.ownerName,
            isPublic: cfg.isPublic,
            mine,
            canEnter: canEnter(cfg, user.id),
            // Only the owner ever sees the code - it is what they share.
            code: mine ? cfg.joinCode : undefined,
            // peek, not getResident: bumping lastActive here would mean an open lobby tab
            // keeps every canvas on it resident and the sweep never evicts anything.
            clients: peekResident(cfg.id)?.clients.size ?? 0,
        };
    });
});

/** Owner switches their room between public and private. */
app.patch("/api/c/:cid", async (req, reply) => {
    const own = requireOwnRoom(req, reply);
    if (!own) return;

    const { isPublic } = (req.body ?? {}) as { isPublic?: unknown };
    if (typeof isPublic !== "boolean") return reply.code(400).send({ error: "isPublic must be true or false" });

    // Rooms from before codes existed have none, so make one the first time it goes private.
    const joinCode = own.cfg.joinCode ?? newJoinCode();
    setCanvasPrivacy(own.cfg.id, isPublic, joinCode, false);
    await publishRoomEvent(own.cfg.id, "changed");
    return { ok: true };
});

/** Owner makes a new code. Everyone who joined with the old one has to ask again. */
app.post("/api/c/:cid/code", async (req, reply) => {
    const own = requireOwnRoom(req, reply);
    if (!own) return;

    const joinCode = newJoinCode();
    setCanvasPrivacy(own.cfg.id, own.cfg.isPublic, joinCode, true);
    await publishRoomEvent(own.cfg.id, "changed");
    return { code: joinCode };
});

/** Enter a private room's code. Right once, and you are a member from then on. */
app.post("/api/c/:cid/join", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    const cfg = getCanvasConfig((req.params as { cid: string }).cid);
    if (!cfg) return reply.code(404).send({ error: "no such canvas" });
    if (canEnter(cfg, user.id)) return { ok: true };

    const { code } = (req.body ?? {}) as { code?: unknown };
    // Codes are made lowercase; people will type them however they read them.
    if (typeof code !== "string" || code.trim().toLowerCase() !== cfg.joinCode) {
        return reply.code(403).send({ error: "wrong code" });
    }
    addMember(user.id, cfg.id);
    return { ok: true };
});

/** Owner deletes their room - the only way to make a different one. */
app.delete("/api/c/:cid", async (req, reply) => {
    const own = requireOwnRoom(req, reply);
    if (!own) return;

    await deleteRoom(own.cfg.id);
    app.log.info(`canvas ${own.cfg.id} deleted by user ${own.user.id}`);
    return { ok: true };
});

/** Remove a room everywhere: config, open sockets on every process, board and history. */
async function deleteRoom(id: string): Promise<void> {
    // Config first, so nobody can join while the rest is torn down. Every process holding
    // it closes its own sockets when the event arrives (onRoomEvent).
    deleteCanvasConfig(id);
    await publishRoomEvent(id, "deleted");
    await deleteBoard(id);
}

/**
 * Delete every account with no activity for INACTIVE_DAYS (see auth.ts), room and history
 * included, and clear out expired sessions. Safe to run on several processes at once:
 * each step is harmless to repeat.
 */
async function purgeInactive(): Promise<void> {
    for (const userId of inactiveUserIds(Date.now() - INACTIVE_MS)) {
        // Room before account: nothing cascades from users to canvases (see deleteUser),
        // and a crash in between leaves an account the next pass will find again.
        const room = getCanvasByOwner(userId);
        if (room) await deleteRoom(room.id);
        deleteUser(userId);
        app.log.info(`purged inactive user ${userId}${room ? ` and canvas ${room.id}` : ""}`);
    }
    const sessions = deleteExpiredSessions();
    if (sessions) app.log.info(`deleted ${sessions} expired sessions`);
}


/** ========== metrics ========== */

/**
 * This process's numbers. Behind a proxy each request may land on a different process,
 * so it says which one it is.
 */
app.get("/metrics", async () => {
    let connections = 0, residentCanvases = 0;
    for (const canvas of allResident()) {
        connections += canvas.clients.size;
        residentCanvases += 1;
    }
    return { port: PORT, pid: process.pid, connections, residentCanvases, ...snapshot() };
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
    return {
        id: user.id, name: user.name, isAdmin: user.isAdmin,
        // When purgeInactive will delete this account and its room. null: admins never are.
        deleteAt: user.isAdmin ? null : user.lastActiveAt + INACTIVE_MS,
    };
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
    const clear = encodeClear();
    await clearBoard(canvas, clear);
    // Every process (this one too) clears its copy and tells its clients - see applyFrame.
    await publishFrame(canvas.id, clear);
}

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
    const t0 = performance.now();
    for (const canvas of allResident()) flushCanvas(canvas);
    const t1 = performance.now();
    // What the bus delivered since last tick goes out now, one frame per canvas.
    for (const canvas of allResident()) sendPending(canvas);
    const t2 = performance.now();
    metrics.tickMs.push(t2 - t0);
    metrics.fanoutMs.push(t2 - t1);
    metrics.ticks += 1;
}

/** Persist and publish one canvas's pending pixels. Also what eviction calls. */
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

    // The DELTA count is a u16, so a tick that dirties more pixels than that has to
    // go out as several frames - one oversized frame would wrap the count to 0 and
    // the client would drop every pixel in it silently.
    const frames: Uint8Array[] = [];
    for (let i = 0; i < pixels.length; i += MAX_DELTA_PIXELS) {
        frames.push(encodeDelta(pixels.slice(i, i + MAX_DELTA_PIXELS)));
    }

    // Logged from here, not from the message handler: `dirty` has already collapsed two
    // places on one pixel in one tick into the one that won, and the log must record what
    // the board did, not every attempt.
    //
    // Deliberately not awaited - the tick must not block on a network round trip. A
    // failed write loses those pixels from storage but not from memory, and the next
    // write to the same pixel repairs the board (though not the log).
    persistDirty(canvas, dirty, frames).catch(err => app.log.error(err, "persisting board failed"));

    // Published, not broadcast: the subscription sends it to clients on every process,
    // this one included. Published after persistDirty on the same connection, so no
    // process can hear about a pixel before Redis holds it.
    for (const frame of frames) {
        publishFrame(canvas.id, frame).catch(err => app.log.error(err, "publishing delta failed"));
    }
}


/** How often to look for canvases to drop from memory. */
const SWEEP_MS = 60_000;

/** Well inside the ~60 s idle timeout most proxies put on a WebSocket. */
const KEEPALIVE_MS = 30_000;

/** How often to look for inactive accounts. The limit is days, so an hour late is nothing. */
const PURGE_MS = 60 * 60_000;

/** should run once after everything is wired up */
app.addHook("onReady", async () => {
    startTicker(flushAll);
    app.log.info(`ticking at ${TICK_HZ}Hz`);

    setInterval(() => {
        for (const canvas of sweep(flushCanvas)) {
            // Synchronously, so it can never land after a reload's subscribe (see redis.ts).
            unsubscribeCanvas(canvas.id);
            app.log.info(`evicted ${canvas.id}`);
        }
        pruneThumbnails();
    }, SWEEP_MS);

    // Proxies close a WebSocket that has been quiet for about a minute, and someone just
    // looking at a canvas sends nothing. The browser answers pings on its own.
    setInterval(() => {
        for (const canvas of allResident()) {
            for (const sock of canvas.clients) {
                if (sock.readyState === WebSocket.OPEN) sock.ping();
            }
        }
    }, KEEPALIVE_MS);

    const purge = () => purgeInactive().catch(err => app.log.error(err, "purging inactive accounts failed"));
    purge();    // at boot too: a server that restarts more often than hourly would never purge
    setInterval(purge, PURGE_MS);
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