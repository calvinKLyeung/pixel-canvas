import {
    type Team, type Phase, type GameView, ROUND_MS, MIN_ROUNDS, MAX_ROUNDS, MAX_THEME_LENGTH,
    MAX_GUESS_LENGTH, normalizeGuess, maskWord,
} from "../shared/game.js";

/**
 * The rules of paint and guess, as one pure function: a state and an action in, the next
 * state out. No sockets, no Redis, no clock of its own - so every rule can be tested by
 * calling it, and every process that applies the same action gets the same result.
 */

/** Words asked for beyond one per round, so a painter can skip one they don't want to draw. */
export const SPARE_WORDS = 5;

/** A player nobody has vouched for in this long has gone (see heartbeat). */
export const PRESENCE_MS = 15_000;

/** A word request older than this was lost with its process; stop waiting for it. */
export const GENERATING_MS = 30_000;

const MAX_GUESSES = 50;
const MAX_LOG = 20;

export interface Player {
    id: number;
    name: string;
    team: Team | null;
    ready: boolean;
    points: number;
    seenAt: number;
}

export interface Guess {
    id: number;
    by: number;
    name: string;
    text: string;
    status: "pending" | "rejected" | "correct";
}

export interface GameState {
    phase: Phase;
    players: Player[];
    rounds: number;
    round: number;
    theme: string;
    word: string | null;
    /** Words not drawn yet. The next round, or a skip, takes the first. */
    spares: string[];
    deadline: number;
    /** When the word request went out, or 0 when there is none. */
    generatingAt: number;
    guessed: number;
    guesses: Guess[];
    nextGuessId: number;
    log: string[];
}

export type GameAction =
    /** Everyone this process has a socket for is still here. Also where time passes. */
    | { type: "heartbeat"; users: { id: number; name: string }[] }
    | { type: "leave"; userId: number }
    | { type: "team"; userId: number; team: Team }
    | { type: "ready"; userId: number; ready: boolean }
    | { type: "theme"; userId: number; theme: string; rounds: number }
    /** fromAi false: the built-in list stood in, so the words ignore the theme. */
    | { type: "words"; words: string[]; fromAi: boolean }
    | { type: "guess"; userId: number; text: string }
    | { type: "judge"; userId: number; guessId: number; pass: boolean }
    | { type: "skip"; userId: number }
    | { type: "again"; userId: number };

export interface StepResult {
    state: GameState;
    /** Why the action was refused, for the player who sent it. The state is unchanged. */
    error?: string;
    /** A new round started: the board must be wiped for everyone. */
    clearBoard?: boolean;
}

export function newGame(): GameState {
    return {
        phase: "lobby", players: [], rounds: 0, round: 0, theme: "", word: null, spares: [],
        deadline: 0, generatingAt: 0, guessed: 0, guesses: [], nextGuessId: 1, log: [],
    };
}

export function step(prev: GameState, action: GameAction, now: number): StepResult {
    // Work on a copy, so a refused action can hand back `prev` untouched.
    const s: GameState = structuredClone(prev);
    const result: StepResult = { state: s };
    const refuse = (error: string): StepResult => ({ state: prev, error });
    const player = "userId" in action ? s.players.find(p => p.id === action.userId) : undefined;

    switch (action.type) {
        case "heartbeat": {
            for (const u of action.users) {
                const known = s.players.find(p => p.id === u.id);
                if (known) known.seenAt = now;
                else s.players.push({ id: u.id, name: u.name, team: null, ready: false, points: 0, seenAt: now });
            }
            for (const gone of s.players.filter(p => now - p.seenAt > PRESENCE_MS)) {
                removePlayer(s, gone);
            }
            if (s.generatingAt && now - s.generatingAt > GENERATING_MS) s.generatingAt = 0;
            if (s.phase === "drawing" && now >= s.deadline) {
                addLog(s, `Time's up! The word was "${s.word}".`);
                nextRound(s, result, now);
            }
            break;
        }

        case "leave": {
            if (player) removePlayer(s, player);
            break;
        }

        case "team": {
            if (!player) return refuse("you are not in this game");
            // Mid-game, a painter who became a guesser would already know the word.
            if (s.phase !== "lobby" && player.team !== null) {
                return refuse("teams are fixed until the game ends");
            }
            player.team = action.team;
            player.ready = false;
            break;
        }

        case "ready": {
            if (!player) return refuse("you are not in this game");
            if (s.phase !== "lobby") return refuse("the game has already started");
            if (!player.team) return refuse("pick a team first");
            player.ready = action.ready;
            break;
        }

        case "theme": {
            if (player?.team !== "painter") return refuse("only painters choose the theme");
            if (s.phase !== "theme") return refuse("it is not time to choose a theme");
            if (s.generatingAt) return refuse("already making the words");
            const theme = action.theme.trim();
            if (theme.length < 1 || theme.length > MAX_THEME_LENGTH) {
                return refuse(`the theme must be 1-${MAX_THEME_LENGTH} characters`);
            }
            if (!Number.isInteger(action.rounds) || action.rounds < MIN_ROUNDS || action.rounds > MAX_ROUNDS) {
                return refuse(`rounds must be ${MIN_ROUNDS}-${MAX_ROUNDS}`);
            }
            s.theme = theme;
            s.rounds = action.rounds;
            s.generatingAt = now;
            break;
        }

        case "words": {
            // Late: the game went back to the lobby while the words were being made.
            if (s.phase !== "theme" || !s.generatingAt) return refuse("no longer waiting for words");
            if (action.words.length < s.rounds) return refuse("not enough words");
            s.generatingAt = 0;
            s.phase = "drawing";
            s.round = 1;
            s.guessed = 0;
            for (const p of s.players) p.points = 0;
            s.spares = [...action.words];
            s.log = [];
            addLog(s, action.fromAi
                ? `Theme: ${s.theme}. Round 1 of ${s.rounds}.`
                : `The word maker is unavailable, so these are random words. Round 1 of ${s.rounds}.`);
            startRound(s, result, now);
            break;
        }

        case "guess": {
            if (s.phase !== "drawing") return refuse("nothing to guess right now");
            if (player?.team !== "guesser") return refuse("only guessers can guess");
            const text = action.text.trim();
            if (text.length < 1 || text.length > MAX_GUESS_LENGTH) {
                return refuse(`a guess must be 1-${MAX_GUESS_LENGTH} characters`);
            }
            const guess: Guess = { id: s.nextGuessId++, by: player.id, name: player.name, text, status: "pending" };
            s.guesses.push(guess);
            s.guesses = s.guesses.slice(-MAX_GUESSES);
            if (normalizeGuess(text) === normalizeGuess(s.word!)) correct(s, result, guess, now);
            break;
        }

        case "judge": {
            if (s.phase !== "drawing") return refuse("nothing to judge right now");
            if (player?.team !== "painter") return refuse("only painters judge guesses");
            const guess = s.guesses.find(g => g.id === action.guessId);
            if (guess?.status !== "pending") return refuse("that guess was already judged");
            if (action.pass) correct(s, result, guess, now);
            else guess.status = "rejected";
            break;
        }

        case "skip": {
            if (s.phase !== "drawing") return refuse("nothing to skip right now");
            if (player?.team !== "painter") return refuse("only painters can skip");
            // Every later round still needs a word of its own.
            if (s.spares.length <= s.rounds - s.round) return refuse("no spare words left");
            addLog(s, `${player.name} skipped a word.`);
            startRound(s, result, now);
            break;
        }

        case "again": {
            if (!player) return refuse("you are not in this game");
            if (s.phase !== "over") return refuse("the game is not over");
            backToLobby(s);
            result.clearBoard = true;
            break;
        }
    }

    // After every action, not just "ready": a player leaving can be what makes everyone
    // left ready, and a team emptying mid-game has to end it.
    checkTeams(s, result);
    return result;
}

function addLog(s: GameState, line: string) {
    s.log.push(line);
    s.log = s.log.slice(-MAX_LOG);
}

function removePlayer(s: GameState, gone: Player) {
    s.players = s.players.filter(p => p !== gone);
    addLog(s, `${gone.name} left.`);
}

/** Take the next word and restart the clock, on a fresh board with no guesses. */
function startRound(s: GameState, result: StepResult, now: number) {
    s.word = s.spares.shift()!;
    s.deadline = now + ROUND_MS;
    s.guesses = [];
    result.clearBoard = true;
}

function correct(s: GameState, result: StepResult, guess: Guess, now: number) {
    guess.status = "correct";
    s.guessed += 1;
    const guesser = s.players.find(p => p.id === guess.by);
    if (guesser) guesser.points += 1;
    addLog(s, `${guess.name} got it: "${s.word}".`);
    nextRound(s, result, now);
}

function nextRound(s: GameState, result: StepResult, now: number) {
    if (s.round >= s.rounds) {
        s.phase = "over";
        s.word = null;
        addLog(s, `Game over: ${s.guessed} of ${s.rounds} guessed.`);
        return;
    }
    s.round += 1;
    addLog(s, `Round ${s.round} of ${s.rounds}.`);
    startRound(s, result, now);
}

function backToLobby(s: GameState) {
    s.phase = "lobby";
    s.word = null;
    s.spares = [];
    s.guesses = [];
    s.generatingAt = 0;
    for (const p of s.players) p.ready = false;
}

function checkTeams(s: GameState, result: StepResult) {
    const painters = s.players.filter(p => p.team === "painter");
    const guessers = s.players.filter(p => p.team === "guesser");
    const bothTeams = painters.length > 0 && guessers.length > 0;

    if (s.phase === "lobby") {
        if (bothTeams && s.players.every(p => p.team && p.ready)) {
            s.phase = "theme";
            addLog(s, "Everyone is ready. Painters, pick a theme.");
        }
    } else if ((s.phase === "theme" || s.phase === "drawing") && !bothTeams) {
        addLog(s, "A team is empty - back to the lobby.");
        backToLobby(s);
        result.clearBoard = true;
    }
}

/** What one player is shown. Only painters see the word while it is being drawn. */
export function viewFor(s: GameState, userId: number, now: number): GameView {
    const me = s.players.find(p => p.id === userId);
    return {
        t: "game",
        you: userId,
        phase: s.phase,
        players: s.players.map(({ id, name, team, ready, points }) => ({ id, name, team, ready, points })),
        rounds: s.rounds,
        round: s.round,
        theme: s.theme,
        word: me?.team === "painter" ? s.word : null,
        mask: s.word ? maskWord(s.word) : "",
        msLeft: s.phase === "drawing" ? Math.max(0, s.deadline - now) : 0,
        generating: s.generatingAt !== 0,
        guessed: s.guessed,
        guesses: s.guesses.map(({ id, name, text, status }) => ({ id, name, text, status })),
        log: s.log,
    };
}
