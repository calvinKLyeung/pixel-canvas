let overlay: HTMLCanvasElement;
let overlayContext: CanvasRenderingContext2D;

/** Board dimensions of the canvas we're on. Held here because the ResizeObserver
 * calls drawGrid() with no arguments. */
let boardW = 0, boardH = 0;
let observer: ResizeObserver | undefined;

const MIN_CELL_PX = 4; // anything lower looks like shit

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

    drawGrid();
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
}