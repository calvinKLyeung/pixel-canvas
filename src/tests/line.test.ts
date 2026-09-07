import { describe, it, expect } from "vitest";
import { line } from "../shared/line.js";


function collect(x0: number, y0: number, x1: number, y1: number) {
    const out: [number, number][] = [];
    line(x0, y0, x1, y1, (x, y) => out.push([x, y]));
    return out;
}

describe("line", () => {
    it("handles a single point", () => {
        expect(collect(5, 5, 5, 5)).toEqual([[5, 5]]);
    });

    it("has no gaps, every step moves at most 1 in each axis", () => {
        const pts = collect(0, 0, 30, 11);
        for (let i = 1; i < pts.length; i++) {
            expect(Math.abs(pts[i]![0] - pts[i - 1]![0])).toBeLessThanOrEqual(1);
            expect(Math.abs(pts[i]![1] - pts[i - 1]![1])).toBeLessThanOrEqual(1);
        }
    });

    it("starts and ends at the asked position, trying every direction", () => {
        for (const [a, b, c, d] of [[0,0,9,4],[9,4,0,0],[3,9,3,0],[0,7,7,0]]) {
            const pts = collect(a!, b!, c!, d!);
            expect(pts[0]).toEqual([a, b]);
            expect(pts.at(-1)).toEqual([c, d]);
        }
    });
});