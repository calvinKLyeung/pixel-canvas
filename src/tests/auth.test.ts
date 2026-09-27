import { describe, it, expect } from "vitest";

// db.ts opens its database on import, so point it at memory first - a static import is
// hoisted above this line and would open the real file.
process.env.DB_PATH = ":memory:";
const { register, login, issueSession, userFromToken, endSession } = await import("../server/auth.js");
const { getUserByName } = await import("../server/db.js");

describe("accounts", () => {
    it("registers, then logs in only with the right password", async () => {
        const result = await register("alice", "correct horse");
        expect(result).toHaveProperty("id");
        expect((await login("alice", "correct horse"))?.name).toBe("alice");
        expect(await login("alice", "wrong password")).toBeNull();
    });

    it("never stores the password", async () => {
        await register("bob", "hunter2hunter2");
        const stored = getUserByName("bob")!.passwordHash;
        expect(stored).not.toContain("hunter2");
        expect(stored.startsWith("$argon2")).toBe(true);
    });

    it("treats names differing only in case as the same account", async () => {
        await register("Carol", "password123");
        expect(await register("carol", "password456")).toEqual({ error: "name taken" });
    });

    it("gives the same answer for an unknown name as for a wrong password", async () => {
        expect(await login("nobody", "whatever1")).toBeNull();
    });

    it("rejects bad input without throwing", async () => {
        expect(await register("ab", "password123")).toHaveProperty("error");
        expect(await register("dave", "short")).toHaveProperty("error");
        expect(await register(undefined, undefined)).toHaveProperty("error");
        expect(await login(undefined, undefined)).toBeNull();
    });
});

describe("sessions", () => {
    it("maps a token to its user until the session ends", async () => {
        const result = await register("erin", "password123");
        if (!("id" in result)) throw new Error(result.error);

        const token = issueSession(result.id);
        expect(userFromToken(token)?.name).toBe("erin");

        endSession(token);
        expect(userFromToken(token)).toBeNull();
    });

    it("rejects missing and made-up tokens", () => {
        expect(userFromToken(undefined)).toBeNull();
        expect(userFromToken("not-a-real-token")).toBeNull();
    });
});
