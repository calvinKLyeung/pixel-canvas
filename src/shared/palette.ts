/**
 * Colour palette, index 0 as default background.
 *
 * Boards and the event log store these indexes, so an existing entry must never move or
 * change colour - that would repaint every saved drawing. New colours are only appended.
 * 0-15 are the original set; 16-63 fill in shade ramps, since pixel art shades a shape
 * with 3-4 steps of one hue rather than one flat colour.
 */
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
    // greys - pure greys, like 0-3, so none can be mistaken for the blue-grey checkerboard
    [ 12,  12,  12], // 16 outline black
    [ 64,  64,  64], // 17
    [ 96,  96,  96], // 18
    [180, 180, 180], // 19
    // reds
    [ 46,   8,  16], // 20
    [ 94,  16,  30], // 21
    [156,  26,  40], // 22
    [255,  90,  74], // 23
    [255, 145, 128], // 24
    [255, 196, 186], // 25
    [255, 232, 227], // 26
    // browns and skin
    [ 46,  26,  16], // 27
    [ 90,  52,  32], // 28
    [201, 140,  90], // 29
    [245, 184, 119], // 30
    [255, 217, 176], // 31
    [255, 240, 222], // 32
    // yellows
    [ 58,  48,   0], // 33
    [110,  92,   0], // 34
    [168, 144,   0], // 35
    [245, 234,  74], // 36
    [255, 245, 138], // 37
    [255, 250, 194], // 38
    [255, 253, 232], // 39
    // greens, with muted ones for foliage and screens
    [ 11,  42,  20], // 40
    [ 22,  74,  36], // 41
    [ 31, 110,  53], // 42
    [ 63, 166,  90], // 43
    [158, 217, 168], // 44
    [218, 245, 208], // 45
    // teals
    [  6,  42,  48], // 46
    [ 12,  79,  88], // 47
    [ 18, 128, 136], // 48
    [ 16, 168, 180], // 49
    [106, 232, 238], // 50
    [176, 244, 246], // 51
    [226, 252, 253], // 52
    // blues
    [ 10,  15,  58], // 53
    [ 31,  63, 176], // 54
    [ 58, 160, 240], // 55
    [124, 196, 255], // 56
    [184, 222, 255], // 57
    [228, 242, 255], // 58
    // purples
    [ 42,  12,  58], // 59
    [138,  79, 176], // 60
    [178, 127, 214], // 61
    [217, 170, 236], // 62
    [244, 224, 251], // 63
] as const;

export const PALETTE_SIZE = PALETTE.length;

/**
 * The picker's layout: one row per hue, darkest to lightest. The indexes above are in the
 * order colours were added, which is no use for finding the next shade up.
 */
export const PALETTE_RAMPS: readonly (readonly number[])[] = [
    [16,  3, 17, 18,  2, 19,  1,  0],   // grey
    [20, 21, 22,  5, 23, 24, 25, 26],   // red
    [27, 28,  7, 29,  6, 30, 31, 32],   // brown, orange, skin
    [33, 34, 35,  8, 36, 37, 38, 39],   // yellow
    [40, 41, 42, 10, 43,  9, 44, 45],   // green
    [46, 47, 48, 49, 11, 50, 51, 52],   // teal
    [53, 13, 54, 12, 55, 56, 57, 58],   // blue
    [59, 15, 60, 61, 14, 62,  4, 63],   // purple, pink
];

/** Unpainted cell. Not a palette index - keeps "never touched" separate from index 0,
 * which stays paintable white. Clients may send it to erase: the place handler allows it
 * by name. */
export const EMPTY = 255;

/** CSS colour for buttons*/
export function cssColour(i: number): string {
    const colour = PALETTE[i]!;
    return `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`;
}
