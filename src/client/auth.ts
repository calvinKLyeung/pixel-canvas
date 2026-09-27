export interface Me {
    id: number;
    name: string;
    isAdmin: boolean;
}

/** Asked once per page. The session cookie is httpOnly, so asking is the only way to know. */
export const me: Promise<Me | null> = fetch("/api/me")
    .then(reply => (reply.ok ? reply.json() as Promise<Me> : null))
    .catch(() => null);

/**
 * Log in / register / log out, drawn into `root`.
 *
 * Every change reloads the page. The WebSocket picked its cooldown identity when it
 * connected, so logging in without reconnecting would keep painting as your IP.
 */
export async function mountAuth(root: HTMLElement) {
    const user = await me;

    if (user) {
        root.innerHTML = `<small>Signed in as <b></b> · <a href="#">Log out</a></small>`;
        root.querySelector("b")!.textContent = user.name;   // textContent: names are user input
        root.querySelector("a")!.addEventListener("click", async (e) => {
            e.preventDefault();
            await fetch("/api/logout", { method: "POST" });
            location.reload();
        });
        return;
    }

    root.innerHTML = `
        <details>
          <summary>Log in or register</summary>
          <form>
            <input name="name" placeholder="Name" autocomplete="username" required>
            <input name="password" type="password" placeholder="Password"
                   autocomplete="current-password" required>
            <button name="login">Log in</button>
            <button name="register" class="secondary">Register</button>
            <small class="error"></small>
          </form>
        </details>`;

    const form = root.querySelector("form")!;
    const error = root.querySelector(".error")!;

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
            location.reload();
            return;
        }
        error.textContent = (await reply.json().catch(() => ({}))).error ?? "something went wrong";
    });
}
