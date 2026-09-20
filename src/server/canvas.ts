import type { WebSocket} from "ws";
import { EMPTY } from "../shared/palette.js"
import { randomBytes } from "node:crypto";
import { getCanvasConfig } from "./db.js";

/** The permanent landing canvas. Never created through the API, never evicted. */
export const MAIN_ID = "main";

// mainly for SQL in the future
export interface CanvasConfig {
    id: string;
    name: string;
    w: number;
    h: number;
    cooldownMs: number;
    ownerId: number | null;  // null for main
    isPublic: boolean;
    createdAt: number;
}

// Config + runtime canvas state
export interface Canvas extends CanvasConfig {
    board: Uint8Array;
    dirty: Map<number, number>;
    clients: Set<WebSocket>;
    lastActive: number;  // prepare for eviction
}

export function createCanvas(cfg: CanvasConfig): Canvas {
    return {
        ...cfg,
        board: new Uint8Array(cfg.w * cfg.h).fill(EMPTY),
        dirty: new Map(),
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


/** Loads currently in progress, keyed by canvas id. See loadCanvas. */
const loading = new Map<string, Promise<Canvas | null>>();

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

        const canvas = createCanvas(cfg);
        // 04b.10 restores the board bytes from Redis here. Blank until then.
        putResident(canvas);
        return canvas;
    })().finally(() => loading.delete(id));

    loading.set(id, load);
    return load;
}


/** new client , serves as reference to socket, canvas, bucket, userId*/
export interface Client {
    sock: WebSocket;
    canvas: Canvas;
    // bucket: Bucket;
    userId?: number;
}

// Still keyed by socket for O(1) removal on disconnect
// but now each canvas also tracks its own set for broadcasting
const clients = new Map<WebSocket, Client>();

export function addClient(sock: WebSocket, canvas: Canvas) {
    // Client canvas and Canvas client reference each other, must add together
    clients.set(sock, { sock, canvas });
    canvas.clients.add(sock);
}

export function removeClient(sock: WebSocket) {
    const client = clients.get(sock);
    if (!client) return; // not exist, some hot client is gone already
    // Client canvas and Canvas client reference each other, must remove together
    client.canvas.clients.delete(sock);
    clients.delete(sock);
}

export function broadcast(canvas: Canvas, payload: Uint8Array) {
    const dead: WebSocket[] = [];
    for (const sock of canvas.clients) {
        try {
            sock.send(payload);
        } catch {
            dead.push(sock);
        }
    }
    for (const d of dead) {
        removeClient(d);
    }
}


/** Canvas id generator */
// no vowels, no 0/O/1/I/l
const ALPHABET = "23456789bcdfghjkmnpqrstvwxz";

export function newCanvasId(): string {
    const bytes = randomBytes(8);  // 8 bytes
    // map each byte to alpha
    return [...bytes].map( byte => ALPHABET[byte % ALPHABET.length]).join('');
}



