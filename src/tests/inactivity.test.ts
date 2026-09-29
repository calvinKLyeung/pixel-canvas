import { describe, it, expect } from "vitest";

// db.ts opens its database on import, so point it at memory first.
process.env.DB_PATH = ":memory:";
const { createUser, touchActive, getUserById, restartOverdueClocksOnce, inactiveUserIds } = await import("../server/db.js");

const DAY = 864e5;

describe("restartOverdueClocksOnce", () => {
    it("gives overdue accounts a fresh clock, once", () => {
        const now = 100 * DAY;
        const overdue = createUser("overdue", "x");
        const recent = createUser("recent", "x");
        touchActive(overdue, now - 20 * DAY);
        touchActive(recent, now - 2 * DAY);

        expect(restartOverdueClocksOnce(now - 10 * DAY, now)).toBe(1);
        expect(getUserById(overdue)!.lastActiveAt).toBe(now);
        expect(getUserById(recent)!.lastActiveAt).toBe(now - 2 * DAY);
        expect(inactiveUserIds(now - 10 * DAY)).toEqual([]);

        // Later boots must not rescue anyone: that would stop the purge from ever running.
        touchActive(overdue, now - 20 * DAY);
        expect(restartOverdueClocksOnce(now - 10 * DAY, now)).toBe(0);
        expect(inactiveUserIds(now - 10 * DAY)).toEqual([overdue]);
    });
});
