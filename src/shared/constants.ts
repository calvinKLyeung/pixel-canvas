export const W = 32;
export const H = 32;

/** Convert x, y to position on the board*/
export const index = (x: number, y: number): number => y * W + x;