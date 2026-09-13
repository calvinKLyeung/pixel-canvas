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


## Wire protocol

All multi-byte integers are little-endian.
Every message begins with a u8 type tag.

Type ids 4 (REJECTED), 5 (CLEAR) and 6 (PRESENCE) are reserved and unused so far.

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