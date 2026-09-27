import { PALETTE, EMPTY } from "../shared/palette.js";
import { draft, toXY } from "./draft.js";

let overlay: HTMLCanvasElement;
let overlayContext: CanvasRenderingContext2D;

/** Board dimensions of the canvas we're on. Held here because the ResizeObserver
 * calls drawGrid() with no arguments. */
let boardW = 0, boardH = 0;
let observer: ResizeObserver | undefined;

const MIN_CELL_PX = 4; // anything lower looks like shit
const COARSE_CELL_PX = 8; // coarse grid needs more room than the fine one
const COARSE_STEP = 16;   // every 16 cells

export function initOverlay(element: HTMLCanvasElement, w: number, h: number) {
    overlay = element;
    overlayContext = element.getContext("2d")!;
    boardW = w;
    boardH = h;
    resizeOverlay();

    // ony changes if the geometry does
    // reuse one observer - initOverlay runs again whenever the board dimensions change
    // if observer == null OR observer == undefined, set new Observer
    observer ??= new ResizeObserver(resizeOverlay);
    observer.observe(element.parentElement!);
}

export function resizeOverlay() {
    const rectangle = overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // 1px lines are genuinely 1px on retina?
    overlay.width = Math.round(rectangle.width * dpr);
    overlay.height = Math.round(rectangle.height * dpr);

    // working in CSS pixel for now
    overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawOverlay();
}

/** Grid plus pending draft pixels. Call whenever the draft changes. */
export function drawOverlay() {
    drawGrid();                 // clears and redraws the grid

    const rect = overlay.getBoundingClientRect();
    const cell = rect.width / boardW;
    // ceil so fractional cells overlap by a hair instead of leaving hairline gaps
    const size = Math.ceil(cell);

    // Translucent is the whole affordance: it is the only thing saying "not real yet".
    overlayContext.globalAlpha = 0.6;
    for (const [idx, colour] of draft) {
        const [x, y] = toXY(idx);
        // A pending erase in white would look exactly like a pending white paint. The
        // checkerboard's blue-grey is the colour of "unpainted", and no palette colour.
        const c = colour === EMPTY ? [163, 179, 196] : PALETTE[colour]!;
        overlayContext.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        overlayContext.fillRect(x * cell, y * cell, size, size);
    }
    overlayContext.globalAlpha = 1;
}

export function drawGrid() {
    const rect = overlay.getBoundingClientRect();
    const cell = rect.width / boardW;

    overlayContext.clearRect(0, 0, rect.width, rect.height);
    if (cell < MIN_CELL_PX) return;         // too dense to be useful

    // Fine grid: every cell
    overlayContext.lineWidth = 1;
    overlayContext.strokeStyle = "rgba(128,128,128,0.35)";
    overlayContext.beginPath();
    for (let x = 0; x <= boardW; x++) {
        const px = Math.round(x * cell) + 0.5;
        overlayContext.moveTo(px, 0); overlayContext.lineTo(px, rect.height);
    }
    for (let y = 0; y <= boardH; y++) {
        const py = Math.round(y * cell) + 0.5;
        overlayContext.moveTo(0, py); overlayContext.lineTo(rect.width, py);
    }
    overlayContext.stroke();

    // Coarse grid every 16 cells, for orientation. Only when there is room for it,
    // otherwise the two grids sit on top of each other and just look muddy.
    if (cell < COARSE_CELL_PX) return;

    overlayContext.strokeStyle = "rgba(60,60,60,0.45)";
    overlayContext.beginPath();
    for (let x = 0; x <= boardW; x += COARSE_STEP) {
        const px = Math.round(x * cell) + 0.5;
        overlayContext.moveTo(px, 0); overlayContext.lineTo(px, rect.height);
    }
    for (let y = 0; y <= boardH; y += COARSE_STEP) {
        const py = Math.round(y * cell) + 0.5;
        overlayContext.moveTo(0, py); overlayContext.lineTo(rect.width, py);
    }
    overlayContext.stroke();
}