import type { WebSocket} from "ws";
import { EMPTY } from "../shared/palette.js"

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

export function putResident(c: Canvas) {
    resident.set(c.id, c);
}

export function allResident(): Iterable<Canvas> {
    return resident.values();
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



