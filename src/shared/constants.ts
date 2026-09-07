export const W = 64;
export const H = 64;

/** Convert x, y to position on the board*/
export const index = (x: number, y: number): number => y * W + x;