import { describe, it, expect } from "vitest";
import type { WebSocket } from "ws";
import {
    foldFrame, withinFloodCap, createCanvas, FLOOD_BURST, FLOOD_RATE, type Client,
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
        canvas: createCanvas({ id: "t", name: "t", w: 4, h: 4, ownerId: null, isPublic: true, joinCode: null, createdAt: 0 }),
        floodTokens: FLOOD_BURST,
        floodAt: now,
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
