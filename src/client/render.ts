import { W, H} from "../shared/constants.js"
import { PALETTE, EMPTY } from "../shared/palette.js"

const WHITE: readonly [number, number, number] = [255, 255, 255];

let context: CanvasRenderingContext2D;
let imageData: ImageData;

export function initRenderer(canvas: HTMLCanvasElement) {
    // render pixel grid as our canvas
    canvas.width = W;
    canvas.height = H;
    context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    imageData = context.createImageData(W, H);
}

/** represent RGBA which */
export function render(board: Uint8Array) {
    const pixel = imageData.data;
    for (let i = 0; i < board.length; i++) {
        const idx = board[i]!;
        // EMPTY is not a palette index - draw it as white, the canvas stays opaque
        const colour = idx === EMPTY ? WHITE : PALETTE[idx]!;
        pixel[i * 4]     = colour[0];
        pixel[i * 4 + 1] = colour[1];
        pixel[i * 4 + 2] = colour[2];
        pixel[i * 4 + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
}