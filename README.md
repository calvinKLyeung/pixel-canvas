# pixel-canvas

## Running locally

```bash
npm install
npx vitest
npm run build:client
npm run watch:client   # terminal 1 — bundles src/client -> public/main.js, rebuilds on save
npm run dev            # terminal 2 — server on http://localhost:8000

npm run loadtest             # 20 bots by default
BOTS=50 npm run loadtest     # override bot count
URL=ws://localhost:8000/ws BOTS=50 npm run loadtest
```

Open http://localhost:8000.

Two terminals because `npm run dev` only watches the server. Use `npm run
build:client` instead for a one-shot bundle without the watcher.


## Storage tiers

| Tier   | Holds | Lost on |
|--------|-------|---------|
| memory | resident canvases, per process | restart — by design |
| Redis  | `canvas:<id>:board` — current board bytes | nothing: **derived**, rebuilt from the log |
| Redis  | `canvas:<id>:events` — every DELTA and CLEAR frame ever published, in order | **source of truth** |
| SQLite | users, sessions, canvas configs, memberships | — (needs a volume when deployed) |

Each flush writes the board bytes and appends its frames to the log in one `MULTI`,
so with several processes the board and the log always agree on the order. A clear is
logged as one CLEAR frame, never by trimming the log. When a canvas is loaded and its
board key is missing, the board is rebuilt from the log.

```bash
npm run rebuild -- main            # fold the log, compare with the board in Redis
npm run rebuild -- main --write    # ...and replace the board with the rebuild
```

Stop the server before `--write` on a canvas it holds, or its in-memory board keeps
painting over the result.


## Deploying (Railway)

The image builds the client and runs the server with `tsx`. Test it locally first:

```bash
docker build -t pixelcanvas .
docker run -p 8000:8000 -v pc-data:/data -e DB_PATH=/data/canvas.db \
  -e REDIS_URL=redis://host.docker.internal:6379 pixelcanvas
```

| Variable    | Railway value | Default |
|-------------|---------------|---------|
| `PORT`      | set by Railway | 8000 |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | `redis://127.0.0.1:6379` (a `/n` suffix picks the database) |
| `DB_PATH`   | `/data/canvas.db`, on a volume mounted at `/data` | `pixel-canvas.db` in the project root |
| `NODE_ENV`  | `production` (set in the image) — turns on the `Secure` cookie | — |

Without the volume, every deploy wipes accounts and rooms. The event log lives in
Redis, so it is only as durable as Redis's persistence setting.


## Wire protocol

All multi-byte integers are little-endian.
Every message begins with a u8 type tag.

Type ids 4 (REJECTED) and 6 (PRESENCE) are reserved and unused so far.
5 (CLEAR, server → client) is a single byte: the whole board is now empty.

The event log stores DELTA and CLEAR frames byte for byte as clients receive them,
so these ids are part of the storage format as well as the wire format.

Close codes: 4001 log in first, 4003 private room, 4004 no such canvas,
4029 too many messages. The client does not reconnect after any of these.

### 1 — PLACE   (client → server)   6 bytes
| offset | type | field  | notes                                  |
|--------|------|--------|----------------------------------------|
| 0      | u8   | type   | always 1                               |
| 1      | u16  | x      | 0..canvas width - 1  (MAX_DIM is 512)  |
| 3      | u16  | y      | 0..canvas height - 1 (MAX_DIM is 512)  |
| 5      | u8   | colour | palette index 0-15                     |

Each canvas has its own dimensions, so the server validates x and y against the
canvas the socket joined, not against a global constant.

### 2 — DELTA   (server → client)   3 + 5n bytes
| offset  | type | field  |
|---------|------|--------|
| 0       | u8   | type = 2 |
| 1       | u16  | count = n, at most 65,535 — bigger ticks split across frames |
| 3 + 5i  | u16  | x of pixel i |
| 5 + 5i  | u16  | y of pixel i |
| 7 + 5i  | u8   | colour of pixel i |

### 3 — SNAPSHOT   (server → client)   5 + compressed
| offset | type | field |
|--------|------|-------|
| 0      | u8   | type = 3 |
| 1      | u16  | width |
| 3      | u16  | height |
| 5..    | —    | zlib-deflated board, one byte per pixel |