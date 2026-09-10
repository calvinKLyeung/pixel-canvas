// export const W = 256;
// export const H = 256;

// default W and H for new canvas
export const DEFAULT_W = 256;
export const DEFAULT_H = 256;
export const MAX_DIM = 512;
export const MIN_DIM = 16;

/** Convert (x ,y) to flat array position of pixel (x, y) on a board with some 'w' wide */
export const index = (x: number, y: number, w: number): number => y * w + x;
