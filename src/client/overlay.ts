let overlay: HTMLCanvasElement;
let overlayContext: CanvasRenderingContext2D;

/** Board dimensions of the canvas we're on. Held here because the ResizeObserver
 * calls drawGrid() with no arguments. */
let boardW = 0, boardH = 0;
/** Overlay pixels per board cell. */
let k = 1;
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

    // The overlay is a whole multiple of the board, k pixels per cell, and pixelated
    // like the board. The browser then scales both with the same nearest-neighbour
    // rule, so overlay pixel x*k starts exactly where cell x does - wherever the stage
    // lands on the page, fractional offsets and sizes included. Drawing at screen
    // resolution and rounding ourselves can't do that: the browser resamples the
    // overlay whenever its box is off the device-pixel grid.
    // k is picked so one overlay pixel is about one CSS pixel on screen. Rounded down:
    // an overlay bigger than its box gets shrunk, which drops pixels - grid lines.
    const line = Math.max(1, Math.round(dpr));
    k = Math.max(1, Math.floor(rectangle.width * dpr / boardW / line));
    overlay.width = boardW * k;
    overlay.height = boardH * k;

    drawGrid();
}

export function drawGrid() {
    const cell = overlay.getBoundingClientRect().width / boardW;   // CSS px
    const W = overlay.width, H = overlay.height;

    overlayContext.clearRect(0, 0, W, H);
    if (cell < MIN_CELL_PX) return;         // too dense to be useful

    // Each line is the first overlay pixel of its cell.
    // Fine grid: every cell
    overlayContext.fillStyle = "rgba(128,128,128,0.35)";
    for (let x = 0; x <= boardW; x++) overlayContext.fillRect(x * k, 0, 1, H);
    for (let y = 0; y <= boardH; y++) overlayContext.fillRect(0, y * k, W, 1);

    // Coarse grid every 16 cells, for orientation. Only when there is room for it,
    // otherwise the two grids sit on top of each other and just look muddy.
    if (cell < COARSE_CELL_PX) return;

    overlayContext.fillStyle = "rgba(60,60,60,0.45)";
    for (let x = 0; x <= boardW; x += COARSE_STEP) overlayContext.fillRect(x * k, 0, 1, H);
    for (let y = 0; y <= boardH; y += COARSE_STEP) overlayContext.fillRect(0, y * k, W, 1);
}
