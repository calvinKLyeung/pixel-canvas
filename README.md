# pixel-canvas

## Running locally

```bash
npm install
npm run watch:client   # terminal 1 — bundles src/client -> public/main.js, rebuilds on save
npm run dev            # terminal 2 — server on http://localhost:8000
```

Open http://localhost:8000.

Two terminals because `npm run dev` only watches the server. Use `npm run
build:client` instead for a one-shot bundle without the watcher.
