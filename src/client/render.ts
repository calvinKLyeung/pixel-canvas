import { PALETTE, EMPTY } from "../shared/palette.js"

let context: CanvasRenderingContext2D;
let imageData: ImageData;

/** Dimensions come from the SNAPSHOT header - the client never assumes a size. */
export function initRenderer(canvas: HTMLCanvasElement, w: number, h: number) {
    // render pixel grid as our canvas
    canvas.width = w;
    canvas.height = h;
    context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    imageData = context.createImageData(w, h);
}

/** represent RGBA which */
export function render(board: Uint8Array) {
    const pixel = imageData.data;
    for (let i = 0; i < board.length; i++) {
        const idx = board[i]!;

        // EMPTY is not a palette index. Leave it fully transparent so the #stage
        // checkerboard shows through - that is what keeps "unpainted" visibly
        // different from index 0, which is a paintable white.
        // Zero the RGB too: imageData is reused between frames, and stale colour
        // sitting at alpha 0 can ghost during compositing.
        if (idx === EMPTY) {
            pixel[i * 4] = pixel[i * 4 + 1] = pixel[i * 4 + 2] = pixel[i * 4 + 3] = 0;
            continue;
        }

        const colour = PALETTE[idx]!;
        pixel[i * 4]     = colour[0];
        pixel[i * 4 + 1] = colour[1];
        pixel[i * 4 + 2] = colour[2];
        pixel[i * 4 + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
}