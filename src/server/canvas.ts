import type { WebSocket} from "ws";
import { EMPTY } from "../shared/palette.js"
import { randomBytes } from "node:crypto";
import { getCanvasConfig, isMember } from "./db.js";
import { loadBoard, writeBoard, subscribeCanvas } from "./redis.js";
import {
    MSG, viewOf, decodeDelta, encodeDelta, encodeClear, MAX_DELTA_PIXELS, type Pixel,
} from "../shared/protocols.js";
import { index } from "../shared/constants.js";
import { metrics } from "./metrics.js";

/** The permanent landing canvas. Never created through the API, never evicted. */
export const MAIN_ID = "main";

// mainly for SQL in the future
export interface CanvasConfig {
    id: string;
    name: string;
    w: number;
    h: number;
    ownerId: number | null;  // null for main
    isPublic: boolean;
    /** Needed to enter a private room. Kept when a room goes public, so it can go back. */
    joinCode: string | null;
    createdAt: number;
}

// Config + runtime canvas state
export interface Canvas extends CanvasConfig {
    board: Uint8Array;
    dirty: Map<number, number>;
    /**
     * Pixels heard from the bus (from every process, this one included) and not yet sent
     * to our clients. Sent once per tick as ONE frame. Sending each process's frame as it
     * arrives would give every client one frame per process per tick - so with two
     * processes each would do exactly as many socket writes as one process did alone,
     * and adding processes would buy nothing.
     */
    outgoing: Map<number, number>;
    /** A CLEAR arrived since the last send; it goes out before `outgoing`. */
    clearPending: boolean;
    clients: Set<WebSocket>;
    lastActive: number;  // prepare for eviction
}

export function createCanvas(cfg: CanvasConfig): Canvas {
    return {
        ...cfg,
        board: new Uint8Array(cfg.w * cfg.h).fill(EMPTY),
        dirty: new Map(),
        outgoing: new Map(),
        clearPending: false,
        clients: new Set(),
        lastActive: Date.now(),
    };
}



/**
 * Only holds Canvases that currently lives in memory
 * does NOT including ALL canvases
 * */
const resident = new Map<string, Canvas>();


export function getResident(id: string): Canvas | undefined {
    const canvas = resident.get(id);
    if (canvas) canvas.lastActive = Date.now(); // update active date
    return canvas;
}

/**
 * Read a resident canvas WITHOUT marking it active. For listings and metrics.
 * getResident there would mean anyone sitting on the lobby page keeps every canvas
 * listed on it alive, and the eviction sweep would never fire.
 */
export function peekResident(id: string): Canvas | undefined {
    return resident.get(id);
}

export function putResident(c: Canvas) {
    resident.set(c.id, c);
}

export function allResident(): Iterable<Canvas> {
    return resident.values();
}

/** Forget a canvas that no longer exists. Unlike eviction, there is nothing to flush to. */
export function dropResident(id: string) {
    resident.delete(id);
}


/** How long a canvas with nobody connected stays in memory. */
const IDLE_MS = 10 * 60 * 1000;

/** Ceiling on canvases held in memory at once. */
const MAX_RESIDENT = 50;

/** The landing page is pinned, and a board someone is painting on is never taken away. */
function canBeEvicted(c: Canvas): boolean {
    return c.id !== MAIN_ID && c.clients.size === 0;
}

/**
 * Drop canvases from memory so it stays bounded. Their boards are already in Redis, so
 * this costs the next visitor a load and nothing else.
 *
 * Two rules, because neither works alone: idle canvases go, and if that still leaves too
 * many resident, the stalest go too. Time alone has no ceiling - a hundred boards each
 * touched every nine minutes would all stay. A count alone keeps dead boards resident
 * until something newer needs the room.
 *
 * Both rules reduce to one cut. Sorted by lastActive, the idle canvases are exactly the
 * front of the list, so each rule is just a depth to slice to, and the deeper one wins.
 *
 * Takes the flush as a parameter because flushing broadcasts, which lives with the socket
 * code - passing it in is what keeps this module from importing its own caller.
 */
export function sweep(flush: (c: Canvas) => void): Canvas[] {
    const now = Date.now();

    const droppable = [...resident.values()]
        .filter(canBeEvicted)
        .sort((c1, c2) => c1.lastActive - c2.lastActive);   // oldest timestamp to the front

    const idle = droppable.filter(c => now - c.lastActive > IDLE_MS).length;
    const overCap = resident.size - MAX_RESIDENT;

    // slice handles both edges: a negative overCap loses to idle, and a count past the
    // end of the list is clamped.
    const toEvict = droppable.slice(0, Math.max(idle, overCap));

    for (const canvas of toEvict) {
        // A canvas can be holding up to a tick's worth of unflushed pixels. Dropping it
        // without flushing loses them with no error anywhere: the painter watched the
        // pixel appear locally and it simply never persisted.
        flush(canvas);
        resident.delete(canvas.id);
    }

    return toEvict;
}


/** Loads currently in progress, keyed by canvas id. See loadCanvas. */
const loading = new Map<string, Promise<Canvas | null>>();

/** Frames that arrived for a canvas while it was still loading. See loadCanvas. */
const early = new Map<string, Buffer[]>();

/**
 * Get a canvas by id, hydrating it from storage if it is not resident.
 * null means no such canvas has ever existed - a resident miss only means "not loaded".
 */
export async function loadCanvas(id: string): Promise<Canvas | null> {
    const hit = getResident(id);
    if (hit) return hit;

    // Two clients joining an evicted canvas in the same tick must not both load it: the
    // second putResident would replace the first's object, leaving the first client
    // painting onto a Canvas nobody broadcasts to. Share one promise instead.
    // (Request coalescing, or single-flight.)
    const inflight = loading.get(id);
    if (inflight) return inflight;

    const load = (async (): Promise<Canvas | null> => {
        const cfg = getCanvasConfig(id);
        if (!cfg) return null;

        // Subscribe BEFORE reading the board. The other way round leaves a gap: a change
        // published after the read but before the subscribe is in neither, and this process
        // stays wrong about that pixel until someone repaints it. Subscribed first, a
        // change lands in the read, in `early`, or in both - and applying it twice is harmless.
        early.set(id, []);
        await subscribeCanvas(id);

        const canvas = createCanvas(cfg);

        const bytes = await loadBoard(id);
        if (bytes?.length === cfg.w * cfg.h) {
            canvas.board.set(bytes);
        } else {
            // Either nothing is stored yet, or what is stored was sized to different
            // dimensions. Start blank and overwrite: writing single pixels into a key of
            // the wrong length loads back as a board sheared diagonally.
            await writeBoard(canvas);
        }

        // In the order Redis delivered them, so the result matches every other process.
        for (const frame of early.get(id) ?? []) applyToBoard(canvas, frame);

        putResident(canvas);
        return canvas;
    })().finally(() => {
        loading.delete(id);
        early.delete(id);
    });

    loading.set(id, load);
    return load;
}


/** new client , serves as reference to socket, canvas, userId*/
export interface Client {
    sock: WebSocket;
    canvas: Canvas;
    userId?: number;
}

// Still keyed by socket for O(1) removal on disconnect
// but now each canvas also tracks its own set for broadcasting
const clients = new Map<WebSocket, Client>();

export function addClient(client: Client) {
    // Client canvas and Canvas client reference each other, must add together
    clients.set(client.sock, client);
    client.canvas.clients.add(client.sock);
}

export function clientOf(sock: WebSocket): Client | undefined {
    return clients.get(sock);
}

export function removeClient(sock: WebSocket) {
    const client = clients.get(sock);
    if (!client) return; // not exist, some hot client is gone already
    // Client canvas and Canvas client reference each other, must remove together
    client.canvas.clients.delete(sock);
    clients.delete(sock);
    // The canvas was in use right up to this moment, so its idle clock starts now. Without
    // this a board painted on for hours reads as hours idle the instant the room empties.
    client.canvas.lastActive = Date.now();
}

export function broadcast(canvas: Canvas, payload: Uint8Array) {
    const dead: WebSocket[] = [];
    for (const sock of canvas.clients) {
        try {
            sock.send(payload);
            metrics.framesOut += 1;
            metrics.bytesOut += payload.length;
        } catch {
            dead.push(sock);
        }
    }
    for (const d of dead) {
        removeClient(d);
    }
}


/**
 * A frame published for this canvas by any process, this one included: update the board
 * and queue it for our clients (sendPending). Every process applies the same frames in the
 * same order (Redis's), so every copy of the board ends up the same.
 */
export function applyFrame(id: string, frame: Buffer) {
    metrics.busFramesIn += 1;
    const canvas = peekResident(id);
    if (!canvas) {
        early.get(id)?.push(frame);     // still loading; applied once the board is in
        return;
    }
    applyToBoard(canvas, frame);
}

function applyToBoard(canvas: Canvas, frame: Buffer) {
    const view = viewOf(frame);
    switch (view.getUint8(0)) {
        case MSG.DELTA:
            for (const p of decodeDelta(view)) {
                const idx = index(p.x, p.y, canvas.w);
                canvas.board[idx] = p.colour;
                canvas.outgoing.set(idx, p.colour);     // last write wins, as in `dirty`
            }
            break;
        case MSG.CLEAR:
            canvas.board.fill(EMPTY);
            // Pixels painted here since the last tick came before the clear. Flushed after
            // it, they would put a few random pixels back on a blank board.
            canvas.dirty.clear();
            // Same for pixels heard but not yet sent: the clear supersedes them.
            canvas.outgoing.clear();
            canvas.clearPending = true;
            break;
    }
}

/**
 * Send our clients everything heard since the last tick: a CLEAR if there was one, then
 * one DELTA of every pixel, whichever process painted it. Called once per tick per canvas.
 */
export function sendPending(canvas: Canvas) {
    if (canvas.clearPending) {
        broadcast(canvas, encodeClear());
        canvas.clearPending = false;
    }
    if (canvas.outgoing.size === 0) return;
    metrics.sendingTicks += 1;

    const pixels: Pixel[] = [];
    for (const [idx, colour] of canvas.outgoing) {
        pixels.push({ x: idx % canvas.w, y: Math.floor(idx / canvas.w), colour });
    }
    canvas.outgoing = new Map();
    // Split on the u16 count, same reason as in the flush.
    for (let i = 0; i < pixels.length; i += MAX_DELTA_PIXELS) {
        broadcast(canvas, encodeDelta(pixels.slice(i, i + MAX_DELTA_PIXELS)));
    }
}


/** Canvas id and room code generator */
// no vowels, no 0/O/1/I/l
const ALPHABET = "23456789bcdfghjkmnpqrstvwxz";

function randomString(length: number): string {
    const bytes = randomBytes(length);
    // map each byte to alpha
    return [...bytes].map( byte => ALPHABET[byte % ALPHABET.length]).join('');
}

export const newCanvasId = () => randomString(8);

/** 6 characters: short enough to read out loud, ~387 million possibilities. */
export const newJoinCode = () => randomString(6);


/**
 * Who may enter a room. main is open to everyone, logged in or not. Every other room
 * needs an account; a private one also needs its owner or someone who has typed its code.
 */
export function canEnter(cfg: CanvasConfig, userId: number | undefined): boolean {
    if (cfg.id === MAIN_ID) return true;
    if (userId === undefined) return false;
    if (cfg.isPublic || cfg.ownerId === userId) return true;
    return isMember(userId, cfg.id);
}

/**
 * A canvas's current board for rendering, WITHOUT making it resident. The lobby asks for
 * a thumbnail of every room every few seconds; loading each one would keep every canvas
 * in memory forever while a lobby tab is open, and eviction would never fire.
 */
export async function readCanvas(id: string): Promise<Canvas | null> {
    const live = peekResident(id);
    if (live) return live;

    const cfg = getCanvasConfig(id);
    if (!cfg) return null;
    const canvas = createCanvas(cfg);
    const bytes = await loadBoard(id);
    if (bytes?.length === cfg.w * cfg.h) canvas.board.set(bytes);
    return canvas;
}



