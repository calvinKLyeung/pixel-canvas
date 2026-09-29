import { hash, verify } from "@node-rs/argon2";
import { randomBytes, createHash } from "node:crypto";
import {
    createUser, getUserByName, getUserById, saveSession, sessionUserId, deleteSession,
    touchActive, type User,
} from "./db.js";

export const SESSION_DAYS = 30;
/**
 * An account with no activity for this long is deleted, with its rooms. Activity is logging
 * in, painting in your own room, or joining your own game room - so an owner who only ever
 * uses a saved login keeps their rooms by using them. The owner's canvas page shows how
 * many days are left.
 */
export const INACTIVE_DAYS = 10;
export const INACTIVE_MS = INACTIVE_DAYS * 864e5;
export const MIN_USERNAME = 3;
export const MAX_USERNAME = 20;
export const MIN_PASSWORD = 8;

/**
 * Create an account. Returns an error string for anything the user should be told about.
 *
 * The password is never stored: argon2 salts and hashes it, and is deliberately slow so a
 * leaked database cannot be brute forced quickly. That slowness is why this is async.
 */
export async function register(name: unknown, password: unknown): Promise<{ id: number } | { error: string }> {
    // Body fields are whatever the client sent - a missing name is undefined, not "".
    if (typeof name !== "string" || name.length < MIN_USERNAME || name.length > MAX_USERNAME) {
        return { error: `name must be ${MIN_USERNAME}-${MAX_USERNAME} characters` };
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
        return { error: `password must be at least ${MIN_PASSWORD} characters` };
    }
    // Checked before hashing so a taken name does not cost a slow hash.
    if (getUserByName(name)) return { error: "name taken" };

    const passwordHash = await hash(password);
    try {
        return { id: createUser(name, passwordHash) };
    } catch {
        // Two signups for one name can both pass the check above while the other is
        // hashing. The UNIQUE constraint is the real guard; this is the loser of that race.
        return { error: "name taken" };
    }
}

/**
 * The user if the name and password match, otherwise null - for both "no such user" and
 * "wrong password". Telling them apart tells an attacker which names exist.
 */
export async function login(name: unknown, password: unknown): Promise<User | null> {
    if (typeof name !== "string" || typeof password !== "string") return null;
    const user = getUserByName(name);
    if (!user) return null;
    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) return null;
    touchActive(user.id);   // restarts the inactivity clock - see INACTIVE_DAYS
    return user;
}

const sha256 = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Start a session and return the raw token for the cookie. The database only gets its
 * hash. randomBytes, not Math.random: Math.random is predictable from earlier outputs,
 * which for a session token means forgeable logins.
 */
export function issueSession(userId: number): string {
    const token = randomBytes(32).toString("base64url");
    saveSession(sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
    return token;
}

/** The logged-in user for a cookie value, or null. */
export function userFromToken(token: string | undefined): User | null {
    if (!token) return null;
    const userId = sessionUserId(sha256(token));
    return userId === null ? null : getUserById(userId);
}

export function endSession(token: string | undefined): void {
    if (token) deleteSession(sha256(token));
}
