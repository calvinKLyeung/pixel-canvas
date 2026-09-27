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

// SQLite ignores REFERENCES entirely unless this is on, per connection. Without it the
// drafts table below happily keeps rows pointing at users and canvases that are gone.
db.pragma("foreign_keys = ON");

// Runs on every boot. CREATE TABLE IF NOT EXISTS is the whole migration story for now.
// SQLite has no boolean type, so is_public and is_admin are 0 or 1.
//
// canvases.owner_id has no REFERENCES because the table predates users, and IF NOT EXISTS
// never alters a table that is already there. Nothing deletes users yet, so nothing is
// left dangling - but a delete-account feature needs a real migration first.
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

    -- One draft per user per canvas, enforced by the key rather than by our code.
    -- data is the draft packed exactly like a DELTA message.
    CREATE TABLE IF NOT EXISTS drafts (
        user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        canvas_id  TEXT    NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        data       BLOB    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, canvas_id)
    );
`);

/** A row as SQLite stores it: snake_case columns, 0/1 for the boolean. */
interface CanvasRow {
    id: string;
    name: string;
    w: number;
    h: number;
    cooldown_ms: number;
    owner_id: number | null;
    is_public: number;
    created_at: number;
}

const toConfig = (row: CanvasRow): CanvasConfig => ({
    id: row.id,
    name: row.name,
    w: row.w,
    h: row.h,
    cooldownMs: row.cooldown_ms,
    ownerId: row.owner_id,
    isPublic: row.is_public === 1,
    createdAt: row.created_at,
});

// Prepared once at import, reused for every call: SQLite parses and plans the SQL a single
// time. The @named holes are bound as values, so a canvas called "'); DROP TABLE" is a name.
const insertCanvas = db.prepare(`
    INSERT INTO canvases (id, name, w, h, cooldown_ms, owner_id, is_public, created_at)
    VALUES (@id, @name, @w, @h, @cooldownMs, @ownerId, @isPublic, @createdAt)
    ON CONFLICT(id) DO NOTHING
`);

const selectCanvas = db.prepare(`SELECT * FROM canvases WHERE id = ?`);

const selectPublicCanvases = db.prepare(`
    SELECT * FROM canvases WHERE is_public = 1 ORDER BY created_at DESC LIMIT ?
`);

/**
 * Write a config. DO NOTHING on conflict rather than overwriting: ids from newCanvasId are
 * fresh, so the only caller that can collide is main's boot-time save, and an existing main
 * row must win - its stored board in Redis is sized to the dimensions already on disk.
 */
export function saveCanvasConfig(cfg: CanvasConfig): void {
    insertCanvas.run({
        id: cfg.id,
        name: cfg.name,
        w: cfg.w,
        h: cfg.h,
        cooldownMs: cfg.cooldownMs,
        ownerId: cfg.ownerId,
        isPublic: cfg.isPublic ? 1 : 0,
        createdAt: cfg.createdAt,
    });
}

/** null means no such canvas has ever existed - unlike a resident miss, which means evicted. */
export function getCanvasConfig(id: string): CanvasConfig | null {
    const row = selectCanvas.get(id) as CanvasRow | undefined;
    return row ? toConfig(row) : null;
}

/** Every public canvas, resident or not. The lobby lists what exists, not what is loaded. */
export function listPublicCanvasConfigs(limit: number): CanvasConfig[] {
    return (selectPublicCanvases.all(limit) as CanvasRow[]).map(toConfig);
}

const updateCooldown = db.prepare(`UPDATE canvases SET cooldown_ms = ? WHERE id = ?`);

/** Change a canvas's cooldown. Only boot uses it, to bring main's existing row up to date. */
export function setCanvasCooldown(id: string, cooldownMs: number): void {
    updateCooldown.run(cooldownMs, id);
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


/** ========== drafts ========== */

// An upsert: insert, or replace the row that is already there. One atomic statement
// instead of a SELECT then an INSERT or UPDATE that could race.
const upsertDraft = db.prepare(`
    INSERT INTO drafts (user_id, canvas_id, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, canvas_id) DO UPDATE SET data = excluded.data,
                                                  updated_at = excluded.updated_at
`);
const selectDraft = db.prepare(`SELECT data FROM drafts WHERE user_id = ? AND canvas_id = ?`);

export function saveDraft(userId: number, canvasId: string, data: Buffer): void {
    upsertDraft.run(userId, canvasId, data, Date.now());
}

/** null means this user never saved a draft here - not the same as an empty one. */
export function loadDraft(userId: number, canvasId: string): Buffer | null {
    const row = selectDraft.get(userId, canvasId) as { data: Buffer } | undefined;
    return row?.data ?? null;
}
