/** Colour palette with 16 colours to choose from, index 0 as default background */
export const PALETTE: readonly [number, number, number][] = [
    [255, 255, 255], // 0  white
    [228, 228, 228], // 1  light grey
    [136, 136, 136], // 2  grey
    [ 34,  34,  34], // 3  black
    [255, 167, 209], // 4  pink
    [229,   0,   0], // 5  red
    [229, 149,   0], // 6  orange
    [160, 106,  66], // 7  brown
    [229, 217,   0], // 8  yellow
    [148, 224,  68], // 9  light green
    [  2, 190,   1], // 10 green
    [  0, 211, 221], // 11 cyan
    [  0, 131, 199], // 12 blue
    [  0,   0, 234], // 13 dark blue
    [207, 110, 228], // 14 magenta
    [130,   0, 128], // 15 purple
] as const;

export const PALETTE_SIZE = PALETTE.length;

/** CSS colour for buttons*/
export function cssColour(i: number): string {
    const colour = PALETTE[i]!;
    return `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`;
}