import { DEFAULT_W, DEFAULT_H, MIN_DIM, MAX_DIM, MIN_COOLDOWN, MAX_COOLDOWN } from "../shared/constants.js";
import { validateCreate } from "../shared/canvasConfig.js";
import { mountAuth } from "./auth.js";

// Logged in, a canvas you create is yours - which is what lets you clear it later.
mountAuth(document.getElementById("auth")!);

/** One row of GET /api/canvases */
interface CanvasSummary {
    id: string;
    name: string;
    w: number;
    h: number;
    clients: number;
}

const listElem = document.getElementById("list")!;
const formElem = document.getElementById("create") as HTMLFormElement;
const errorElem = document.getElementById("error")!;

/** Fetch the public canvases and draw the list. */
async function refresh(): Promise<void> {
    const canvases: CanvasSummary[] = await (await fetch("/api/canvases")).json();

    listElem.replaceChildren(...canvases.map(canvas => {
        const link = document.createElement("a");
        link.href = `/c/${encodeURIComponent(canvas.id)}`;
        link.textContent = canvas.name;

        const detail = document.createElement("small");
        // clients.size is 0 for an evicted canvas, which is correct by definition
        detail.textContent = ` — ${canvas.w}x${canvas.h} · ${canvas.clients} painting now`;

        const row = document.createElement("li");
        row.append(link, detail);
        return row;
    }));
}

/** Read the form, converting the seconds the user typed into the ms the API wants. */
function readForm(): unknown {
    const data = new FormData(formElem);
    return {
        name: String(data.get("name") ?? ""),
        w: Number(data.get("w")),
        h: Number(data.get("h")),
        cooldownMs: Number(data.get("cooldown")) * 1000,
    };
}

formElem.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Same validation the server runs - this is why validateCreate lives in shared/
    const request = readForm();
    const error = validateCreate(request);
    if (error) {
        errorElem.textContent = error;
        return;
    }
    errorElem.textContent = "";

    const reply = await fetch("/api/canvas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });

    if (!reply.ok) {
        // The server validates again - never trust the client to have done it
        errorElem.textContent = (await reply.json()).error ?? "could not create canvas";
        return;
    }

    const { id } = await reply.json() as { id: string };
    location.href = `/c/${encodeURIComponent(id)}`;
});

// Fill the size fields with the defaults and the bounds the validator enforces
(formElem.elements.namedItem("w") as HTMLInputElement).value = String(DEFAULT_W);
(formElem.elements.namedItem("h") as HTMLInputElement).value = String(DEFAULT_H);
for (const name of ["w", "h"]) {
    const input = formElem.elements.namedItem(name) as HTMLInputElement;
    input.min = String(MIN_DIM);
    input.max = String(MAX_DIM);
}
const cooldownInput = formElem.elements.namedItem("cooldown") as HTMLInputElement;
cooldownInput.min = String(MIN_COOLDOWN / 1000);
cooldownInput.max = String(MAX_COOLDOWN / 1000);

refresh();
