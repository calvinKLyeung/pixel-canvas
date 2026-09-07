export const W = 256;
export const H = 256;

/** Convert x, y to position on the board*/
export const index = (x: number, y: number): number => y * W + x;