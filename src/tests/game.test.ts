import { describe, it, expect } from "vitest";
import { step, newGame, viewFor, PRESENCE_MS, SPARE_WORDS, type GameState, type GameAction } from "../server/game.js";
import { ROUND_MS, normalizeGuess } from "../shared/game.js";

const PAINTER = 1, GUESSER = 2, OTHER = 3;
const T0 = 1_000_000;

/** Apply actions in order, failing the test on any refusal. */
function run(state: GameState, actions: GameAction[], now = T0): GameState {
    for (const action of actions) {
        const r = step(state, action, now);
        expect(r.error).toBeUndefined();
        state = r.state;
    }
    return state;
}

const joined = (...ids: number[]) =>
    run(newGame(), [{ type: "heartbeat", users: ids.map(id => ({ id, name: `p${id}` })) }]);

/** Two players, one per team, both ready: the game is waiting for a theme. */
function atTheme(): GameState {
    return run(joined(PAINTER, GUESSER), [
        { type: "team", userId: PAINTER, team: "painter" },
        { type: "team", userId: GUESSER, team: "guesser" },
        { type: "ready", userId: PAINTER, ready: true },
        { type: "ready", userId: GUESSER, ready: true },
    ]);
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`);

function drawing(rounds = 2): GameState {
    return run(atTheme(), [
        { type: "theme", userId: PAINTER, theme: "animals", rounds },
        { type: "words", words: words(rounds + SPARE_WORDS), fromAi: true },
    ]);
}

describe("starting", () => {
    it("waits until both teams have someone and everyone is ready", () => {
        let s = run(joined(PAINTER, GUESSER), [
            { type: "team", userId: PAINTER, team: "painter" },
            { type: "ready", userId: PAINTER, ready: true },
        ]);
        expect(s.phase).toBe("lobby");
        s = run(s, [{ type: "team", userId: GUESSER, team: "painter" }, { type: "ready", userId: GUESSER, ready: true }]);
        expect(s.phase).toBe("lobby");     // everyone ready, but no guessers
        expect(atTheme().phase).toBe("theme");
    });

    it("is held up by a player who has not picked a team", () => {
        const s = run(joined(PAINTER, GUESSER, OTHER), [
            { type: "team", userId: PAINTER, team: "painter" },
            { type: "team", userId: GUESSER, team: "guesser" },
            { type: "ready", userId: PAINTER, ready: true },
            { type: "ready", userId: GUESSER, ready: true },
        ]);
        expect(s.phase).toBe("lobby");
    });

    it("lets only painters pick the theme, and only in range", () => {
        const s = atTheme();
        expect(step(s, { type: "theme", userId: GUESSER, theme: "x", rounds: 3 }, T0).error).toBeDefined();
        expect(step(s, { type: "theme", userId: PAINTER, theme: "x", rounds: 0 }, T0).error).toBeDefined();
        expect(step(s, { type: "theme", userId: PAINTER, theme: "  ", rounds: 3 }, T0).error).toBeDefined();
    });

    it("starts round 1 with the first word and a clean board", () => {
        const r = step(run(atTheme(), [{ type: "theme", userId: PAINTER, theme: "animals", rounds: 3 }]),
            { type: "words", words: words(8), fromAi: true }, T0);
        expect(r.state.phase).toBe("drawing");
        expect(r.state.round).toBe(1);
        expect(r.state.word).toBe("word0");
        expect(r.clearBoard).toBe(true);
    });
});

describe("guessing", () => {
    it("ends the round on an exact match, ignoring case and punctuation", () => {
        const s = run(drawing(), [{ type: "guess", userId: GUESSER, text: " WORD-0 " }]);
        expect(s.round).toBe(2);
        expect(s.guessed).toBe(1);
        expect(s.players.find(p => p.id === GUESSER)!.points).toBe(1);
    });

    it("leaves anything else for the painters to judge", () => {
        let s = run(drawing(), [{ type: "guess", userId: GUESSER, text: "wrd0" }]);
        expect(s.round).toBe(1);
        const id = s.guesses[0]!.id;
        expect(step(s, { type: "judge", userId: GUESSER, guessId: id, pass: true }, T0).error).toBeDefined();

        s = run(s, [{ type: "judge", userId: PAINTER, guessId: id, pass: true }]);
        expect(s.round).toBe(2);
        expect(s.guessed).toBe(1);
    });

    it("keeps the round going when a guess is judged wrong", () => {
        let s = run(drawing(), [{ type: "guess", userId: GUESSER, text: "dog" }]);
        s = run(s, [{ type: "judge", userId: PAINTER, guessId: s.guesses[0]!.id, pass: false }]);
        expect(s.round).toBe(1);
        expect(s.guesses[0]!.status).toBe("rejected");
    });

    it("does not let painters guess", () => {
        expect(step(drawing(), { type: "guess", userId: PAINTER, text: "word0" }, T0).error).toBeDefined();
    });

    it("ends the game after the last round", () => {
        const s = run(drawing(2), [
            { type: "guess", userId: GUESSER, text: "word0" },
            { type: "guess", userId: GUESSER, text: "word1" },
        ]);
        expect(s.phase).toBe("over");
        expect(s.guessed).toBe(2);
    });
});

describe("skipping and time", () => {
    it("swaps in a spare word without using up a round", () => {
        const s = run(drawing(2), [{ type: "skip", userId: PAINTER }]);
        expect(s.round).toBe(1);
        expect(s.word).toBe("word1");
    });

    it("keeps enough words for the rounds still to come", () => {
        let s = drawing(2);
        for (let i = 0; i < SPARE_WORDS; i++) s = run(s, [{ type: "skip", userId: PAINTER }]);
        expect(step(s, { type: "skip", userId: PAINTER }, T0).error).toBe("no spare words left");
    });

    it("moves on when the clock runs out", () => {
        const s = drawing(2);
        const heartbeat: GameAction = { type: "heartbeat", users: [{ id: PAINTER, name: "p1" }, { id: GUESSER, name: "p2" }] };
        expect(run(s, [heartbeat], T0 + ROUND_MS - 1).round).toBe(1);
        const after = run(s, [heartbeat], T0 + ROUND_MS);
        expect(after.round).toBe(2);
        expect(after.guessed).toBe(0);
    });
});

describe("players coming and going", () => {
    it("goes back to the lobby when a team empties", () => {
        const s = run(drawing(), [{ type: "leave", userId: GUESSER }]);
        expect(s.phase).toBe("lobby");
        expect(s.players.every(p => !p.ready)).toBe(true);
    });

    it("drops players nobody has vouched for lately", () => {
        const s = run(drawing(), [{ type: "heartbeat", users: [{ id: PAINTER, name: "p1" }] }], T0 + PRESENCE_MS + 1);
        expect(s.players.map(p => p.id)).toEqual([PAINTER]);
        expect(s.phase).toBe("lobby");
    });

    it("fixes teams mid-game, but lets a newcomer join one", () => {
        let s = run(drawing(), [{ type: "heartbeat", users: [{ id: OTHER, name: "p3" }] }]);
        expect(step(s, { type: "team", userId: PAINTER, team: "guesser" }, T0).error).toBeDefined();
        s = run(s, [{ type: "team", userId: OTHER, team: "guesser" }]);
        expect(s.players.find(p => p.id === OTHER)!.team).toBe("guesser");
    });
});

describe("views", () => {
    it("shows the word to painters only", () => {
        const s = drawing();
        expect(viewFor(s, PAINTER, T0).word).toBe("word0");
        expect(viewFor(s, GUESSER, T0).word).toBeNull();
        expect(viewFor(s, GUESSER, T0).mask).toBe("_____");
        expect(JSON.stringify(viewFor(s, GUESSER, T0))).not.toContain("word0");
    });

    it("never leaks the spare words", () => {
        expect(JSON.stringify(viewFor(drawing(), PAINTER, T0))).not.toContain("word1");
    });
});

describe("normalizeGuess", () => {
    it("ignores case, spaces and punctuation", () => {
        expect(normalizeGuess("Ice-Cream!")).toBe(normalizeGuess("ice cream"));
        expect(normalizeGuess("café")).toBe("café");
    });
});
