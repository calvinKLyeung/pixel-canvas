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
 */
// type def
type MsgShape = {
    readonly PLACE:    1;
    readonly DELTA:    2;
    readonly SNAPSHOT: 3;
};

// runtime values
export const MSG: MsgShape = {
    PLACE:    1,
    DELTA:    2,
    SNAPSHOT: 3,
};

// our sum type build from the defined obj of MSG
export type MsgType = MsgShape[keyof MsgShape]; // === export type MsgType = 1 | 2 | 3;

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
export function encodePlace(pixel: Pixel): Uint8Array {
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
export function encodeDelta(pixels: Pixel[]): Uint8Array {
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
