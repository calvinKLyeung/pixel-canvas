/**
 * Define wire format
 * Every message must start with u8 type tag
 * multi-byte integers are stored in Little-Endian (no reason, randomly picked lol)
 *
 *   SNAPSHOT (server -> client) to send the latest snapshot of the board
 *      u8   type = 3
 *      u16  width
 *      u16  height
 *      ... zlib deflated board of bytes, one per pixel
 *
 *   REJECTED (server -> client) a placement was refused by the cooldown
 *      u8   type = 4
 *      u16  waitMs   milliseconds until the next paint, capped at 65535
 *
 *   CLEAR (server -> client) the whole board is now EMPTY
 *      u8   type = 5
 */
// type def
// 6 is claimed but nothing sends it yet. Milestone 08's event log
// stamps every entry with one of these ids and is append-only, so settling the
// numbering before the log exists is free - renumbering afterwards is not.
type MsgShape = {
    readonly PLACE:    1;
    readonly DELTA:    2;
    readonly SNAPSHOT: 3;
    readonly REJECTED: 4;  // 05,  cooldown refusal
    readonly CLEAR:    5;  // 05c, owner canvas reset
    readonly PRESENCE: 6;  // optional, connected-user count
};

// runtime values
export const MSG: MsgShape = {
    PLACE:    1,
    DELTA:    2,
    SNAPSHOT: 3,
    REJECTED: 4,
    CLEAR:    5,
    PRESENCE: 6,
};

// our sum type build from the defined obj of MSG
export type MsgType = MsgShape[keyof MsgShape]; // === export type MsgType = 1 | 2 | ... | 6;

/**
 * Most pixels one DELTA can carry, because the count at offset 1 is a u16.
 * A 512x512 canvas has 262,144 cells and `dirty` is keyed by board index, so one tick
 * can hold more than this. Overflowing wraps the count silently - the frame still
 * carries every pixel, but the client reads a short count and drops the rest with no
 * error anywhere. The flush splits into this many at a time instead.
 */
export const MAX_DELTA_PIXELS = 65535;

/**
 * Building DataView to interpret the bytes, from the container they arrive in
 *
 * find and view out target bytes from the Node Buffer buf.buffer pool of data
 *
 * Browser receives data from ArrayBuffer
 * Server receives data from Buffer where
 * Node sock.on("message") gives Buffer which extends Uint8Array */
export function viewOf(data: ArrayBuffer | Uint8Array): DataView {
    return data instanceof Uint8Array
        // unwrap the window
        ? new DataView(data.buffer, data.byteOffset, data.byteLength)
        // as is
        : new DataView(data);
}

/** ========== for encoding Place pixel ========== */
export interface Pixel {
    x: number;
    y: number;
    colour: number;
}

/**Using Uint8Array because this file and code is imported by browser code, where no Buffer exists*/
/** PLACE pixel: client -> server, 6 bytes of info */
export function encodePlace(pixel: Pixel): Uint8Array<ArrayBuffer> {
    const buff = new Uint8Array(6);
    const view = new DataView(buff.buffer);
    view.setUint8(0, MSG.PLACE);
    view.setUint16(1, pixel.x, true);
    view.setUint16(3, pixel.y, true);
    view.setUint8(5, pixel.colour);
    return buff;
}

export function decodePlace(view: DataView): Pixel {
    return {
        x: view.getUint16(1, true),
        y: view.getUint16(3, true),
        colour: view.getUint8(5),
    };
}

/** DELTA of pixel: server -> client, 3 + 5n bytes of info, where n = number of pixels  */
export function encodeDelta(pixels: Pixel[]): Uint8Array<ArrayBuffer> {
    const buff = new Uint8Array(3 + 5 * pixels.length);
    const view = new DataView(buff.buffer);
    view.setUint8(0, MSG.DELTA);
    view.setUint16(1, pixels.length, true);

    let off = 3;
    for (const pixel of pixels) {
        view.setUint16(off, pixel.x, true);
        view.setUint16(off + 2, pixel.y, true);
        view.setUint8(off + 4, pixel.colour);
        off += 5; // next pixel
    }
    return buff;
}

export function decodeDelta(view: DataView): Pixel[] {
    const n = view.getUint16(1, true);
    const out: Pixel[] = new Array(n);
    let off = 3;
    for (let i = 0; i < n; i++) {
        out[i] = {
            x: view.getUint16(off, true),
            y: view.getUint16(off + 2, true),
            colour: view.getUint8(off + 4),
        };
        off += 5; // next pixel
    }
    return out;
}

/** ========== REJECTED: server -> client, 3 bytes ========== */
export const MAX_WAIT_MS = 65535;

export function encodeRejected(waitMs: number): Uint8Array {
    const buff = new Uint8Array(3);
    const view = new DataView(buff.buffer);
    view.setUint8(0, MSG.REJECTED);
    // setUint16 does not throw on 70000 - it wraps to 4464, and the client would show a
    // 4 second wait for a 70 second cooldown. Clamp before writing any fixed-width int.
    view.setUint16(1, Math.min(waitMs, MAX_WAIT_MS), true);
    return buff;
}

export function decodeRejected(view: DataView): number {
    return view.getUint16(1, true);
}

/**
 * ========== CLEAR: server -> client, 1 byte ==========
 * "Everything is EMPTY" needs no coordinates. As a delta the same news would be 5 bytes
 * per pixel - 327 KB for a 256x256 board, sent to every client.
 */
export function encodeClear(): Uint8Array {
    return new Uint8Array([MSG.CLEAR]);
}
