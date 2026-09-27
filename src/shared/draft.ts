/**
 * Most pixels one draft may hold. At a 5s cooldown 200 is about 17 minutes of draining -
 * a lot, but recognisably deliberate. A careless drag across the board would otherwise
 * queue hundreds and look broken. Shared so the server can size the draft upload limit.
 */
export const MAX_DRAFT = 200;
