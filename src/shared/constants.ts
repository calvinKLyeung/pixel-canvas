// default W and H for new canvas
export const DEFAULT_W = 256;
export const DEFAULT_H = 256;
export const MAX_DIM = 512;
export const MIN_DIM = 16;
export const MAX_COOLDOWN = 300_000;
export const MIN_COOLDOWN = 1000;
export const MAX_NAME_LENGTH = 40;
export const MIN_NAME_LENGTH = 1;

/** Convert (x ,y) to flat array position of pixel (x, y) on a board with some 'w' wide */
export const index = (x: number, y: number, w: number): number => y * w + x;
