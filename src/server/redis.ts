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
/**
 * Every frame ever published for a canvas, in order - the source of truth. The board key
 * is a fold over this stream, kept so a join does not have to replay the whole history.
 */
export const eventsKey = (id: string) => `canvas:${id}:events`;
/** A game room's state, as JSON. See gameRoom.ts. */
const gameKey = (id: string) => `canvas:${id}:game`;
const gameLockKey = (id: string) => `canvas:${id}:game:lock`;

const asBuffer = (frame: Uint8Array) => Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);

// Keys live in one numbered database (the /5 in redis://host/5), but pub/sub channels are
// shared by the whole Redis server. Without the database in the name, a test server on /5
// and a dev server on /0 hear each other's paints and apply them to the wrong boards.
const channelPrefix = `db${redis.options.db ?? 0}:canvas`;
/** Wire frames (DELTA, CLEAR) for one canvas, exactly as clients receive them. */
const framesChannel = (id: string) => `${channelPrefix}:${id}:frames`;
/** "changed" or "deleted": a room's settings moved and every process must re-check. */
const roomChannel = (id: string) => `${channelPrefix}:${id}:room`;
/** A game room's new state, as JSON, after every change that players can see. */
const gameChannel = (id: string) => `${channelPrefix}:${id}:game`;

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
 * Blank a canvas's board and log the CLEAR, together. Logged as one marker rather than as
 * w*h erases, and never by trimming the stream: the clear is an event in the history, not
 * the end of it.
 */
export async function clearBoard(c: Canvas, clear: Uint8Array): Promise<void> {
    await redis.multi()
        .set(boardKey(c.id), Buffer.from(c.board))
        .xadd(eventsKey(c.id), "*", "f", asBuffer(clear))
        .exec();
}

/** Remove a deleted canvas's board and its history - nothing can open it again. */
export async function deleteBoard(id: string): Promise<void> {
    await redis.del(boardKey(id), eventsKey(id), gameKey(id));
}

/**
 * Persist one tick's worth of pixels: the board bytes, and the frames that describe them
 * appended to the log.
 *
 * Called from the flush loop rather than once per place: batching is the entire point of
 * the tick, and one transaction puts the whole tick on the wire in one round trip.
 *
 * MULTI rather than a plain pipeline because with several processes, a pipeline's commands
 * can interleave with another process's clearBoard: its SET could land between our
 * SETRANGEs and our XADD, and the log would say the pixels came after the clear while the
 * board says before. In one transaction the board and the log always agree on the order.
 */
export async function persistDirty(c: Canvas, dirty: Map<number, number>, frames: Uint8Array[]): Promise<void> {
    const tx = redis.multi();
    for (const [idx, colour] of dirty) {
        // Buffer, not String.fromCharCode: ioredis UTF-8 encodes strings, so any colour
        // above 127 would write two bytes and shift every pixel after it.
        tx.setrange(boardKey(c.id), idx, Buffer.from([colour]));
    }
    for (const frame of frames) tx.xadd(eventsKey(c.id), "*", "f", asBuffer(frame));
    await tx.exec();
}

/**
 * A canvas's logged frames, oldest first, read a page at a time so a long history is never
 * one giant reply. The stream id holds the append time, should anything want it.
 */
export async function* readEvents(id: string): AsyncGenerator<Buffer> {
    let start = "-";
    for (;;) {
        const page = await redis.xrangeBuffer(eventsKey(id), start, "+", "COUNT", 1000);
        if (page.length === 0) return;
        for (const [, fields] of page) {
            if (fields[1]) yield fields[1];       // fields = ["f", frame]
        }
        start = `(${page.at(-1)![0].toString()}`;  // exclusive: after the last one read
    }
}

/** ========== game rooms ========== */

export async function loadGame(id: string): Promise<string | null> {
    return redis.get(gameKey(id));
}

export async function saveGame(id: string, json: string): Promise<void> {
    await redis.set(gameKey(id), json);
}

/** Long enough for any read-change-write; short enough that a crashed holder is soon forgotten. */
const LOCK_MS = 3_000;
const LOCK_WAIT_MS = 25;

// Delete the lock only if it is still ours: past LOCK_MS it may have expired and been
// taken by someone else, and a plain DEL would release their lock.
const UNLOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Run `fn` holding a game room's lock, so two processes changing one game never both read
 * the same state and one silently overwrites the other. WATCH/MULTI would do it without a
 * lock, but WATCH belongs to a connection and every request shares this one.
 */
export async function withGameLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const token = Math.random().toString(36).slice(2);
    const giveUpAt = Date.now() + LOCK_MS;
    while (await redis.set(gameLockKey(id), token, "PX", LOCK_MS, "NX") !== "OK") {
        if (Date.now() > giveUpAt) throw new Error(`game ${id} stayed locked`);
        await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_MS));
    }
    try {
        return await fn();
    } finally {
        await redis.eval(UNLOCK, 1, gameLockKey(id), token);
    }
}

export function publishGame(id: string, json: string): Promise<number> {
    return redis.publish(gameChannel(id), json);
}


/**
 * Count one word request against today's allowance, for this user and for the whole server.
 * In Redis so every process shares one count. Keys carry the UTC date and expire after two
 * days, so yesterday's count never needs resetting.
 */
export async function countWordRequest(userId: number): Promise<{ user: number; total: number }> {
    const day = new Date().toISOString().slice(0, 10);
    const userKey = `words:${day}:user:${userId}`, totalKey = `words:${day}:total`;
    const replies = await redis.multi()
        .incr(userKey).expire(userKey, 2 * 86400)
        .incr(totalKey).expire(totalKey, 2 * 86400)
        .exec();
    return { user: replies![0]![1] as number, total: replies![2]![1] as number };
}


/** Close both connections, so a script can exit. The server never calls this. */
export async function closeRedis(): Promise<void> {
    await Promise.all([redis.quit(), sub.quit()]);
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
    return redis.publish(framesChannel(id), asBuffer(frame));
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
    return sub.subscribe(framesChannel(id), roomChannel(id), gameChannel(id));
}

/**
 * Stop receiving. Called synchronously wherever a canvas leaves memory: commands on one
 * connection run in order, so an unsubscribe for an evicted canvas can never land after the
 * subscribe of a reload that follows it.
 */
export function unsubscribeCanvas(id: string): void {
    sub.unsubscribe(framesChannel(id), roomChannel(id), gameChannel(id)).catch(() => {});
}

/** Route everything the subscription receives. Called once at boot. */
export function onBusMessage(handlers: {
    frame: (id: string, frame: Buffer) => void;
    room: (id: string, event: RoomEvent) => void;
    game: (id: string, json: string) => void;
}) {
    // messageBuffer, not message: same UTF-8 trap as getBuffer - frames are binary.
    sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
        // db<n>:canvas:<id>:<kind>. Canvas ids never contain ':' (see newCanvasId).
        const [, , id, kind] = channel.toString().split(":");
        if (!id) return;
        if (kind === "frames") handlers.frame(id, message);
        else if (kind === "room") handlers.room(id, message.toString() as RoomEvent);
        else if (kind === "game") handlers.game(id, message.toString());
    });
}
