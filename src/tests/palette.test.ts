import { describe, it, expect } from "vitest";
import { PALETTE, PALETTE_RAMPS, EMPTY } from "../shared/palette.js";

describe("palette", () => {
    // Saved boards and the event log hold indexes, so these must never move.
    it("keeps the original 16 colours at their indexes", () => {
        expect(PALETTE.slice(0, 16)).toEqual([
            [255, 255, 255], [228, 228, 228], [136, 136, 136], [34, 34, 34],
            [255, 167, 209], [229, 0, 0], [229, 149, 0], [160, 106, 66],
            [229, 217, 0], [148, 224, 68], [2, 190, 1], [0, 211, 221],
            [0, 131, 199], [0, 0, 234], [207, 110, 228], [130, 0, 128],
        ]);
    });

    it("fits below EMPTY", () => {
        expect(PALETTE.length).toBeLessThanOrEqual(EMPTY);
    });

    it("shows every colour in the picker exactly once", () => {
        const shown = PALETTE_RAMPS.flat();
        expect(shown.length).toBe(PALETTE.length);
        expect(new Set(shown).size).toBe(PALETTE.length);
        expect(shown.every(i => i >= 0 && i < PALETTE.length)).toBe(true);
    });
});
