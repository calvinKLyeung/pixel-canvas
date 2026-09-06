import { W, H} from "../shared/constants.js"
import { PALETTE } from "../shared/palette.js"

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
        const colour = PALETTE[board[i]!]!;
        pixel[i * 4]     = colour[0];
        pixel[i * 4 + 1] = colour[1];
        pixel[i * 4 + 2] = colour[2];
        pixel[i * 4 + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
}