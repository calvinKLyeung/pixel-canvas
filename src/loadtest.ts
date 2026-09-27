import WebSocket from "ws";
import { PALETTE_SIZE } from "./shared/palette.js";
import { encodePlace, MSG } from "./shared/protocols.js";

/**
 * Load generator. Every setting comes from the environment:
 *
 *   URL        server base(s), comma separated; bots are spread round robin across them
 *              (default http://localhost:8000; ws:// and a trailing /ws are accepted too)
 *   BOTS       how many sockets (default 200)
 *   RAMP_MS    spread the connects over this long (default 10000)
 *   PERIOD     average ms between one bot's paints (default 1000)
 *   CANVASES   canvas ids, comma separated, bots spread round robin (default main).
 *              `new` or `new:64x64` makes a fresh public room for this run, deleted at the end.
 *   ACCOUNTS   bot accounts to share out when any canvas needs a login (default 10)
 *   DURATION_MS stop after this long and print averages; unset runs until Ctrl+C
 *   PROTOCOL   `json` to load the milestone-01 naive server instead
 *
 * It imports the same shared/protocols.ts as the real client, so it cannot drift from the
 * wire format - a protocol change breaks it at compile time.
 */
const BASES = (process.env.URL ?? "http://localhost:8000").split(",")
    .map(u => u.trim().replace(/^ws/, "http").replace(/\/ws$/, "").replace(/\/$/, ""));
const BOTS = Number(process.env.BOTS ?? 200);
const RAMP_MS = Number(process.env.RAMP_MS ?? 10_000);
const PERIOD = Number(process.env.PERIOD ?? 1000);
const CANVASES = (process.env.CANVASES ?? "main").split(",");
const ACCOUNTS = Number(process.env.ACCOUNTS ?? 10);
const DURATION_MS = Number(process.env.DURATION_MS ?? 0);
const JSON_MODE = process.env.PROTOCOL === "json";

const httpBase = BASES[0]!;
const wsUrl = (base: string, canvas: string) =>
    `${base.replace(/^http/, "ws")}/ws` + (JSON_MODE ? "" : `?c=${encodeURIComponent(canvas)}`);

/** Unique per run, so repeated runs never collide on bot names. */
const RUN = Math.random().toString(36).slice(2, 8);


/**========== accounts and rooms ==========*/

async function register(name: string): Promise<string> {
    const reply = await fetch(`${httpBase}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password: "loadtest-bot" }),
    });
    if (!reply.ok) throw new Error(`register ${name}: ${reply.status} ${await reply.text()}`);
    return reply.headers.get("set-cookie")!.split(";")[0]!;
}

/** Rooms this run made, with the owner's cookie, so they can be deleted at the end. */
const created: { id: string; cookie: string }[] = [];

/** `new` / `new:WxH` -> a fresh public room. One account per room: one room per owner. */
async function makeRoom(spec: string, k: number): Promise<string> {
    const [w, h] = (spec.split(":")[1] ?? "256x256").split("x").map(Number);
    // Numbered by position, not by created.length: the rooms are made in parallel, so
    // every call would read the same length and pick the same name.
    const cookie = await register(`bot_${RUN}_r${k}`);
    const reply = await fetch(`${httpBase}/api/canvas`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ name: `loadtest ${RUN}`, w, h, isPublic: true }),
    });
    if (!reply.ok) throw new Error(`create room: ${reply.status} ${await reply.text()}`);
    const { id } = await reply.json() as { id: string };
    created.push({ id, cookie });
    return id;
}

async function cleanUp() {
    for (const { id, cookie } of created) {
        await fetch(`${httpBase}/api/c/${id}`, { method: "DELETE", headers: { cookie } }).catch(() => {});
    }
}


/**========== bots ==========*/

let connected = 0, sent = 0, framesIn = 0, bytesIn = 0, snapshotBytes = 0, failed = 0;

async function bot(i: number, canvas: string, cookie: string | undefined) {
    // Spread connections over RAMP_MS. Opening 2,000 sockets in one tick measures the
    // connect handler, not the steady state.
    await new Promise(r => setTimeout(r, (i / BOTS) * RAMP_MS));

    const base = BASES[i % BASES.length]!;
    const ws = new WebSocket(wsUrl(base, canvas), { headers: cookie ? { cookie } : {} });

    let w = 0, h = 0, open = false;
    ws.on("open", () => { open = true; connected++; });
    ws.on("close", () => { if (open) connected--; });
    ws.on("error", () => { failed++; });
    ws.on("message", (data: Buffer) => {
        // The first message is the snapshot and tells us the board size. Assuming a size
        // would put most places out of bounds on a smaller board, dropped without a trace.
        if (!w) {
            snapshotBytes = data.length;
            if (JSON_MODE) {
                const side = Math.sqrt((JSON.parse(data.toString()) as { board: number[] }).board.length);
                w = h = side;
            } else if (data[0] === MSG.SNAPSHOT) {
                w = data.readUInt16LE(1);
                h = data.readUInt16LE(3);
            }
            if (w) paintForever();
            return;
        }
        framesIn++;
        bytesIn += data.length;
    });

    function paintForever() {
        setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const x = Math.floor(Math.random() * w);
            const y = Math.floor(Math.random() * h);
            const colour = Math.floor(Math.random() * PALETTE_SIZE);
            ws.send(JSON_MODE ? JSON.stringify({ t: "place", x, y, c: colour }) : encodePlace({ x, y, colour }));
            sent++;
        }, PERIOD * (0.5 + Math.random()));    // average PERIOD, jittered so bots don't sync up
    }
}


/**========== reporting ==========*/

// Past a few hundred bots, one Node process can spend more time generating load than the
// server spends handling it - and then the "ceiling" is this laptop's, not the server's.
// Near 100% here means: run more generator processes, or move them to another machine.
let cpuMark = process.cpuUsage();
const totals = { seconds: 0, sent: 0, framesIn: 0, bytesIn: 0, cpu: 0 };
const started = Date.now();

setInterval(() => {
    const cpu = process.cpuUsage(cpuMark);
    cpuMark = process.cpuUsage();
    const cpuPct = (cpu.user + cpu.system) / 1e4;       // µs per 1s -> %
    console.log(
        `t=${Math.round((Date.now() - started) / 1000)}s conn=${connected} sent/s=${sent} ` +
        `frames-in/s=${framesIn} in=${(bytesIn / 1024).toFixed(1)}KB/s ` +
        `generator-cpu=${cpuPct.toFixed(0)}%` + (failed ? ` failed=${failed}` : ""));

    // Averages only once everyone is connected, so the ramp does not drag them down.
    if (Date.now() - started > RAMP_MS + 2000) {
        totals.seconds++;
        totals.sent += sent;
        totals.framesIn += framesIn;
        totals.bytesIn += bytesIn;
        totals.cpu += cpuPct;
    }
    sent = framesIn = bytesIn = 0;
}, 1000);

async function finish() {
    const n = Math.max(totals.seconds, 1);
    console.log(`\nSUMMARY bots=${BOTS} connected=${connected} failed=${failed} canvases=${CANVASES.join(",")} ` +
        `sent/s=${Math.round(totals.sent / n)} frames-in/s=${Math.round(totals.framesIn / n)} ` +
        `in=${(totals.bytesIn / n / 1024).toFixed(1)}KB/s snapshot=${snapshotBytes}B ` +
        `generator-cpu=${Math.round(totals.cpu / n)}% (averaged over ${totals.seconds}s after the ramp)`);
    await cleanUp();
    process.exit(0);
}
process.on("SIGINT", finish);
if (DURATION_MS) setTimeout(finish, DURATION_MS);


/**========== start ==========*/

// Rooms and accounts are made up front: registering runs argon2, which is slow on purpose,
// and doing it during the ramp would measure password hashing instead of painting.
const canvases = JSON_MODE ? ["naive"] : await Promise.all(
    CANVASES.map((c, k) => (c.startsWith("new") ? makeRoom(c, k) : c)));

const needAccounts = !JSON_MODE && canvases.some(c => c !== "main");
const cookies = needAccounts
    ? await Promise.all(Array.from({ length: ACCOUNTS }, (_, k) => register(`bot_${RUN}_${k}`)))
    : [];

for (let i = 0; i < BOTS; i++) {
    void bot(i, canvases[i % canvases.length]!, cookies[i % Math.max(cookies.length, 1)]);
}
console.log(`${BOTS} bots ramping over ${RAMP_MS}ms onto ${canvases.join(", ")} via ${BASES.join(", ")}`);
