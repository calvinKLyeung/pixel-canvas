import { W, H } from "../shared/constants.js"

let overlay: HTMLCanvasElement;
let overlayContext: CanvasRenderingContext2D;

const MIN_CELL_PX = 4; // anything lower looks like shit

export function initOverlay(element: HTMLCanvasElement) {
    overlay = element;
    overlayContext = element.getContext("2d")!;
    resizeOverlay();

    // ony changes if the geometry does
    new ResizeObserver(resizeOverlay).observe(element.parentElement!);
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
    const cell = rect.width / W;

    overlayContext.clearRect(0, 0, rect.width, rect.height);
    if (cell < MIN_CELL_PX) return;         // too dense to be useful

    // Fine grid: every cell
    overlayContext.lineWidth = 1;
    overlayContext.strokeStyle = "rgba(128,128,128,0.35)";
    overlayContext.beginPath();
    for (let x = 0; x <= W; x++) {
        const px = Math.round(x * cell) + 0.5;
        overlayContext.moveTo(px, 0); overlayContext.lineTo(px, rect.height);
    }
    for (let y = 0; y <= H; y++) {
        const py = Math.round(y * cell) + 0.5;
        overlayContext.moveTo(0, py); overlayContext.lineTo(rect.width, py);
    }
    overlayContext.stroke();

    // Coarse grid every 16 cells, for orientation. Only when there's room.
    if (cell >= 8) {
        overlayContext.strokeStyle = "rgba(60,60,60,0.45)";
        overlayContext.beginPath();
        for (let x = 0; x <= W; x += 16) {
            const px = Math.round(x * cell) + 0.5;
            overlayContext.moveTo(px, 0); overlayContext.lineTo(px, rect.height);
        }
        for (let y = 0; y <= H; y += 16) {
            const py = Math.round(y * cell) + 0.5;
            overlayContext.moveTo(0, py); overlayContext.lineTo(rect.width, py);
        }
        overlayContext.stroke();
    }
}