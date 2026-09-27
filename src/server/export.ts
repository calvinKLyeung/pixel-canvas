import sharp from "sharp";
import { index } from "../shared/constants.js";
import { PALETTE, EMPTY } from "../shared/palette.js";
import type { Canvas } from "./canvas.js";

/**
 * Svg constructor, where we iterate through all the cells, when we see a vertical edge where either left or right is
 *   painted, we add the edge to svg, or when we see a horizontal edge where either above or below is patined, we add the edge to svg
 * goal is to keep the grid line overlay in the image
 * size them to the OUTPUT image
 * if we have consecutive edges, they are merged into a single edge
 * */
function gridSvg(canvas: Canvas, scale: number): Buffer {
    const { w, h, board } = canvas;

    const painted = (x: number, y: number): boolean =>
        x >= 0 && y >= 0 && x < w && y < h && board[index(x, y, w)] !== EMPTY;

    const d: string[] = [];

    // handle Vertical edges at each column boundary
    for (let x = 0; x <= w; x++) {
        let start = -1;
        for (let y = 0; y <= h; y++) {
            // does this boundary touch painted cell
            const need = y < h && (painted(x - 1, y) || painted(x, y)); // (x-1,y)|(x,y)
            if (need && start === -1) {
                start = y;
            } else if (!need && start !== -1) {
                d.push(`M${x * scale + 0.5} ${start * scale}V${y * scale}`);
                start = -1;
            } // need && start !== -1  -> Merge edge case, nothing happens
        }
    }
    // handle Horizontal edges at each row boundary
    for (let y = 0; y <= h; y++) {
        let start = -1;
        for (let x = 0; x <= w; x++) {
            // does this boundary touch painted cell
            const need = x < w && (painted(x, y - 1) || painted(x, y)); // (x,y-1)/(x,y)
            if (need && start === -1) {
                start = x;
            } else if (!need && start !== -1) {
                d.push(`M${start * scale} ${y * scale + 0.5}H${x * scale}`);
                start = -1;
            } // need && start !== -1  -> Merge edge case, nothing happens
        }
    }

    return Buffer.from(
        `<svg width="${w * scale}" height="${h * scale}" xmlns="http://www.w3.org/2000/svg">
       <path d="${d.join("")}" stroke="rgba(90,90,90,0.5)" stroke-width="1" fill="none"/>
     </svg>`
    );
}

/**
 * Rendering png file
 * */
export async function renderPng(
    canvas: Canvas, scale = 4, grid = false, alpha = false,
): Promise<Buffer> {
    const { w, h, board } = canvas;

    // Build the pixels
    // RGBA. EMPTY = unpainted: transparent when alpha On, white when alpha Off.
    // Index 0 is ordinary paintable white and always renders opaque.
    const rgba = Buffer.alloc(w * h * 4);   // zero fills
    for (let i = 0; i < board.length; i++) {
        const idx = board[i]!;
        if (idx === EMPTY) {
            // alpha = 0 means fully transparent
            if (alpha) continue;  // leave it as 0, 0, 0, 0 (default fill of alloc)
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255;  // white
            rgba[i * 4 + 3] = 255;
            continue;
        }
        // else
        const colour = PALETTE[idx]!;
        rgba[i * 4]     = colour[0];
        rgba[i * 4 + 1] = colour[1];
        rgba[i * 4 + 2] = colour[2];
        rgba[i * 4 + 3] = 255;      // alpha
    }
    // FIRST resize
    let img = sharp(rgba, { raw: {width: w, height: h, channels: 4 } })
        .resize(w * scale, h * scale, { kernel: "nearest"});

    // THEN composite
    // after the resize is done, so the grid lines will stay 1px in the output img
    if (grid && scale >= 4) {
        img = sharp(await img.png().toBuffer())
            .composite([{ input: gridSvg(canvas, scale), blend: "over"}]);  // Need these steps as composite happens BEFORE resize in chain
    }

    // grid = false
    // raw bytes -> resize -> png -> buffer
    // grid = true
    // raw bytes -> resize -> png -> buffer -> await resize is done -> reload -> composite grid -> png -> buffer
    return img.png().toBuffer();
}


/**
 * Lobby thumbnails, one render shared by every viewer for THUMB_TTL_MS. Every open lobby
 * asks for every room every 5 s, so uncached this scales with viewers x rooms, not with
 * anything being painted.
 */
const thumbs = new Map<string, { png: Buffer; at: number }>();
const THUMB_TTL_MS = 5_000;

export async function thumbnail(canvas: Canvas): Promise<Buffer> {
    const hit = thumbs.get(canvas.id);
    if (hit && Date.now() - hit.at < THUMB_TTL_MS) return hit.png;

    const png = await renderPng(canvas, 1, false, true);
    thumbs.set(canvas.id, { png, at: Date.now() });
    return png;
}

/**
 * Drop expired thumbnails. Most belong to canvases that were never resident, so eviction
 * never sees them - without this the map holds one entry per canvas ever shown, forever.
 */
export function pruneThumbnails(now = Date.now()): void {
    for (const [id, { at }] of thumbs) {
        if (now - at >= THUMB_TTL_MS) thumbs.delete(id);
    }
}



