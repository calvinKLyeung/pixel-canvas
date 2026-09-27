import { Redis } from "ioredis";
import type { Canvas } from "./canvas.js";

// Read from the environment so pointing at a container or another host is a variable
// rather than a refactor.
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const redis = new Redis(REDIS_URL);

// A connection that has subscribed can run nothing else - it refuses other commands, and
// only at the first one, long after the subscribe that caused it. So it gets its own.
const sub = new Redis(REDIS_URL);

// Namespaced from the start. A bare `board` key was fine with one canvas and is a bug
// with many, and the pub/sub channels want the same shape.
const boardKey = (id: string) => `canvas:${id}:board`;

// Keys live in one numbered database (the /5 in redis://host/5), but pub/sub channels are
// shared by the whole Redis server. Without the database in the name, a test server on /5
// and a dev server on /0 hear each other's paints and apply them to the wrong boards.
const channelPrefix = `db${redis.options.db ?? 0}:canvas`;
/** Wire frames (DELTA, CLEAR) for one canvas, exactly as clients receive them. */
const framesChannel = (id: string) => `${channelPrefix}:${id}:frames`;
/** "changed" or "deleted": a room's settings moved and every process must re-check. */
const roomChannel = (id: string) => `${channelPrefix}:${id}:room`;

/**
 * Restore a board's bytes. getBuffer, not get: ioredis decodes to a UTF-8 string by
 * default, which mangles arbitrary bytes into a board that is subtly wrong in a way that
 * looks like a rendering bug. Every command has a Buffer variant; use it for binary.
 */
export async function loadBoard(id: string): Promise<Buffer | null> {
    return redis.getBuffer(boardKey(id));
}

/**
 * Write a canvas's whole board, replacing whatever was there. Called when a board is
 * missing or the wrong length - never on a board we are about to restore.
 */
export async function writeBoard(c: Canvas): Promise<void> {
    await redis.set(boardKey(c.id), Buffer.from(c.board));
}

/** Remove a deleted canvas's board. */
export async function deleteBoard(id: string): Promise<void> {
    await redis.del(boardKey(id));
}

/**
 * Persist one tick's worth of pixels.
 *
 * Called from the flush loop rather than once per place: batching is the entire point of
 * the tick, and a pipeline puts the whole tick on the wire in one round trip instead of
 * one per pixel.
 */
export async function persistDirty(c: Canvas, dirty: Map<number, number>): Promise<void> {
    const pipe = redis.pipeline();
    for (const [idx, colour] of dirty) {
        // Buffer, not String.fromCharCode: ioredis UTF-8 encodes strings, so any colour
        // above 127 would write two bytes and shift every pixel after it.
        pipe.setrange(boardKey(c.id), idx, Buffer.from([colour]));
    }
    await pipe.exec();
}


/** ========== pub/sub: every process holding a canvas sees every change to it ========== */

export type RoomEvent = "changed" | "deleted";

/**
 * Send a frame to every process subscribed to this canvas - this one included; its own
 * clients are served by its own subscription like everyone else's.
 *
 * Same connection as persistDirty and writeBoard, deliberately: Redis runs one connection's
 * commands in order, so a frame is never published before the board write it describes.
 */
export function publishFrame(id: string, frame: Uint8Array): Promise<number> {
    return redis.publish(framesChannel(id), Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
}

export function publishRoomEvent(id: string, event: RoomEvent): Promise<number> {
    return redis.publish(roomChannel(id), event);
}

/**
 * Start receiving a canvas's frames and room events. Called for as long as the canvas is
 * resident in this process, not just while it has clients: an idle resident board still
 * serves snapshots to the next joiner, so it has to keep up.
 */
export function subscribeCanvas(id: string): Promise<unknown> {
    return sub.subscribe(framesChannel(id), roomChannel(id));
}

/**
 * Stop receiving. Called synchronously wherever a canvas leaves memory: commands on one
 * connection run in order, so an unsubscribe for an evicted canvas can never land after the
 * subscribe of a reload that follows it.
 */
export function unsubscribeCanvas(id: string): void {
    sub.unsubscribe(framesChannel(id), roomChannel(id)).catch(() => {});
}

/** Route everything the subscription receives. Called once at boot. */
export function onBusMessage(handlers: {
    frame: (id: string, frame: Buffer) => void;
    room: (id: string, event: RoomEvent) => void;
}) {
    // messageBuffer, not message: same UTF-8 trap as getBuffer - frames are binary.
    sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
        // db<n>:canvas:<id>:<kind>. Canvas ids never contain ':' (see newCanvasId).
        const [, , id, kind] = channel.toString().split(":");
        if (!id) return;
        if (kind === "frames") handlers.frame(id, message);
        else if (kind === "room") handlers.room(id, message.toString() as RoomEvent);
    });
}
