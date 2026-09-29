import { describe, it, expect } from "vitest";
import type { WebSocket } from "ws";
import {
    foldFrame, withinFloodCap, createCanvas, FLOOD_BURST, FLOOD_RATE, ownerPainted, type Client,
} from "../server/canvas.js";
import { encodeDelta, encodeClear } from "../shared/protocols.js";
import { EMPTY } from "../shared/palette.js";

const blank = (w: number, h: number) => new Uint8Array(w * h).fill(EMPTY);

describe("foldFrame", () => {
    it("replays deltas in order, the later write winning", () => {
        const board = blank(4, 4);
        foldFrame(board, 4, 4, encodeDelta([{ x: 1, y: 2, colour: 3 }]));
        foldFrame(board, 4, 4, encodeDelta([{ x: 1, y: 2, colour: 7 }, { x: 0, y: 0, colour: 1 }]));

        expect(board[2 * 4 + 1]).toBe(7);
        expect(board[0]).toBe(1);
    });

    it("blanks the board at a CLEAR and carries on after it", () => {
        const board = blank(4, 4);
        foldFrame(board, 4, 4, encodeDelta([{ x: 0, y: 0, colour: 1 }, { x: 3, y: 3, colour: 2 }]));
        foldFrame(board, 4, 4, encodeClear());
        foldFrame(board, 4, 4, encodeDelta([{ x: 2, y: 1, colour: 5 }]));

        const expected = blank(4, 4);
        expected[1 * 4 + 2] = 5;
        expect(board).toEqual(expected);
    });

    it("skips pixels outside the board rather than wrapping them onto another row", () => {
        // A log from before a resize holds coordinates for the old, bigger board.
        const board = blank(4, 4);
        foldFrame(board, 4, 4, encodeDelta([{ x: 5, y: 0, colour: 1 }, { x: 0, y: 9, colour: 1 }]));

        expect(board).toEqual(blank(4, 4));
    });
});

describe("withinFloodCap", () => {
    const client = (now: number): Client => ({
        sock: {} as WebSocket,
        canvas: createCanvas({ id: "t", name: "t", w: 4, h: 4, ownerId: null, isPublic: true, joinCode: null, createdAt: 0, kind: "draw" }),
        floodTokens: FLOOD_BURST,
        floodAt: now,
        renewedAt: 0,
    });

    it("allows a whole burst at once, then refuses", () => {
        const c = client(0);
        for (let i = 0; i < FLOOD_BURST; i++) expect(withinFloodCap(c, 0)).toBe(true);
        expect(withinFloodCap(c, 0)).toBe(false);
    });

    it("refills at the rate, never past the burst", () => {
        const c = client(0);
        for (let i = 0; i < FLOOD_BURST; i++) withinFloodCap(c, 0);

        // Half a second later, half a second's worth is back.
        let allowed = 0;
        while (withinFloodCap(c, 500)) allowed++;
        expect(allowed).toBe(FLOOD_RATE / 2);

        // Idle for an hour still only earns one burst.
        let later = 0;
        while (withinFloodCap(c, 3_600_000)) later++;
        expect(later).toBe(FLOOD_BURST);
    });
});

describe("ownerPainted", () => {
    const HOUR = 60 * 60_000;
    const room = (ownerId: number | null) =>
        createCanvas({ id: "r", name: "r", w: 4, h: 4, ownerId, isPublic: true, joinCode: null, createdAt: 0, kind: "draw" });
    const painter = (userId: number | undefined, ownerId: number | null): Client => ({
        sock: {} as WebSocket, canvas: room(ownerId), userId,
        floodTokens: FLOOD_BURST, floodAt: 0, renewedAt: 0,
    });

    it("renews for the owner painting in their own room, at most once an hour", () => {
        const c = painter(7, 7);
        expect(ownerPainted(c, 10 * HOUR)).toBe(true);
        expect(ownerPainted(c, 10 * HOUR + 1000)).toBe(false);
        expect(ownerPainted(c, 11 * HOUR)).toBe(true);
    });

    it("never renews for someone else's room, main, or a logged-out painter", () => {
        expect(ownerPainted(painter(7, 8), HOUR)).toBe(false);
        expect(ownerPainted(painter(7, null), HOUR)).toBe(false);   // main has no owner
        expect(ownerPainted(painter(undefined, null), HOUR)).toBe(false);
    });
});
