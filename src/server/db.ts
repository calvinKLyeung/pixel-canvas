import Database from "better-sqlite3";
import { join } from "node:path";
import type { CanvasConfig } from "./canvas.js";
import type { RoomKind } from "../shared/canvasConfig.js";

/**
 * One file on disk. No server, no connection pool - the library is the database.
 * Anchored to the project root rather than left relative: a bare path resolves against
 * process.cwd(), so launching from anywhere else silently opens a different, empty
 * database while the boards stay in Redis under ids SQLite no longer knows.
 */
const db = new Database(process.env.DB_PATH ?? join(import.meta.dirname, "../../pixel-canvas.db"));

// Default journalling locks the whole file while a write is in flight. WAL sends writes
// to a side log so readers keep going, which is what we want with a 20Hz tick loop.
db.pragma("journal_mode = WAL");

// SQLite ignores REFERENCES entirely unless this is on, per connection. Without it,
// deleting a canvas would leave its membership rows pointing at nothing.
db.pragma("foreign_keys = ON");

// Runs on every boot. CREATE TABLE IF NOT EXISTS is the whole migration story for now.
// SQLite has no boolean type, so is_public and is_admin are 0 or 1.
//
// canvases.owner_id has no REFERENCES because the table predates users, and IF NOT EXISTS
// never alters a table that is already there. Nothing deletes users yet, so nothing is
// left dangling - but a delete-account feature needs a real migration first.
// cooldown_ms is unused since the cooldown was removed; new rows store 0.
db.exec(`
    CREATE TABLE IF NOT EXISTS canvases (
        id          TEXT    PRIMARY KEY,
        name        TEXT    NOT NULL,
        w           INTEGER NOT NULL,
        h           INTEGER NOT NULL,
        cooldown_ms INTEGER NOT NULL,
        owner_id    INTEGER,
        is_public   INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
    );

    -- NOCASE: "Alice" and "alice" are one account. Two people who look identical in
    -- every list is a phishing vector, not just a nuisance.
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT    NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
    );

    -- Holds a hash of the token, never the token. If this file leaks, nobody can log in
    -- as anyone - the raw token only ever exists in the browser's cookie.
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- Who has typed the code for a private room, so they only have to do it once.
    CREATE TABLE IF NOT EXISTS canvas_members (
        user_id   INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        canvas_id TEXT    NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, canvas_id)
    );
`);

// join_code arrived after the table did, and IF NOT EXISTS will not add a column to a table
// that already exists - so add it by hand, once.
const hasJoinCode = (db.prepare(`PRAGMA table_info(canvases)`).all() as { name: string }[])
    .some(col => col.name === "join_code");
if (!hasJoinCode) {
    try {
        db.exec(`ALTER TABLE canvases ADD COLUMN join_code TEXT`);
    } catch (err) {
        // Two processes booting together can both see the column missing; the second
        // ALTER then fails because the first already added it. That is the only failure
        // worth ignoring here.
        if (!String(err).includes("duplicate column")) throw err;
    }
}

// Same story for users.last_active_at. Existing accounts start their clock now, not at
// created_at - otherwise adding the column would delete everyone older than the limit on
// the very next purge, with no warning ever shown. A database from before painting counted
// as activity has the same clock under its old name, last_login_at: rename rather than add.
const userColumns = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[])
    .map(col => col.name);
if (!userColumns.includes("last_active_at")) {
    try {
        db.exec(userColumns.includes("last_login_at")
            ? `ALTER TABLE users RENAME COLUMN last_login_at TO last_active_at`
            : `ALTER TABLE users ADD COLUMN last_active_at INTEGER`);
    } catch (err) {
        // A second process booting at the same moment got there first.
        if (!/duplicate column|no such column/.test(String(err))) throw err;
    }
    db.prepare(`UPDATE users SET last_active_at = ? WHERE last_active_at IS NULL`).run(Date.now());
}

// canvases.kind likewise: every room from before games existed is a drawing room.
const hasKind = (db.prepare(`PRAGMA table_info(canvases)`).all() as { name: string }[])
    .some(col => col.name === "kind");
if (!hasKind) {
    try {
        db.exec(`ALTER TABLE canvases ADD COLUMN kind TEXT NOT NULL DEFAULT 'draw'`);
    } catch (err) {
        if (!String(err).includes("duplicate column")) throw err;
    }
}

// One room of each kind per owner, enforced by the database rather than by a check in a
// route that two quick clicks could both pass. NULLs never collide, so ownerless canvases
// are fine. Replaces the older one-room-per-owner index, which would refuse a game room to
// anyone who already has a drawing room.
db.exec(`
    DROP INDEX IF EXISTS idx_canvases_owner;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_owner_kind ON canvases(owner_id, kind);
`);

/** A row as SQLite stores it: snake_case columns, 0/1 for the boolean. */
interface CanvasRow {
    id: string;
    name: string;
    w: number;
    h: number;
    owner_id: number | null;
    is_public: number;
    join_code: string | null;
    created_at: number;
    kind: RoomKind;
}

const toConfig = (row: CanvasRow): CanvasConfig => ({
    id: row.id,
    name: row.name,
    w: row.w,
    h: row.h,
    ownerId: row.owner_id,
    isPublic: row.is_public === 1,
    joinCode: row.join_code,
    createdAt: row.created_at,
    kind: row.kind,
});

// Prepared once at import, reused for every call: SQLite parses and plans the SQL a single
// time. The @named holes are bound as values, so a canvas called "'); DROP TABLE" is a name.
const insertCanvas = db.prepare(`
    INSERT INTO canvases (id, name, w, h, cooldown_ms, owner_id, is_public, join_code, created_at, kind)
    VALUES (@id, @name, @w, @h, 0, @ownerId, @isPublic, @joinCode, @createdAt, @kind)
    ON CONFLICT(id) DO NOTHING
`);

const selectCanvas = db.prepare(`SELECT * FROM canvases WHERE id = ?`);

/**
 * Write a config. DO NOTHING on conflict rather than overwriting: ids from newCanvasId are
 * fresh, so the only caller that can collide is main's boot-time save.
 * Throws if the owner already has a canvas (idx_canvases_owner).
 */
export function saveCanvasConfig(cfg: CanvasConfig): void {
    insertCanvas.run({
        id: cfg.id,
        name: cfg.name,
        w: cfg.w,
        h: cfg.h,
        ownerId: cfg.ownerId,
        isPublic: cfg.isPublic ? 1 : 0,
        joinCode: cfg.joinCode,
        createdAt: cfg.createdAt,
        kind: cfg.kind,
    });
}

/** null means no such canvas has ever existed - unlike a resident miss, which means evicted. */
export function getCanvasConfig(id: string): CanvasConfig | null {
    const row = selectCanvas.get(id) as CanvasRow | undefined;
    return row ? toConfig(row) : null;
}

const selectByOwner = db.prepare(`SELECT * FROM canvases WHERE owner_id = ? AND kind = ?`);
const selectAllByOwner = db.prepare(`SELECT * FROM canvases WHERE owner_id = ?`);

/** The one room of this kind a user owns, if any. */
export function getCanvasByOwner(userId: number, kind: RoomKind): CanvasConfig | null {
    const row = selectByOwner.get(userId, kind) as CanvasRow | undefined;
    return row ? toConfig(row) : null;
}

/** Every room a user owns, of either kind. */
export function canvasesByOwner(userId: number): CanvasConfig[] {
    return (selectAllByOwner.all(userId) as CanvasRow[]).map(toConfig);
}

// Private rooms are listed too - everyone logged in sees every tile, only entering is gated.
const selectAllCanvases = db.prepare(`
    SELECT c.*, u.name AS owner_name
    FROM canvases c LEFT JOIN users u ON u.id = c.owner_id
    WHERE c.kind = @kind
    ORDER BY c.id = @mainId DESC, c.created_at DESC
    LIMIT @limit
`);

export interface ListedCanvas extends CanvasConfig {
    ownerName: string | null;
}

/** Every room of a kind, main first, then newest. Resident or not: the lobby lists what exists. */
export function listCanvases(mainId: string, limit: number, kind: RoomKind): ListedCanvas[] {
    return (selectAllCanvases.all({ mainId, limit, kind }) as (CanvasRow & { owner_name: string | null })[])
        .map(row => ({ ...toConfig(row), ownerName: row.owner_name }));
}

const updateSize = db.prepare(`UPDATE canvases SET w = ?, h = ? WHERE id = ?`);

/** Only boot uses it, to bring main's existing row to its fixed size. */
export function setCanvasSize(id: string, w: number, h: number): void {
    updateSize.run(w, h, id);
}

const updatePrivacy = db.prepare(`UPDATE canvases SET is_public = ?, join_code = ? WHERE id = ?`);
const deleteMembers = db.prepare(`DELETE FROM canvas_members WHERE canvas_id = ?`);

/**
 * Set a room's privacy and code. A new code also forgets everyone who joined with the old
 * one - the reason to change a code is to lock out whoever has it.
 */
export const setCanvasPrivacy = db.transaction(
    (id: string, isPublic: boolean, joinCode: string | null, resetMembers: boolean) => {
        updatePrivacy.run(isPublic ? 1 : 0, joinCode, id);
        if (resetMembers) deleteMembers.run(id);
    });

const deleteCanvasRow = db.prepare(`DELETE FROM canvases WHERE id = ?`);

/** Remove a canvas's config. Its members go with it (ON DELETE CASCADE). */
export function deleteCanvasConfig(id: string): void {
    deleteCanvasRow.run(id);
}


/** ========== room members ========== */

const insertMember = db.prepare(
    `INSERT INTO canvas_members (user_id, canvas_id) VALUES (?, ?) ON CONFLICT DO NOTHING`);
const selectMember = db.prepare(
    `SELECT 1 FROM canvas_members WHERE user_id = ? AND canvas_id = ?`);

export function addMember(userId: number, canvasId: string): void {
    insertMember.run(userId, canvasId);
}

export function isMember(userId: number, canvasId: string): boolean {
    return selectMember.get(userId, canvasId) !== undefined;
}


/** ========== users ========== */

export interface User {
    id: number;
    name: string;
    passwordHash: string;
    isAdmin: boolean;
    /**
     * Last time they logged in, registered, or painted in their own room. Anything else -
     * opening a page, painting in someone else's room or on main - does not count.
     */
    lastActiveAt: number;
}

interface UserRow {
    id: number;
    name: string;
    password_hash: string;
    is_admin: number;
    created_at: number;
    last_active_at: number;
}

const toUser = (row: UserRow): User => ({
    id: row.id,
    name: row.name,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
    lastActiveAt: row.last_active_at,
});

const insertUser = db.prepare(
    `INSERT INTO users (name, password_hash, created_at, last_active_at) VALUES (?, ?, ?, ?)`);
const selectUserByName = db.prepare(`SELECT * FROM users WHERE name = ?`);
const selectUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const updateLastActive = db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`);
// Admins are never purged: losing the only account that can clear main would need a hand
// edit of the database to undo.
const selectInactiveUsers = db.prepare(
    `SELECT id FROM users WHERE last_active_at < ? AND is_admin = 0`);
const deleteUserRow = db.prepare(`DELETE FROM users WHERE id = ?`);

/** Returns the new user's id. Throws if the name is taken, whatever its capitalisation. */
export function createUser(name: string, passwordHash: string): number {
    const now = Date.now();
    return Number(insertUser.run(name, passwordHash, now, now).lastInsertRowid);
}

export function touchActive(id: number, at = Date.now()): void {
    updateLastActive.run(at, id);
}

/**
 * Once per database: restart the clock of every account already older than `before`, so
 * shortening the inactivity limit gives them the full new limit, with the countdown showing,
 * instead of deleting them at the next purge without warning. PRAGMA user_version marks it done.
 */
export const restartOverdueClocksOnce = db.transaction((before: number, now = Date.now()): number => {
    if ((db.pragma("user_version", { simple: true }) as number) >= 1) return 0;
    const changed = db.prepare(`UPDATE users SET last_active_at = ? WHERE last_active_at < ?`).run(now, before).changes;
    db.pragma("user_version = 1");
    return changed;
});

/** Non-admin accounts whose last activity is older than `before`. */
export function inactiveUserIds(before: number): number[] {
    return (selectInactiveUsers.all(before) as { id: number }[]).map(r => r.id);
}

/**
 * Remove an account. Sessions, memberships and drafts go with it (ON DELETE CASCADE).
 * Their rooms do NOT: canvases.owner_id has no foreign key, so delete them first.
 */
export function deleteUser(id: number): void {
    deleteUserRow.run(id);
}

export function getUserByName(name: string): User | null {
    const row = selectUserByName.get(name) as UserRow | undefined;
    return row ? toUser(row) : null;
}

export function getUserById(id: number): User | null {
    const row = selectUserById.get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
}


/** ========== sessions ========== */

const insertSession = db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`);
// Expired rows are ignored here rather than deleted, so an old cookie simply stops working.
const selectSessionUser = db.prepare(
    `SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?`);
const deleteSessionRow = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);

export function saveSession(tokenHash: string, userId: number, expiresAt: number): void {
    insertSession.run(tokenHash, userId, expiresAt);
}

/** The user a live session belongs to, or null if it is unknown or expired. */
export function sessionUserId(tokenHash: string): number | null {
    const row = selectSessionUser.get(tokenHash, Date.now()) as { user_id: number } | undefined;
    return row?.user_id ?? null;
}

export function deleteSession(tokenHash: string): void {
    deleteSessionRow.run(tokenHash);
}

const deleteExpiredRows = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);

/** Lookups already ignore expired sessions; this stops the table growing forever. */
export function deleteExpiredSessions(now = Date.now()): number {
    return deleteExpiredRows.run(now).changes;
}
