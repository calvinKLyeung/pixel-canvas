import type { WebSocket } from "ws";
import { type Canvas, type Client, clientOf, clearCanvas, peekResident, allResident } from "./canvas.js";
import { loadGame, saveGame, withGameLock, publishGame } from "./redis.js";
import { step, newGame, viewFor, SPARE_WORDS, type GameState, type GameAction, type StepResult } from "./game.js";
import { makeWords } from "./words.js";
import type { GameRequest, GameError, Team } from "../shared/game.js";

/**
 * Paint and guess rooms, across processes. The state lives in Redis and changes only
 * inside withGameLock, through step() - so however many processes serve a room, each
 * change starts from the one before it. Every change players can see is published, and
 * each process keeps the latest copy (`mirrors`) to answer "may this socket paint?" per
 * pixel without asking Redis.
 */

/** As stored and published: `v` counts changes, so an older copy never replaces a newer one. */
interface Stored {
    v: number;
    s: GameState;
}

const mirrors = new Map<string, Stored>();

/** How often each process vouches for its players and lets the round clock run out. */
export const HEARTBEAT_MS = 1_000;

/** The state as players see it. seenAt changes every heartbeat; nothing else need go out then. */
const visible = (s: GameState) => JSON.stringify(s, (k, v) => (k === "seenAt" ? undefined : v));

async function read(id: string): Promise<Stored> {
    const json = await loadGame(id);
    return json ? JSON.parse(json) as Stored : { v: 0, s: newGame() };
}

/** Apply one action to a room's game. Wipes the board when a round starts. */
async function act(canvas: Canvas, action: GameAction): Promise<StepResult> {
    return withGameLock(canvas.id, async () => {
        const before = await read(canvas.id);
        const result = step(before.s, action, Date.now());
        if (result.error) return result;

        const after: Stored = { v: before.v + 1, s: result.state };
        const json = JSON.stringify(after);
        await saveGame(canvas.id, json);
        if (visible(after.s) !== visible(before.s)) await publishGame(canvas.id, json);
        // Inside the lock, so the next round's first strokes can never land before the wipe.
        if (result.clearBoard) await clearCanvas(canvas);
        return result;
    });
}

/** A state from the bus, published by any process (this one included). */
export function onGameMessage(id: string, json: string) {
    const canvas = peekResident(id);
    if (!canvas) return;
    const next = JSON.parse(json) as Stored;
    if ((mirrors.get(id)?.v ?? -1) >= next.v) return;
    mirrors.set(id, next);
    for (const sock of canvas.clients) sendView(sock, next.s);
}

function sendView(sock: WebSocket, s: GameState) {
    const userId = clientOf(sock)?.userId;
    if (userId === undefined) return;
    sock.send(JSON.stringify(viewFor(s, userId, Date.now())));
}

function sendError(sock: WebSocket, error: string) {
    const msg: GameError = { t: "error", error };
    sock.send(JSON.stringify(msg));
}

/** Server-side paint check: only painters, and only while there is a word to draw. */
export function mayPaint(canvas: Canvas, userId: number | undefined): boolean {
    const s = mirrors.get(canvas.id)?.s;
    if (!s || s.phase !== "drawing") return false;
    return s.players.some(p => p.id === userId && p.team === "painter");
}

/** Add a newly connected player and send them the game as it stands. */
export async function joinGame(client: Client) {
    if (!mirrors.has(client.canvas.id)) mirrors.set(client.canvas.id, await read(client.canvas.id));
    const result = await act(client.canvas, {
        type: "heartbeat", users: [{ id: client.userId!, name: client.userName! }],
    });
    // Rejoining can change nothing anyone else sees, and then nothing is published -
    // so this socket is sent its view directly rather than waiting for the bus.
    sendView(client.sock, result.state);
}

/** Their last socket here closed. Another tab on another process keeps them in (heartbeat). */
export async function leaveGame(client: Client) {
    const stillHere = [...client.canvas.clients].some(sock => clientOf(sock)?.userId === client.userId);
    if (!stillHere) await act(client.canvas, { type: "leave", userId: client.userId! });
}

const TEAMS: readonly Team[] = ["painter", "guesser"];

/** A text frame from the browser. Anything malformed is dropped, like a bad PLACE. */
function parseRequest(text: string): GameRequest | null {
    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(text);
    } catch {
        return null;
    }
    switch (msg?.t) {
        case "team": return TEAMS.includes(msg.team as Team) ? { t: "team", team: msg.team as Team } : null;
        case "ready": return typeof msg.ready === "boolean" ? { t: "ready", ready: msg.ready } : null;
        case "theme":
            return typeof msg.theme === "string" && typeof msg.rounds === "number"
                ? { t: "theme", theme: msg.theme, rounds: msg.rounds } : null;
        case "guess": return typeof msg.text === "string" ? { t: "guess", text: msg.text } : null;
        case "judge":
            return typeof msg.guessId === "number" && typeof msg.pass === "boolean"
                ? { t: "judge", guessId: msg.guessId, pass: msg.pass } : null;
        case "skip": return { t: "skip" };
        case "again": return { t: "again" };
        default: return null;
    }
}

export async function onGameText(client: Client, text: string) {
    const req = parseRequest(text);
    if (!req || client.userId === undefined) return;
    const userId = client.userId;

    const action: GameAction =
        req.t === "team" ? { type: "team", userId, team: req.team }
        : req.t === "ready" ? { type: "ready", userId, ready: req.ready }
        : req.t === "theme" ? { type: "theme", userId, theme: req.theme, rounds: req.rounds }
        : req.t === "guess" ? { type: "guess", userId, text: req.text }
        : req.t === "judge" ? { type: "judge", userId, guessId: req.guessId, pass: req.pass }
        : req.t === "skip" ? { type: "skip", userId }
        : { type: "again", userId };

    const result = await act(client.canvas, action);
    if (result.error) return sendError(client.sock, result.error);

    // The words are made outside the lock: a model call takes seconds, and the room must
    // stay usable meanwhile. The state says a request is out, so a second click is refused.
    if (action.type === "theme") {
        const s = result.state;
        const { words, fromAi } = await makeWords(s.theme, s.rounds + SPARE_WORDS);
        await act(client.canvas, { type: "words", words, fromAi });
    }
}

/**
 * Each process vouches for the players it holds a socket for, in every game room it has.
 * Also what makes time pass: the round clock is only checked here.
 */
export function heartbeat() {
    for (const canvas of allResident()) {
        if (canvas.kind !== "guess" || canvas.clients.size === 0) continue;
        const users = new Map<number, string>();
        for (const sock of canvas.clients) {
            const c = clientOf(sock);
            if (c?.userId !== undefined) users.set(c.userId, c.userName!);
        }
        act(canvas, { type: "heartbeat", users: [...users].map(([id, name]) => ({ id, name })) })
            .catch(err => console.error(`game heartbeat for ${canvas.id} failed`, err));
    }
}

/** The room left this process's memory; the next load reads a fresh copy. */
export function forgetGame(id: string) {
    mirrors.delete(id);
}
