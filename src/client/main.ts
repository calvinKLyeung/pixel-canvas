import { W, H } from "../shared/constants.js";



const sock = new WebSocket(`ws://${location.host}/ws`);


let isOpened = false;

sock.addEventListener("open", (msg) => {
    isOpened = true;
    console.log("Websocket connected");
});

sock.addEventListener("message", (e) => {
    console.log("Received from websocket", e.data);

    try {
        const msg = JSON.parse(e.data);
        console.log(msg)
    } catch (err) {
        console.error("bad message", err, e.data)
    }
});

sock.addEventListener("close", (e) => {
    isOpened = false;
    console.log(`WebSocket closed (code ${e.code})`);
});

sock.addEventListener("error", (e) => {
    console.error("Websocket error", e);
})








const button = document.querySelector("#send-btn")!;

button.addEventListener("click", () => {
    if (!isOpened) {
        console.warn("socket not open yet — ignoring send");
        return;
    }
    sock.send(JSON.stringify({ type: "ping", payload: "hello" }));
});




// document.body.textContent = `client ok, board is ${W}x${H}`;