const app = document.getElementById("app")!;

app.innerHTML = `
    <p id="status"> connecting</p>
    <input id="msg" type="text" placeholder="type something">
    <button id="send" disabled>Send</button>
    <pre id="log"></pre>
`;

const statusMain = document.getElementById("status")!;
const input = document.getElementById("msg") as HTMLInputElement;
const button = document.getElementById("send") as HTMLButtonElement;
const log = document.getElementById("log")!;

// https : wss   http : ws
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const sock = new WebSocket(`${protocol}//${location.host}/ws`);

sock.addEventListener("open", (msg) => {
    statusMain.textContent = "connected";
    button.disabled = false; // connected = safe to click
});

sock.addEventListener("message", (e) => {
    log.textContent += `${e.data}\n`;
});

sock.addEventListener("close", (e) => {
    statusMain.textContent = "disconnected";
    button.disabled = true;
});

sock.addEventListener("error", (e) => {
    console.error("Websocket error", e);
    statusMain.textContent = "error = check the console";
})

button.addEventListener("click", () => {
    if (input.value) {
        sock.send(input.value);
        input.value = ""
    }
})

// document.body.textContent = `client ok, board is ${W}x${H}`;