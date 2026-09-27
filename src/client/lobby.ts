import { DEFAULT_W, DEFAULT_H, MIN_DIM, MAX_DIM } from "../shared/constants.js";
import { validateCreate } from "../shared/canvasConfig.js";
import { me, renderAccount, openLogin } from "./auth.js";

/** One row of GET /api/canvases */
interface Room {
    id: string;
    name: string;
    w: number;
    h: number;
    ownerName: string | null;
    isPublic: boolean;
    mine: boolean;
    canEnter: boolean;
    code?: string | null;
    clients: number;
}

const roomsElem = document.getElementById("rooms")!;
const errorElem = document.getElementById("error")!;
const createDialog = document.getElementById("create-dialog") as HTMLDialogElement;
const formElem = document.getElementById("create") as HTMLFormElement;
const createErrorElem = document.getElementById("create-error")!;

/** How often tiles refresh, so thumbnails show what people are drawing right now. */
const REFRESH_MS = 5000;

const roomUrl = (id: string) => `/c/${encodeURIComponent(id)}`;
const apiUrl = (id: string, rest = "") => `/api/c/${encodeURIComponent(id)}${rest}`;

/** POST/PATCH/DELETE with a JSON body. Returns the error message, or null if it worked. */
async function send(method: string, url: string, body?: unknown): Promise<string | null> {
    const reply = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (reply.ok) return null;
    return (await reply.json().catch(() => ({}))).error ?? "something went wrong";
}


/**========== thumbnails ==========*/

// One <img> per room, kept across refreshes. A fresh <img> each time would flash blank
// while it loads; this one keeps the old picture until the new one is ready.
const thumbs = new Map<string, HTMLImageElement>();

function thumbFor(room: Room): HTMLImageElement {
    // scale=1: one image pixel per board pixel, the smallest file. CSS scales it up.
    const url = `/board.png?scale=1&c=${encodeURIComponent(room.id)}&t=${Date.now()}`;
    let img = thumbs.get(room.id);
    if (!img) {
        img = new Image();
        img.alt = `Preview of ${room.name}`;
        img.src = url;
        thumbs.set(room.id, img);
    } else {
        const next = new Image();
        next.onload = () => { img!.src = next.src; };
        next.src = url;
    }
    return img;
}


/**========== tiles ==========*/

function tile(room: Room): HTMLElement {
    const article = document.createElement("article");
    article.className = room.mine ? "tile mine" : "tile";

    const thumb = document.createElement("a");
    thumb.className = "thumb";
    thumb.href = roomUrl(room.id);
    thumb.append(thumbFor(room));
    thumb.addEventListener("click", (e) => {
        e.preventDefault();
        enter(room);
    });

    const title = document.createElement("h3");
    const name = document.createElement("span");
    name.textContent = room.name;                   // textContent: names are user input
    const lock = document.createElement("span");
    lock.textContent = room.isPublic ? "" : "🔒";
    lock.title = "Private - needs a code";
    title.append(name, lock);

    const detail = document.createElement("small");
    const owner = room.mine ? "you" : room.ownerName ?? "nobody";
    detail.textContent = `by ${owner} · ${room.w}×${room.h} · ${room.clients} drawing now`;

    article.append(thumb, title, detail);
    if (room.mine) article.append(ownerControls(room));
    return article;
}

/** Privacy switch, the code to share, and delete - only on your own room. */
function ownerControls(room: Room): HTMLElement {
    const controls = document.createElement("div");
    controls.className = "controls";

    const toggle = document.createElement("button");
    toggle.className = "secondary outline";
    toggle.textContent = room.isPublic ? "Make private" : "Make public";
    toggle.addEventListener("click", async () => {
        showError(await send("PATCH", apiUrl(room.id), { isPublic: !room.isPublic }));
        refresh();
    });
    controls.append(toggle);

    if (!room.isPublic && room.code) {
        const code = document.createElement("span");
        code.innerHTML = `Code: <span class="code"></span>`;
        code.querySelector(".code")!.textContent = room.code.toUpperCase();

        const renew = document.createElement("button");
        renew.className = "secondary outline";
        renew.textContent = "New code";
        renew.title = "Everyone who joined with the old code has to enter the new one";
        renew.addEventListener("click", async () => {
            showError(await send("POST", apiUrl(room.id, "/code")));
            refresh();
        });
        controls.append(code, renew);
    }

    const del = document.createElement("button");
    del.className = "contrast outline";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
        // Deleting throws away everyone's drawing, so make it deliberate.
        const typed = prompt(`This deletes the room and its drawing for good.\nType its name to confirm: ${room.name}`);
        if (typed !== room.name) return;
        showError(await send("DELETE", apiUrl(room.id)));
        thumbs.delete(room.id);
        refresh();
    });
    controls.append(del);

    return controls;
}

/** The "+ Create your room" tile, shown until you have one. */
function newRoomTile(): HTMLElement {
    const button = document.createElement("button");
    button.className = "tile new-room secondary";
    button.innerHTML = `<strong style="font-size:1.4rem">+</strong><span>Create your room</span>`;
    button.addEventListener("click", () => {
        createErrorElem.textContent = "";
        createDialog.showModal();
    });
    return button;
}

/** Go into a room, asking for its code first if it is private and you are not in it yet. */
async function enter(room: Room) {
    if (!room.canEnter) {
        const code = prompt(`"${room.name}" is private. Enter its code:`);
        if (code === null) return;
        const error = await send("POST", apiUrl(room.id, "/join"), { code });
        if (error) return showError(error);
    }
    location.href = roomUrl(room.id);
}

function showError(message: string | null) {
    errorElem.textContent = message ?? "";
}

/** Fetch every room and redraw the tiles. */
async function refresh(): Promise<void> {
    const reply = await fetch("/api/canvases");
    if (!reply.ok) return;              // logged out in another tab; the next load shows the popup
    const rooms: Room[] = await reply.json();

    // Your own room first, so its code and controls are always in the same place.
    const mine = rooms.find(r => r.mine);
    const others = rooms.filter(r => !r.mine);
    roomsElem.replaceChildren(mine ? tile(mine) : newRoomTile(), ...others.map(tile));
}


/**========== creating a room ==========*/

/** Read the form into the shape POST /api/canvas wants. */
function readForm(): unknown {
    const data = new FormData(formElem);
    return {
        name: String(data.get("name") ?? ""),
        w: Number(data.get("w")),
        h: Number(data.get("h")),
        isPublic: data.get("privacy") === "public",
    };
}

formElem.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Same validation the server runs - this is why validateCreate lives in shared/
    const request = readForm();
    const error = validateCreate(request) ?? await send("POST", "/api/canvas", request);
    if (error) {
        createErrorElem.textContent = error;
        return;
    }
    createDialog.close();
    formElem.reset();
    fillDefaults();
    refresh();
});

document.getElementById("create-cancel")!.addEventListener("click", () => createDialog.close());

// Fill the size fields with the defaults and the bounds the validator enforces
function fillDefaults() {
    for (const [field, value] of [["w", DEFAULT_W], ["h", DEFAULT_H]] as const) {
        const input = formElem.elements.namedItem(field) as HTMLInputElement;
        input.value = String(value);
        input.min = String(MIN_DIM);
        input.max = String(MAX_DIM);
    }
}
fillDefaults();


/**========== start ==========*/

// The lobby is for accounts only. Cancelling the popup goes back to main.
if (await me) {
    renderAccount(document.getElementById("auth")!);
    refresh();
    setInterval(refresh, REFRESH_MS);
} else {
    openLogin(() => { location.href = "/"; });
}
