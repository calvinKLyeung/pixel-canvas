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