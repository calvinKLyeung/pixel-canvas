/**
 * Fold a canvas's event log into a board and compare it with the board in Redis.
 *
 *   npm run rebuild -- <canvas id>            compare only
 *   npm run rebuild -- <canvas id> --write    also replace the Redis board with the rebuild
 *
 * Reads the same REDIS_URL and DB_PATH as the server. Stop the server before --write on a
 * canvas it holds: its in-memory board would keep painting over whatever this writes.
 */
import { getCanvasConfig } from "../server/db.js";
import { rebuildBoard, createCanvas } from "../server/canvas.js";
import { loadBoard, writeBoard, closeRedis } from "../server/redis.js";

const [id, flag] = process.argv.slice(2);
if (!id) {
    console.error("usage: npm run rebuild -- <canvas id> [--write]");
    process.exit(1);
}

const cfg = getCanvasConfig(id);
if (!cfg) {
    console.error(`no such canvas: ${id}`);
    process.exit(1);
}

const t0 = performance.now();
const board = await rebuildBoard(cfg);
const ms = performance.now() - t0;

const live = await loadBoard(id);
const match = live !== null && Buffer.compare(Buffer.from(board), live) === 0;
console.log(`rebuilt ${id} (${cfg.w}x${cfg.h}) from its log in ${ms.toFixed(0)} ms`);
console.log(live === null ? "no board in Redis" : `match: ${match}`);

if (flag === "--write") {
    const canvas = createCanvas(cfg);
    canvas.board.set(board);
    await writeBoard(canvas);
    console.log("wrote the rebuilt board to Redis");
}

await closeRedis();
