import Fastify from "fastify";
import WebSocket from "ws";  // for server websocket
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static";
import { join } from "node:path";


const app = Fastify()
await app.register(websocket)
await app.register(fastifyStatic, {
    root: join(import.meta.dirname, "../../public"),
});
const clients = new Set<WebSocket>();

app.get("/ws", { websocket: true }, (sock) => {
    // add socket to clients
    clients.add(sock);

    // broadcast to all clients
    sock.on("message", (data) => {
        for (const client of clients) {
            client.send(data.toString());
        }


        console.log(`currently there are ${clients.size} of clients connected`)
    });

    // sock.on("ping", (data) => {
    //     console.log(data.toString());
    //     console.log(`currently there are ${clients.size} of clients connected`);
    // })

    // close socket

    sock.on("close", () => {
        clients.delete(sock);
        console.log(`client size after closing client socket, we now have ${clients.size} connections`);
    });
});

await app.listen({ port: 8000, host: "0.0.0.0" });