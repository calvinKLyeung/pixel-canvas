/**
 * Paint and guess: what the browser and the server agree on. Game messages travel as JSON
 * text frames on the same WebSocket as the binary pixel protocol - the ws library tells
 * the two apart, so no type byte is spent on them.
 */

export type Team = "painter" | "guesser";
export type Phase = "lobby" | "theme" | "drawing" | "over";

/** Every game board is this size: small enough to draw on quickly, big enough to draw something. */
export const GAME_SIZE = 64;
export const ROUND_MS = 90_000;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 10;
export const MAX_THEME_LENGTH = 60;
export const MAX_GUESS_LENGTH = 40;

/** Browser -> server. The server fills in who sent it from the socket, never from here. */
export type GameRequest =
    | { t: "team"; team: Team }
    | { t: "ready"; ready: boolean }
    | { t: "theme"; theme: string; rounds: number }
    | { t: "guess"; text: string }
    | { t: "judge"; guessId: number; pass: boolean }
    | { t: "skip" }
    | { t: "again" };

export interface PlayerView {
    id: number;
    name: string;
    team: Team | null;
    ready: boolean;
    points: number;
}

export interface GuessView {
    id: number;
    name: string;
    text: string;
    status: "pending" | "rejected" | "correct";
}

/** Server -> browser, one per socket: only painters are sent the word. */
export interface GameView {
    t: "game";
    you: number;
    phase: Phase;
    players: PlayerView[];
    rounds: number;
    round: number;
    theme: string;
    /** The word, for painters. Everyone else gets null and reads `mask`. */
    word: string | null;
    /** The word with every letter blanked, so guessers know its length and spaces. */
    mask: string;
    /** Time left in this round when the view was made. A countdown, not a timestamp,
     * so a browser whose clock is off still counts down correctly. */
    msLeft: number;
    generating: boolean;
    /** Rounds the guessers got. */
    guessed: number;
    guesses: GuessView[];
    /** What happened recently, oldest first: words revealed, who guessed, who left. */
    log: string[];
}

/** Server -> browser: a request was refused, e.g. "only painters can skip". */
export interface GameError {
    t: "error";
    error: string;
}

/**
 * What counts as an exact match: case, spacing and punctuation ignored, so "Ice-cream",
 * "ice cream" and "icecream " all hit "ice cream". Anything else goes to the painters.
 */
export function normalizeGuess(s: string): string {
    return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function maskWord(word: string): string {
    return word.replace(/[\p{L}\p{N}]/gu, "_");
}
