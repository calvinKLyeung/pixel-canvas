import { W, H } from "../shared/constants.js";

/** 1 byte per pixel, board only stores index reference to the colour palette
 * index 0 = white by default and the rest follows */
export const board = new Uint8Array(W * H); // 0 = white colour