import { describe, it, expect } from "vitest";
import { W, H, index } from "../shared/constants.js";

describe("board indexing", () => {
    it("maps every (x,y) to a unique slot", () => {
        const seen = new Set<number>();
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) seen.add(index(x, y));
        expect(seen.size).toBe(W * H);
    });

    it("covers exactly 0 .. W*H-1", () => {
        expect(index(0, 0)).toBe(0);
        expect(index(W - 1, H - 1)).toBe(W * H - 1);
    });
});