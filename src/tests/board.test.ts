import { describe, it, expect } from "vitest";
import { index } from "../shared/constants.js";

// non-square sizes are the point of the refactor - 256x256 hides a transposed index
describe.each([[256, 256], [7, 5], [512, 16]])("board indexing %ix%i", (w, h) => {
    it("maps every (x,y) to a unique slot", () => {
        const seen = new Set<number>();
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) seen.add(index(x, y, w));
        expect(seen.size).toBe(w * h);
    });

    it("covers exactly 0 .. w*h-1", () => {
        expect(index(0, 0, w)).toBe(0);
        expect(index(w - 1, h - 1, w)).toBe(w * h - 1);
    });
});
