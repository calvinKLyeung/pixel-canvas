import Fastify from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import { join } from "node:path";


const PORT = Number(process.env.PORT ?? 8000);

const app = Fastify({ logger: true });


await app.register(fastifyStatic, {
    root: join(process.cwd(), "public"),
});
await app.register(websocket);

/** All currently connected browsers */
const clients = new Set<WebSocket>();

app.get("/ws", { websocket: true }, (sock: WebSocket) => {
    // add socket to clients
    clients.add(sock);
    app.log.info(`connected - now have ${clients.size} websockets in total`);

    // broadcast to all clients
    sock.on("message", (data: Buffer) => {
        // turn Raw Buffer data to string 
        const text = data.toString();
        for (const client of clients) {
            client.send(text);
        }
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

await app.listen({ port: PORT, host: "0.0.0.0" });