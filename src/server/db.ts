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

// Runs on every boot. CREATE TABLE IF NOT EXISTS is the whole migration story for now.
// SQLite has no boolean type, so is_public is 0 or 1.
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
    )
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
