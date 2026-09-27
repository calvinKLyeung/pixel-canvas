import Database from "better-sqlite3";
import { join } from "node:path";
import type { CanvasConfig } from "./canvas.js";

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

    -- One room per owner, enforced by the database rather than by a check in a route that
    -- two quick clicks could both pass. NULLs never collide, so ownerless canvases are fine.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_owner ON canvases(owner_id);
`);

// join_code arrived after the table did, and IF NOT EXISTS will not add a column to a table
// that already exists - so add it by hand, once.
const hasJoinCode = (db.prepare(`PRAGMA table_info(canvases)`).all() as { name: string }[])
    .some(col => col.name === "join_code");
if (!hasJoinCode) db.exec(`ALTER TABLE canvases ADD COLUMN join_code TEXT`);

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
});

// Prepared once at import, reused for every call: SQLite parses and plans the SQL a single
// time. The @named holes are bound as values, so a canvas called "'); DROP TABLE" is a name.
const insertCanvas = db.prepare(`
    INSERT INTO canvases (id, name, w, h, cooldown_ms, owner_id, is_public, join_code, created_at)
    VALUES (@id, @name, @w, @h, 0, @ownerId, @isPublic, @joinCode, @createdAt)
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
    });
}

/** null means no such canvas has ever existed - unlike a resident miss, which means evicted. */
export function getCanvasConfig(id: string): CanvasConfig | null {
    const row = selectCanvas.get(id) as CanvasRow | undefined;
    return row ? toConfig(row) : null;
}

const selectByOwner = db.prepare(`SELECT * FROM canvases WHERE owner_id = ?`);

/** The one canvas a user owns, if any. */
export function getCanvasByOwner(userId: number): CanvasConfig | null {
    const row = selectByOwner.get(userId) as CanvasRow | undefined;
    return row ? toConfig(row) : null;
}

// Private rooms are listed too - everyone logged in sees every tile, only entering is gated.
const selectAllCanvases = db.prepare(`
    SELECT c.*, u.name AS owner_name
    FROM canvases c LEFT JOIN users u ON u.id = c.owner_id
    ORDER BY c.id = @mainId DESC, c.created_at DESC
    LIMIT @limit
`);

export interface ListedCanvas extends CanvasConfig {
    ownerName: string | null;
}

/** Every room, main first, then newest. Resident or not: the lobby lists what exists. */
export function listCanvases(mainId: string, limit: number): ListedCanvas[] {
    return (selectAllCanvases.all({ mainId, limit }) as (CanvasRow & { owner_name: string | null })[])
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
}

interface UserRow {
    id: number;
    name: string;
    password_hash: string;
    is_admin: number;
    created_at: number;
}

const toUser = (row: UserRow): User => ({
    id: row.id,
    name: row.name,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
});

const insertUser = db.prepare(
    `INSERT INTO users (name, password_hash, created_at) VALUES (?, ?, ?)`);
const selectUserByName = db.prepare(`SELECT * FROM users WHERE name = ?`);
const selectUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);

/** Returns the new user's id. Throws if the name is taken, whatever its capitalisation. */
export function createUser(name: string, passwordHash: string): number {
    return Number(insertUser.run(name, passwordHash, Date.now()).lastInsertRowid);
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
