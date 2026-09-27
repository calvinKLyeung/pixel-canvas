// default W and H for new canvas
export const DEFAULT_W = 256;
export const DEFAULT_H = 256;
export const MAX_DIM = 512;
export const MIN_DIM = 16;
/** main is tiny on purpose: open to everyone, so small enough that nobody can swamp it. */
export const MAIN_SIZE = 16;
export const MAX_NAME_LENGTH = 40;
export const MIN_NAME_LENGTH = 1;

/** Convert (x ,y) to flat array position of pixel (x, y) on a board with some 'w' wide */
export const index = (x: number, y: number, w: number): number => y * w + x;
