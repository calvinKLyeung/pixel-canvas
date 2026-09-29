import { describe, it, expect } from "vitest";

// db.ts opens its database on import, so point it at memory first - a static import is
// hoisted above this line and would open the real file.
process.env.DB_PATH = ":memory:";
const { createUser, saveCanvasConfig, getCanvasConfig, setCanvasPrivacy, addMember } = await import("../server/db.js");
const { canEnter, MAIN_ID } = await import("../server/canvas.js");
import type { CanvasConfig } from "../server/canvas.js";
import type { RoomKind } from "../shared/canvasConfig.js";

const owner = createUser("owner", "x");
const guest = createUser("guest", "x");

function room(id: string, isPublic: boolean, ownerId: number | null = owner, kind: RoomKind = "draw"): CanvasConfig {
    const cfg = { id, name: id, w: 16, h: 16, ownerId, isPublic, joinCode: "abc234", createdAt: 0, kind };
    saveCanvasConfig(cfg);
    return cfg;
}

describe("canEnter", () => {
    it("lets anyone into main, logged in or not", () => {
        const main = room(MAIN_ID, true, null);
        expect(canEnter(main, undefined)).toBe(true);
    });

    it("needs an account for every other room", () => {
        const pub = room("pub", true, null);
        expect(canEnter(pub, undefined)).toBe(false);
        expect(canEnter(pub, guest)).toBe(true);
    });

    it("keeps a private room to its owner and members", () => {
        const priv = room("priv", false, createUser("owner2", "x"));
        expect(canEnter(priv, guest)).toBe(false);
        expect(canEnter(priv, priv.ownerId!)).toBe(true);

        addMember(guest, "priv");
        expect(canEnter(priv, guest)).toBe(true);
    });

    it("forgets members when the code changes", () => {
        const cfg = room("locked", false, createUser("owner3", "x"));
        addMember(guest, "locked");
        setCanvasPrivacy("locked", false, "new234", true);
        expect(canEnter(getCanvasConfig("locked")!, guest)).toBe(false);
        expect(getCanvasConfig("locked")!.joinCode).toBe("new234");
        expect(cfg.ownerId).not.toBe(guest);
    });
});

describe("one room per owner", () => {
    it("refuses a second canvas for the same owner", () => {
        const solo = createUser("solo", "x");
        room("first", true, solo);
        expect(() => room("second", true, solo)).toThrow();
    });

    it("allows one game room alongside the drawing room", () => {
        const both = createUser("both", "x");
        room("draws", true, both, "draw");
        expect(() => room("games", true, both, "guess")).not.toThrow();
        expect(() => room("games2", true, both, "guess")).toThrow();
    });

    it("allows any number of ownerless canvases", () => {
        room("old1", true, null);
        expect(() => room("old2", true, null)).not.toThrow();
    });
});
