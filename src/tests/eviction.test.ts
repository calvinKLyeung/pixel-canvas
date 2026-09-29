import { describe, it, expect, beforeEach } from "vitest";
import type { WebSocket } from "ws";
import {
    createCanvas, putResident, peekResident, allResident, sweep, MAIN_ID,
    type Canvas, type CanvasConfig,
} from "../server/canvas.js";

const MINUTE = 60 * 1000;

function config(id: string): CanvasConfig {
    return { id, name: id, w: 16, h: 16, ownerId: null, isPublic: true, joinCode: null, createdAt: 0, kind: "draw" };
}

/** Put a canvas in memory that was last touched `idleMinutes` ago. */
function resident(id: string, idleMinutes: number): Canvas {
    const canvas = createCanvas(config(id));
    canvas.lastActive = Date.now() - idleMinutes * MINUTE;
    putResident(canvas);
    return canvas;
}

const connect = (canvas: Canvas) => canvas.clients.add({} as WebSocket);
const noFlush = () => {};

// The resident map is module state shared by every test, so empty it first.
beforeEach(() => {
    for (const canvas of allResident()) {
        canvas.clients.clear();
        canvas.lastActive = 0;
    }
    sweep(noFlush);
});

describe("sweep", () => {
    it("drops canvases nobody has touched for longer than the idle window", () => {
        resident("stale", 30);
        resident("fresh", 2);

        expect(sweep(noFlush).map(c => c.id)).toEqual(["stale"]);
        expect(peekResident("stale")).toBeUndefined();
        expect(peekResident("fresh")).toBeDefined();
    });

    it("keeps a canvas someone is connected to, however old its timestamp", () => {
        const busy = resident("busy", 120);
        connect(busy);

        expect(sweep(noFlush)).toEqual([]);
        expect(peekResident("busy")).toBeDefined();
    });

    it("never evicts main, idle or not", () => {
        resident(MAIN_ID, 600);

        expect(sweep(noFlush)).toEqual([]);
        expect(peekResident(MAIN_ID)).toBeDefined();
    });

    it("drops the stalest down to the cap when everything is too recent to be idle", () => {
        // main is pinned but still occupies memory, so it counts toward the cap.
        resident(MAIN_ID, 600);
        // 60 canvases, none idle - the idle rule alone would keep every one of them.
        for (let i = 0; i < 60; i++) resident(`c${i}`, i / 60);

        const evicted = sweep(noFlush);

        // 61 resident against a cap of 50, so 11 go, and main is not eligible to be one.
        expect(evicted).toHaveLength(11);
        // c59 is the oldest, since lastActive went further back as i grew.
        expect(evicted.map(c => c.id)).toEqual(
            ["c59", "c58", "c57", "c56", "c55", "c54", "c53", "c52", "c51", "c50", "c49"],
        );
        expect([...allResident()]).toHaveLength(50);
        expect(peekResident(MAIN_ID)).toBeDefined();
    });

    it("keeps main resident with 60 other canvases competing for the cap", () => {
        resident(MAIN_ID, 600);
        for (let i = 0; i < 60; i++) resident(`c${i}`, 30);

        sweep(noFlush);

        expect(peekResident(MAIN_ID)).toBeDefined();
    });

    it("flushes pending pixels before the canvas leaves memory", () => {
        const doomed = resident("doomed", 30);
        doomed.dirty.set(5, 3);

        const flushed: Array<{ id: string; pending: number; stillResident: boolean }> = [];
        sweep(canvas => flushed.push({
            id: canvas.id,
            pending: canvas.dirty.size,
            // The whole point: the flush must see a canvas that is still in the map,
            // holding the pixels it is about to write.
            stillResident: peekResident(canvas.id) !== undefined,
        }));

        expect(flushed).toEqual([{ id: "doomed", pending: 1, stillResident: true }]);
    });
});
