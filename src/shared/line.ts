/** go through pixels on the line from (x0, y0) to (x1 ,y1)
 * using Bresenham's Line Algorithm
 * Reference: https://youtu.be/CceepU1vIKo?si=hoTLUB9ZyVhHF77i */
export function line(
    x0:number, y0:number, x1:number, y1:number,
    plot: (x: number, y: number) => void) {

    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;

    let err = dx + dy;

    for (;;) {
        plot(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }

        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
}