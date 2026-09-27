import { index } from "../shared/constants.js";
import { encodeDelta, decodeDelta, viewOf } from "../shared/protocols.js";
import { MAX_DRAFT } from "../shared/draft.js";
import { me } from "./auth.js";

export { MAX_DRAFT };

/**
 * Pixels you plan to paint: board index -> colour, or EMPTY for a pending erase.
 *
 * Never written into the board array. The board is the server's truth and the next delta
 * would overwrite it, and then there is no telling committed from pending. Two structures
 * make that mistake impossible instead of something to remember.
 */
export const draft = new Map<number, number>();

// The canvas this draft belongs to, set once the snapshot says how wide it is.
let canvasId = "";
let canvasW = 0;

let loggedIn = false;
me.then(user => { loggedIn = user !== null; });

const PREFIX = "pixelcanvas.draft.";
const key = () => PREFIX + canvasId;

/**
 * Switch the draft to a canvas. Clearing is not optional: index 5000 is a different pixel
 * on a 64-wide board than on a 256-wide one, so a carried-over draft would scatter across
 * the new board. `onServerDraft` runs if a logged-in user's saved draft replaces this one.
 */
export function bindCanvas(id: string, w: number, onServerDraft: () => void) {
    if (id === canvasId) return;
    draft.clear();
    canvasId = id;
    canvasW = w;
    try {
        localStorage.setItem(key() + ".seen", String(Date.now()));   // for sweepOldDrafts
    } catch { /* storage unavailable */ }
    load();
    loadFromServer().then(replaced => { if (replaced) onServerDraft(); });
}

export function addDraft(x: number, y: number, colour: number): boolean {
    const idx = index(x, y, canvasW);
    if (draft.size >= MAX_DRAFT && !draft.has(idx)) return false;
    draft.set(idx, colour);
    return true;
}

/** Cancel a pending pixel. Free - unlike queueing an erase, which costs a cooldown. */
export function removeDraft(x: number, y: number) {
    draft.delete(index(x, y, canvasW));
}

export function clearDraft() {
    draft.clear();
    save();
}

export function toXY(idx: number): [number, number] {
    return [idx % canvasW, Math.floor(idx / canvasW)];
}


/** ========== this browser: localStorage ========== */

/** Save everywhere: this browser now, the server shortly after if logged in. */
export function save() {
    try {
        if (draft.size === 0) localStorage.removeItem(key());
        else localStorage.setItem(key(), JSON.stringify([...draft]));
    } catch (err) {
        // Full (see sweepOldDrafts) or disabled (Safari private browsing). Losing the
        // draft is bad; taking down the page is worse. Logged, not swallowed: a silent
        // catch turns "drafts stopped saving" into a mystery.
        console.warn("could not save draft", err);
    }
    if (loggedIn) scheduleUpload();
}

function load() {
    try {
        const raw = localStorage.getItem(key());
        if (!raw) return;
        for (const [idx, colour] of JSON.parse(raw) as [number, number][]) {
            draft.set(idx, colour);
        }
    } catch {
        localStorage.removeItem(key());   // corrupt or an old format; start clean
    }
}

/**
 * Drop drafts for canvases this browser has not opened in a month. Every canvas visited
 * leaves a key behind, and localStorage is ~5 MB per site: once full, every save throws
 * and drafts quietly stop persisting.
 */
export function sweepOldDrafts(maxAgeMs = 30 * 864e5) {
    try {
        const now = Date.now();
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            // Skip the ".seen" stamps themselves. Read as drafts they have no stamp of
            // their own, look infinitely old, and take every live draft down with them.
            if (!k?.startsWith(PREFIX) || k.endsWith(".seen")) continue;
            const seen = Number(localStorage.getItem(k + ".seen") ?? 0);
            if (now - seen > maxAgeMs) {
                localStorage.removeItem(k);
                localStorage.removeItem(k + ".seen");
            }
        }
    } catch { /* storage unavailable */ }
}


/** ========== the server: follows a logged-in user between devices ========== */

const draftUrl = (id: string) => `/api/c/${encodeURIComponent(id)}/draft`;

/**
 * Replace the local draft with the server's, if the server has one. The server copy wins
 * because it is the one shared between devices; the pagehide flush below keeps it at least
 * as new as this browser's. 204 means none was ever saved here, so the local one stays.
 */
async function loadFromServer(): Promise<boolean> {
    if (!(await me)) return false;
    const id = canvasId;
    try {
        const reply = await fetch(draftUrl(id));
        if (reply.status !== 200 || id !== canvasId) return false;
        const pixels = decodeDelta(viewOf(await reply.arrayBuffer()));
        draft.clear();
        for (const p of pixels) draft.set(index(p.x, p.y, canvasW), p.colour);
        save();
        return true;
    } catch {
        return false;   // offline is fine, localStorage still has it
    }
}

let uploadTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounced: the timer restarts on every change, so this fires 3s after you stop drawing
 * rather than hundreds of times during one drag.
 */
function scheduleUpload() {
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(upload, 3000);
}

/** Packed like a DELTA - the same 5 bytes per pixel as the wire format. */
function upload(keepalive = false) {
    uploadTimer = undefined;
    const pixels = [...draft].map(([idx, colour]) => {
        const [x, y] = toXY(idx);
        return { x, y, colour };
    });
    fetch(draftUrl(canvasId), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: encodeDelta(pixels),
        keepalive,
    }).catch(() => { /* offline is fine, localStorage still has it */ });
}

// Closing the tab inside the debounce window would leave the server a version behind, and
// the stale server copy would win on the next visit. keepalive lets the request outlive
// the page.
addEventListener("pagehide", () => {
    if (uploadTimer === undefined) return;
    clearTimeout(uploadTimer);
    upload(true);
});
