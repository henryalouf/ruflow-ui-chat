# Ruflow UI Chat

A web chat interface for the Claude Code CLI. It spawns `claude` as a child
process, streams its output over a WebSocket, and renders each turn as a live
process log — tool calls, subagent activity, and the final answer — rather than
a single opaque bubble.

## What it does

- **Streaming turn rendering.** Stream events from the CLI are parsed in
  `lib/stream-events.js` and turned into a structured run model
  (`public/run-model.js`), which the renderer (`public/run-render.js`) draws
  incrementally as the turn unfolds.
- **Session persistence.** Every conversation is written to `sessions/` as JSON
  and can be resumed.
- **Token-gated access.** The server requires a token on every request. See
  Auth below.
- **File uploads** into `uploads/` for attaching context to a turn.
- **Local memory store** in `memory/store.json` for cross-session recall.

## Requirements

- Node.js 20+
- The [Claude Code CLI](https://claude.ai/code) installed and on `PATH`

## Install and run

```bash
npm install
cp .env.example .env      # optional — a token is generated if you skip this
npm start
```

The server listens on `http://localhost:3001` and prints an unlock URL
containing the access token on startup.

## Auth

The server reads `RUFLOW_TOKEN` from the environment or `.env`. If neither is
set, it generates a token on first boot, writes it to `.env` with mode `0600`,
and prints the unlock URL:

```
http://<host>:3001/?k=<token>
```

Setting `RUFLOW_OPEN=1` disables auth completely. Only do that when the server
is bound to localhost — an open instance is an unauthenticated shell on the
machine running it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `RUFLOW_TOKEN` | generated | Access token required by every request |
| `RUFLOW_OPEN` | unset | `1` disables auth (localhost only) |
| `RUFLOW_SUBAGENT_TEXT` | on | `off` drops `--forward-subagent-text` from the CLI spawn |
| `SUBAGENT_DELTAS` | on | `off` ignores live subagent stream deltas |

## Tests

```bash
npm test                # unit tests
npm run test:server     # boots a server on :3099 and runs the full suite
```

## Layout

```
server.js              Express + WebSocket server, CLI spawn, session I/O
lib/stream-events.js   Stream-event parser and accumulator
public/app.js          Client bootstrap and transport
public/run-model.js    Stream events -> structured run model
public/run-render.js   Run model -> DOM
public/style.css       Styles
tests/                 Node test-runner suites
SPEC-v2.md             Design spec for the v2 turn renderer
```

`sessions/`, `uploads/`, `memory/`, `.env`, and the vector database are runtime
state and are not tracked.

## License

MIT
