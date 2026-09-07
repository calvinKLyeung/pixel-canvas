import Fastify from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import { join } from "node:path";

import { W, H, index} from "../shared/constants.js";
import { PALETTE_SIZE } from "../shared/palette.js";
import { board } from "./board.js";
import { dirty, markDirty, TICK_HZ, startTicker } from "./hub.js";

import { deflateSync } from "node:zlib";
import { MSG } from "../shared/protocols.js";

const PORT = Number(process.env.PORT ?? 8000);

const app = Fastify({ logger: true });

/** Always First */
await app.register(fastifyStatic, {
    root: join(process.cwd(), "public"),
});
await app.register(websocket);

/** All currently connected browsers */
const clients = new Set<WebSocket>();

app.get("/ws", { websocket: true }, (sock: WebSocket) => {
    // add socket to clients
    clients.add(sock);
    // sock.send(JSON.stringify({ t: "snapshot", board: Array.from(board) }));
    sock.send(encodeSnapshot());
    app.log.info(`connected - now have ${clients.size} websockets in total`);


    // broadcast to all clients
    sock.on("message", (data: Buffer) => {
        // bytes -> text -> value.  Bail if the text isn't valid JSON.
        let msg: unknown;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return; // unknown format of data
        }

        // valid JSON can still be null, a number or a string - none have fields
        if (typeof msg !== "object" || msg === null) return;

        // cast to make it inspectable. Now  can read legally
        const msgRecord = msg as Record<string, unknown>;
        if (msgRecord.t !== "place") return;

        // pull out the data
        const {x, y, c} = msgRecord as {x: unknown, y: unknown, c:unknown};
        // verify type and within bound
        if (!Number.isInteger(x) || (x as number) < 0 || (x as number >= W)) return;
        if (!Number.isInteger(y) || (y as number) < 0 || (y as number >= H)) return;
        if (!Number.isInteger(c) || (c as number) < 0 || (c as number >= PALETTE_SIZE)) return;

        // finally safe to access the board lol
        // update target location with colour index
        board[index(x as number, y as number)] = c as number;

        // // broadcast clients about the update
        // const out = JSON.stringify({ t: "place", x, y, c});
        // for (const client of clients) {
        //     client.send(out);
        // }
        markDirty(index(x as number, y as number), c as number);
    });

    sock.on("close", () => {
        clients.delete(sock);
        app.log.info(`disconnected - now have ${clients.size} websockets total`);
    });

    sock.on("error", (err) => {
        app.log.error(err);
        clients.delete(sock);
    })
});



/** ========== flush ========== */
function flush(): void {
    if (dirty.size == 0) return;

    const changes = [...dirty.entries()].map(([idx, c]) => ({
        x: idx % W,
        y: Math.floor(idx / W),
        c,
    }));
    dirty.clear();  // empty the map

    const payload = JSON.stringify({ t: "delta", changes }) // batched changes

    // record failed batch update broadcast
    const dead: WebSocket[] = [];
    for (const client of clients) {
        try{
            client.send(payload);
        } catch {
            dead.push(client);
        }
    }

    // always remove AFTER marked dead, not during dead
    for (const d of dead) {
        clients.delete(d);
    }
}


/** should run once after everything is wired up */
app.addHook("onReady", async () => {
    startTicker(flush);
    app.log.info(`ticking at ${TICK_HZ}Hz`);
})

// build the snapshot of the board with header and compressed board data
function encodeSnapshot(): Buffer {
    const header = Buffer.alloc(5);     // need 5 bytes
    header.writeUInt8(MSG.SNAPSHOT, 0); // byte 0    8  bits
    header.writeUInt16LE(W, 1);         // byte 1-2  16 bits
    header.writeUInt16LE(H, 3);         // byte 3-4  16 bits
    return Buffer.concat([header, deflateSync(board)]);
}







/** Always Last */
await app.listen({ port: PORT, host: "0.0.0.0" });