export interface Me {
    id: number;
    name: string;
    isAdmin: boolean;
    /** Epoch ms when the account and its room are deleted unless they log in. null for admins. */
    deleteAt: number | null;
}

/** Asked once per page. The session cookie is httpOnly, so asking is the only way to know. */
export const me: Promise<Me | null> = fetch("/api/me")
    .then(reply => (reply.ok ? reply.json() as Promise<Me> : null))
    .catch(() => null);

/** "Signed in as NAME · Log out", or nothing when logged out. */
export async function renderAccount(root: HTMLElement) {
    const user = await me;
    if (!user) return;
    root.innerHTML = `<small>Signed in as <b></b> · <a href="#">Log out</a></small>`;
    root.querySelector("b")!.textContent = user.name;   // textContent: names are user input
    root.querySelector("a")!.addEventListener("click", async (e) => {
        e.preventDefault();
        await fetch("/api/logout", { method: "POST" });
        location.href = "/";        // everything but main needs an account
    });
}

/**
 * The log in / register popup. Logging in always lands in the lobby: the page that opened
 * this picked its room and its connection while logged out, and reloading into the lobby
 * is simpler than patching that up.
 *
 * `onCancel` runs if they close it without logging in. `goTo` is where a successful login
 * lands - the lobby unless the caller wants somewhere else, e.g. renewing from a room page.
 */
export function openLogin(onCancel: () => void = () => {}, goTo = "/lobby.html") {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `
        <article>
          <header><h3 style="margin:0">Log in to paint with friends</h3></header>
          <form>
            <input name="name" placeholder="Name" autocomplete="username" required>
            <input name="password" type="password" placeholder="Password (8+ characters)"
                   autocomplete="current-password" required>
            <small class="error" style="color:var(--pico-del-color)"></small>
            <div role="group">
              <button name="login">Log in</button>
              <button name="register" class="secondary">Register</button>
            </div>
          </form>
          <footer><a href="#" class="cancel">Stay on Paint together</a></footer>
        </article>`;
    document.body.append(dialog);

    const form = dialog.querySelector("form")!;
    const error = dialog.querySelector(".error")!;
    let loggedIn = false;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        // Two submit buttons, one form: the button that was pressed picks the route.
        const route = (e.submitter as HTMLButtonElement | null)?.name === "register" ? "register" : "login";
        const data = new FormData(form);

        const reply = await fetch(`/api/${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: data.get("name"), password: data.get("password") }),
        });
        if (reply.ok) {
            loggedIn = true;
            location.href = goTo;
            return;
        }
        error.textContent = (await reply.json().catch(() => ({}))).error ?? "something went wrong";
    });

    dialog.querySelector(".cancel")!.addEventListener("click", (e) => {
        e.preventDefault();
        dialog.close();
    });
    // Esc closes a dialog too, so cancelling is handled on close rather than on the link.
    dialog.addEventListener("close", () => {
        dialog.remove();
        if (!loggedIn) onCancel();
    });

    dialog.showModal();
}
