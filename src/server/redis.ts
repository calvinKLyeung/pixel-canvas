import { Redis } from "ioredis";
import type { Canvas } from "./canvas.js";

// Read from the environment so pointing at a container or another host is a variable
// rather than a refactor.
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");

// Namespaced from the start. A bare `board` key was fine with one canvas and is a bug
// with many, and the pub/sub channels will want the same shape.
const boardKey = (id: string) => `canvas:${id}:board`;

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
