# Ruflow UI Chat

A web chat interface for the Claude Code CLI. It spawns `claude` as a child
process, streams its output over a WebSocket, and renders each turn as a live
process log — tool calls, subagent activity, and the final answer — rather than
a single opaque bubble.

**→ [Full setup guide](GUIDE.md)** — install, connecting your Claude
subscription, the token, and the security model.

## What it does

- **Streaming turn rendering.** Stream events from the CLI are parsed in
  `lib/stream-events.js` into a structured run model (`public/run-model.js`),
  which the renderer (`public/run-render.js`) draws incrementally as the turn
  unfolds.
- **Session persistence.** Every conversation is written to `sessions/` as JSON
  and can be resumed.
- **Token-gated access**, with an Origin-checked WebSocket.
- **File uploads** into `uploads/` for attaching context to a turn.
- **Local memory store** in `memory/store.json` for cross-session recall.

No framework, no build step. Vanilla JS frontend, five runtime dependencies,
`marked`/`highlight.js`/`DOMPurify` vendored at pinned versions.

## Requirements

- Node.js 20+ (developed on 22.22.0)
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview)
  on `PATH` as `claude` (developed against 2.1.246)
- A Claude account — a Pro/Max subscription or Console API billing

## Quick start

```bash
git clone https://github.com/henryalouf/ruflow-ui-chat.git
cd ruflow-ui-chat
npm install
```

Then, **before first boot**, fix the paths hardcoded to the author's machine —
a stock clone will not authenticate anywhere else:

```bash
sed -i "s|/home/claude-user/workspace/repos/ruflow/|$HOME/your-project/|" server.js
sed -i "s|'/home/claude-user'|'$HOME'|g" server.js public/app.js
```

See [GUIDE.md §5](GUIDE.md#5-make-it-run-outside-the-authors-machine) for what
each of those is and why. Then:

```bash
npm start
```

The server prints an unlock URL containing an access token. Open it once per
browser; the token becomes an `HttpOnly` cookie and is stripped from the URL.

## Connecting your Claude subscription

This is **not** an API client — it holds no API key and never calls
`api.anthropic.com`. It shells out to the Claude Code CLI, so it uses whatever
account the CLI is logged into.

```bash
claude                     # authenticate — pick your Pro/Max subscription
claude -p "say hello"      # verify before starting the server
```

One catch: `server.js:1466` overwrites `HOME` for the spawned process with a
hardcoded path, so the child looks for credentials in the wrong place on your
machine. [GUIDE.md §4](GUIDE.md#4-connect-your-claude-subscription) covers the
fix. Usage bills to that account exactly as if you had typed it into the CLI.

## Security

Every turn spawns the CLI with `--dangerously-skip-permissions`. Tool calls run
with no confirmation as the user running the server, in whatever directory
`WORK_DIR` points at.

**Anyone with the access token effectively has a shell on the machine.** The
gate is a single shared token (constant-time compared), carried in an
`HttpOnly; SameSite=Strict` cookie, with an Origin check on the WebSocket
because WebSockets ignore same-origin policy.

`RUFLOW_OPEN=1` disables all of it and is only safe bound to loopback. To reach
it remotely, prefer an SSH tunnel over exposing the port:

```bash
ssh -L 3001:localhost:3001 you@your-box
```

[GUIDE.md §7](GUIDE.md#7-security-model) has the full model.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `RUFLOW_TOKEN` | generated | Access token required by every request |
| `RUFLOW_OPEN` | unset | `1` disables auth (localhost only) |
| `RUFLOW_SUBAGENT_TEXT` | on | `off` drops `--forward-subagent-text` |
| `SUBAGENT_DELTAS` | on | `off` ignores live subagent stream deltas |

## Tests

```bash
npm test                # unit suites
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
GUIDE.md               Setup, subscription, and security guide
SPEC-v2.md             Design spec for the v2 turn renderer
```

`sessions/`, `uploads/`, `memory/`, `.env`, and the vector database are runtime
state and are not tracked.

## License

MIT
