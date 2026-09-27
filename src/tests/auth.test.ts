import { describe, it, expect } from "vitest";

// db.ts opens its database on import, so point it at memory first - a static import is
// hoisted above this line and would open the real file.
process.env.DB_PATH = ":memory:";
const { register, login, issueSession, userFromToken, endSession } = await import("../server/auth.js");
const {
    getUserByName, getUserById, touchActive, inactiveUserIds, deleteUser, deleteExpiredSessions,
} = await import("../server/db.js");

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

describe("inactivity", () => {
    const DAY = 864e5;

    async function user(name: string): Promise<number> {
        const result = await register(name, "password123");
        if (!("id" in result)) throw new Error(result.error);
        return result.id;
    }

    it("starts the clock at registration and restarts it at every login", async () => {
        const id = await user("frank");
        touchActive(id, Date.now() - 40 * DAY);
        expect(inactiveUserIds(Date.now() - 30 * DAY)).toContain(id);

        await login("frank", "password123");
        expect(inactiveUserIds(Date.now() - 30 * DAY)).not.toContain(id);
    });

    it("does not restart the clock on a failed login", async () => {
        const id = await user("gina");
        const old = Date.now() - 40 * DAY;
        touchActive(id, old);
        await login("gina", "wrong password");
        expect(getUserById(id)!.lastActiveAt).toBe(old);
    });

    it("takes the account's sessions with it when deleted", async () => {
        const id = await user("hank");
        const token = issueSession(id);
        deleteUser(id);
        expect(getUserById(id)).toBeNull();
        expect(userFromToken(token)).toBeNull();
    });

    it("clears out expired sessions but keeps live ones", async () => {
        const id = await user("iris");
        const token = issueSession(id);
        deleteExpiredSessions(Date.now());
        expect(userFromToken(token)?.name).toBe("iris");

        // 31 days on, the 30-day session has expired and is removed.
        expect(deleteExpiredSessions(Date.now() + 31 * DAY)).toBeGreaterThanOrEqual(1);
        expect(userFromToken(token)).toBeNull();
    });
});
