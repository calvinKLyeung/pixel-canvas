import { W, H } from "../shared/constants.js";
import { EMPTY } from "../shared/palette.js";

/** 1 byte per pixel, board only stores index reference to the colour palette
 * index 0 = white and the rest follows. Starts as EMPTY, not 0, so an untouched
 * cell can be told apart from one someone painted white. */
export const board = new Uint8Array(W * H).fill(EMPTY);