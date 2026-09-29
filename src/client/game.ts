import {
    type GameView, type GameError, type GameRequest, type PlayerView, MIN_ROUNDS, MAX_ROUNDS,
    MAX_THEME_LENGTH, MAX_GUESS_LENGTH,
} from "../shared/game.js";

/**
 * The paint and guess panel. Everything it shows comes from the server's latest view;
 * nothing here decides a rule. The server refuses what it must, and says why.
 */

const $ = (id: string) => document.getElementById(id)!;

let view: GameView | null = null;
/** When `view` arrived, so the countdown can run between views. */
let viewAt = 0;
let send: (req: GameRequest) => void = () => {};
/** Called when whether we may paint changes, so the page can show or hide its tools. */
let onPaintChange: () => void = () => {};

const me = (): PlayerView | undefined => view?.players.find(p => p.id === view!.you);

/** Painters paint, and only while there is a word. The server checks this too. */
export function canPaint(): boolean {
    return view?.phase === "drawing" && me()?.team === "painter";
}

export function initGame(sendRequest: (req: GameRequest) => void, paintChanged: () => void) {
    send = sendRequest;
    onPaintChange = paintChanged;
    $("game").hidden = false;

    $("g-join-painter").addEventListener("click", () => send({ t: "team", team: "painter" }));
    $("g-join-guesser").addEventListener("click", () => send({ t: "team", team: "guesser" }));
    $("g-ready").addEventListener("click", () => send({ t: "ready", ready: !me()?.ready }));
    $("g-skip").addEventListener("click", () => send({ t: "skip" }));
    $("g-again").addEventListener("click", () => send({ t: "again" }));

    const themeForm = $("g-theme") as HTMLFormElement;
    const rounds = themeForm.elements.namedItem("rounds") as HTMLSelectElement;
    for (let n = MIN_ROUNDS; n <= MAX_ROUNDS; n++) rounds.add(new Option(String(n), String(n)));
    rounds.value = "5";
    (themeForm.elements.namedItem("theme") as HTMLInputElement).maxLength = MAX_THEME_LENGTH;
    themeForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const theme = (themeForm.elements.namedItem("theme") as HTMLInputElement).value;
        send({ t: "theme", theme, rounds: Number(rounds.value) });
    });

    const guessForm = $("g-guess") as HTMLFormElement;
    const guessInput = guessForm.elements.namedItem("text") as HTMLInputElement;
    guessInput.maxLength = MAX_GUESS_LENGTH;
    guessForm.addEventListener("submit", (e) => {
        e.preventDefault();
        send({ t: "guess", text: guessInput.value });
        guessInput.value = "";
    });

    setInterval(renderTimer, 250);
}

/** A text frame from the server: a new view, or why our last request was refused. */
export function onGameText(text: string) {
    const msg = JSON.parse(text) as GameView | GameError;
    if (msg.t === "error") {
        $("g-error").textContent = msg.error;
        return;
    }
    const could = canPaint();
    view = msg;
    viewAt = Date.now();
    $("g-error").textContent = "";
    render();
    if (canPaint() !== could) onPaintChange();
}

const STATUS: Record<GameView["phase"], string> = {
    lobby: "Pick a team, then press Ready",
    theme: "Waiting for the painters to pick a theme",
    drawing: "",
    over: "Game over",
};

function render() {
    const v = view!;
    const mine = me();
    const painter = mine?.team === "painter";

    $("g-status").textContent = v.phase === "drawing"
        ? `Round ${v.round} of ${v.rounds} · ${v.guessed} guessed`
        : v.phase === "theme" && v.generating ? "Making the words..."
        : v.phase === "over" ? `Game over: ${v.guessed} of ${v.rounds} guessed`
        : STATUS[v.phase];
    renderTimer();

    const word = $("g-word");
    word.hidden = v.phase !== "drawing";
    word.textContent = painter ? `Draw: ${v.word}` : v.mask;

    renderTeam($("g-painters"), v.players.filter(p => p.team === "painter"), v);
    renderTeam($("g-guessers"), v.players.filter(p => p.team === "guesser"), v);

    // Anyone may switch teams in the lobby; mid-game only someone without a team may join one.
    const canPickTeam = v.phase === "lobby" || (v.phase !== "over" && !mine?.team);
    $("g-join-painter").hidden = !canPickTeam || mine?.team === "painter";
    $("g-join-guesser").hidden = !canPickTeam || mine?.team === "guesser";
    const ready = $("g-ready") as HTMLButtonElement;
    ready.hidden = v.phase !== "lobby" || !mine?.team;
    ready.textContent = mine?.ready ? "Not ready" : "Ready";
    ready.className = mine?.ready ? "secondary" : "";

    $("g-theme").hidden = !(v.phase === "theme" && painter);
    ($("g-theme").querySelector("button") as HTMLButtonElement).disabled = v.generating;
    $("g-guess").hidden = !(v.phase === "drawing" && mine?.team === "guesser");
    $("g-skip").hidden = !(v.phase === "drawing" && painter);
    $("g-again").hidden = v.phase !== "over";

    renderGuesses(painter && v.phase === "drawing");

    const log = $("g-log");
    log.replaceChildren(...[...v.log].reverse().map(line => {
        const li = document.createElement("li");
        li.textContent = line;                  // textContent: names and guesses are user input
        return li;
    }));
}

function renderTeam(list: HTMLElement, players: PlayerView[], v: GameView) {
    list.replaceChildren(...players.map(p => {
        const li = document.createElement("li");
        const marks = [
            v.phase === "lobby" && p.ready ? "✓" : "",
            p.team === "guesser" && v.phase !== "lobby" ? `${p.points} pt` : "",
        ].filter(Boolean).join(" ");
        li.textContent = `${p.name}${p.id === v.you ? " (you)" : ""}${marks ? ` · ${marks}` : ""}`;
        return li;
    }));
    if (players.length === 0) {
        const li = document.createElement("li");
        li.textContent = "nobody yet";
        li.style.color = "var(--pico-muted-color)";
        list.append(li);
    }
}

/** Newest first. Painters get PASS / Not on anything that was not an exact match. */
function renderGuesses(canJudge: boolean) {
    const list = $("g-guesses");
    list.replaceChildren(...[...view!.guesses].reverse().map(g => {
        const li = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${g.name}: ${g.text}`;
        if (g.status !== "pending") text.className = g.status;
        li.append(text);
        if (canJudge && g.status === "pending") {
            const pass = document.createElement("button");
            pass.textContent = "PASS";
            pass.addEventListener("click", () => send({ t: "judge", guessId: g.id, pass: true }));
            const not = document.createElement("button");
            not.textContent = "Not";
            not.className = "secondary outline";
            not.addEventListener("click", () => send({ t: "judge", guessId: g.id, pass: false }));
            li.append(pass, not);
        }
        return li;
    }));
}

function renderTimer() {
    const timer = $("g-timer");
    if (view?.phase !== "drawing") {
        timer.textContent = "";
        return;
    }
    const s = Math.ceil(Math.max(0, view.msLeft - (Date.now() - viewAt)) / 1000);
    timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    timer.style.color = s <= 10 ? "var(--pico-del-color)" : "";
}
