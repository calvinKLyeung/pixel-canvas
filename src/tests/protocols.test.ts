import { describe, it, expect } from "vitest";
import {
    encodeDelta, decodeDelta, encodePlace, decodePlace,
    viewOf, MSG, MAX_DELTA_PIXELS, type Pixel,
} from "../shared/protocols.js";

describe("protocols", () => {

    // Server -> Client
    it("round-trips a delta", () => {
        const pixels: Pixel[] = [
            { x: 0,   y: 0,   colour: 0  },
            { x: 255, y: 255, colour: 15 },
            { x: 40,  y: 12,  colour: 3  },
        ];
        expect(decodeDelta(viewOf(encodeDelta(pixels)))).toEqual(pixels);
    });

    it("handles an empty delta", () => {
        expect(decodeDelta(viewOf(encodeDelta([])))).toEqual([]);
    });


    // Client -> Server
    it("round-trips a place", () => {
        const p: Pixel = { x: 200, y: 7, colour: 11 };
        expect(decodePlace(viewOf(encodePlace(p)))).toEqual(p);
    });

    it("produces exactly 3 + 5n bytes", () => {
        expect(encodeDelta([]).length).toBe(3);
        expect(encodeDelta([{ x: 1, y: 1, colour: 1 }]).length).toBe(8);
        expect(encodeDelta(Array(40).fill({ x: 1, y: 1, colour: 1 })).length).toBe(203);
    });

    // MAX_DELTA_PIXELS is what the u16 count can hold, and flushAll splits on it.
    // One past it wraps the count to 0 and the client drops the whole batch silently.
    it("carries a full-sized delta, and wraps one pixel past it", () => {
        const pixel: Pixel = { x: 1, y: 1, colour: 1 };
        const full = Array(MAX_DELTA_PIXELS).fill(pixel);
        expect(decodeDelta(viewOf(encodeDelta(full))).length).toBe(MAX_DELTA_PIXELS);
        expect(decodeDelta(viewOf(encodeDelta([...full, pixel])))).toEqual([]);
    });

    it("tags messages correctly", () => {
        expect(viewOf(encodePlace({ x: 0, y: 0, colour: 0 })).getUint8(0)).toBe(MSG.PLACE);
        expect(viewOf(encodeDelta([])).getUint8(0)).toBe(MSG.DELTA);
    });
});