# Setup Guide

Install Ruflow UI Chat, connect it to your Claude subscription, and understand
the access model before you expose it to anything.

- [1. What this actually is](#1-what-this-actually-is)
- [2. Requirements](#2-requirements)
- [3. Install](#3-install)
- [4. Connect your Claude subscription](#4-connect-your-claude-subscription)
- [5. Make it run outside the author's machine](#5-make-it-run-outside-the-authors-machine)
- [6. First boot and the one-time token](#6-first-boot-and-the-one-time-token)
- [7. Security model](#7-security-model)
- [8. Running it for real](#8-running-it-for-real)
- [9. Troubleshooting](#9-troubleshooting)

---

## 1. What this actually is

Ruflow UI Chat is **not** an API client. It does not talk to `api.anthropic.com`
and it contains no code that handles an API key — you can verify that yourself:

```bash
grep -rn "ANTHROPIC\|API_KEY" server.js lib/    # returns nothing
```

What it does instead is spawn the **Claude Code CLI** as a child process, once
per turn, and stream its output to the browser over a WebSocket
(`server.js:1538`):

```js
spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--dangerously-skip-permissions',
  '--model', model,
], { env, cwd: WORK_DIR })
```

Two consequences follow from this, and they shape the whole rest of this guide:

1. **Authentication is entirely the CLI's.** Whatever account `claude` is logged
   into on the host is the account this UI uses. There is nothing to configure
   in the app itself.
2. **`--dangerously-skip-permissions` is passed on every single turn.** Every
   tool call the model makes — file writes, shell commands — executes with no
   confirmation prompt, as the user running the server. Treat access to this
   web UI as equivalent to handing someone a shell on the machine. Section 7
   is not optional reading.

---

## 2. Requirements

| | |
|---|---|
| **Node.js** | 20 or newer (developed on 22.22.0) |
| **Claude Code CLI** | on `PATH` as `claude` (developed against 2.1.246) |
| **A Claude account** | a Pro or Max subscription, or Console API billing |
| **OS** | Linux or macOS. The hardcoded paths in section 5 assume a Unix layout. |

Check the first two:

```bash
node --version      # v20.x or newer
claude --version    # e.g. 2.1.246 (Claude Code)
```

If `claude` is missing, install it first — see
[the Claude Code docs](https://docs.claude.com/en/docs/claude-code/overview).

---

## 3. Install

```bash
git clone https://github.com/henryalouf/ruflow-ui-chat.git
cd ruflow-ui-chat
npm install
```

Five runtime dependencies (`express`, `ws`, `multer`, `uuid`, `jsdom`). No build
step, no bundler, no framework — the frontend is vanilla JS served straight out
of `public/`, and `marked`, `highlight.js` and `DOMPurify` are vendored into
`public/vendor/` at pinned versions rather than pulled from a CDN.

**Do not run `npm start` yet.** Read section 5 first — on a stock clone the
server will start but point at a directory that does not exist on your machine.

---

## 4. Connect your Claude subscription

The app inherits the CLI's credentials, so "connecting your subscription" means
logging the CLI in, then making sure the server hands the child process the
right `HOME`.

### Step 1 — log the CLI into your subscription

In a terminal **as the same user that will run the server**:

```bash
claude
```

On first run it prompts you to authenticate. Choose your **Claude subscription**
(Pro or Max) and complete the browser flow. If you would rather bill through the
Console instead of a subscription, pick the API option there — either works, the
app does not care which, because it never sees the credential.

Verify you are logged in:

```bash
claude -p "say hello"
```

If that prints a reply, the UI will work. If it errors on authentication, fix it
here first — no amount of configuring this app will help, because this app is
not where the auth lives.

### Step 2 — know where those credentials landed

The CLI stores its session under the home directory of the user that logged in:

```bash
ls -la ~/.claude/
```

This matters because of step 3.

### Step 3 — make the server pass the right HOME

`server.js:1466` **overwrites `HOME` for the spawned CLI with a hardcoded
value**:

```js
env.HOME = '/home/claude-user';
env.USER = 'claude-user';
```

That is the author's account. If you leave it, the child `claude` process will
look for credentials in a directory that does not exist on your machine and
every turn will fail to authenticate — even though `claude -p` works fine from
your own shell.

Change both lines to your own user, or better, let them inherit:

```js
// server.js ~1466 — inherit the parent's identity instead of hardcoding
if (!env.HOME) env.HOME = require('os').homedir();
if (!env.USER) env.USER = require('os').userInfo().username;
```

While you are in that block, `server.js:1464` also prepends a hardcoded Node
path (`/home/claude-user/.nvm/versions/node/v22.22.0/bin`). Harmless if it does
not exist, but replace it with your own if `claude` cannot be found on `PATH`
inside the child.

> **A note on subscription limits.** Every turn is a real CLI invocation billed
> to whatever account you logged in with, and this app spawns subagents and
> tool-heavy turns freely. Usage counts against your Pro/Max limits exactly as
> if you had typed the same thing into the CLI yourself. The model picker in the
> UI (`opus`, `sonnet`, `haiku`, `fable`) maps to `--model`, so choosing a
> cheaper model there genuinely costs less.

---

## 5. Make it run outside the author's machine

Beyond `HOME`, three more paths are hardcoded to the original box. This is the
single biggest obstacle to running a fresh clone, so do all of it before first
boot.

| File | Line | Value | Change to |
|---|---|---|---|
| `server.js` | 16 | `WORK_DIR = '/home/claude-user/workspace/repos/ruflow/'` | the project directory you want Claude to work in |
| `server.js` | ~1464 | hardcoded `PATH` prefix | your Node/`claude` location, or drop it |
| `server.js` | ~1466 | `HOME` / `USER` | see section 4 step 3 |
| `public/app.js` | 54 | `RUFLOW_HOME = '/home/claude-user'` | your home directory (display only — it shortens paths to `~`) |

`WORK_DIR` is the most important one: it becomes the `cwd` of every spawned CLI
process, so it is the directory Claude reads, writes and runs commands in. Point
it at the repo you actually want to work on.

```bash
# minimal edit to get running
sed -i "s|/home/claude-user/workspace/repos/ruflow/|$HOME/your-project/|" server.js
sed -i "s|'/home/claude-user'|'$HOME'|g" server.js public/app.js
```

The server also expects a few files relative to `WORK_DIR` for its context
injection — `graphify-out/GRAPH_REPORT.md`, `data/memory/agentdb.sqlite`. All of
those reads are wrapped in try/catch, so their absence is silently fine; you
simply get no extra context injected.

---

## 6. First boot and the one-time token

```bash
npm start
```

You will see:

```
Ruflow UI server running on http://localhost:3001
  Unlock:       http://localhost:3001/?k=<TOKEN>
```

**Open that unlock URL once.** That is the whole login flow. What happens:

1. The server checks `?k=` against the token in constant time
   (`crypto.timingSafeEqual`, so a wrong guess cannot be narrowed by timing).
2. On a match it sets the token as an `HttpOnly; SameSite=Strict` cookie with a
   one-year lifetime.
3. It then **302-redirects to strip `?k=` out of the URL**, so the token stops
   appearing in browser history, referrer headers and any proxy log.

From then on that browser is authorised and you just visit
`http://localhost:3001`. Repeat the unlock URL once per device or browser
profile.

### Where the token comes from

If `RUFLOW_TOKEN` is not already set, the server generates 24 random bytes on
first boot, appends `RUFLOW_TOKEN=…` to `.env`, and `chmod`s that file to `0600`
(`server.js:448`). `.env` is gitignored. You never have to create it yourself.

To choose your own instead:

```bash
cp .env.example .env
echo "RUFLOW_TOKEN=$(openssl rand -base64 32 | tr -d /=+)" >> .env
```

### Recovering a lost token

```bash
grep RUFLOW_TOKEN .env        # it is right there
pm2 logs ruflow-ui            # or the unlock line from startup
```

Rotating it is just editing `.env` and restarting — every existing cookie stops
matching immediately.

### Hitting it without a browser

The token is accepted from the cookie **or** `?k=`, so scripts work directly:

```bash
curl "http://localhost:3001/api/sessions?k=$RUFLOW_TOKEN"
```

`/healthz` is deliberately ungated so uptime monitoring does not need the token.
It returns `ok` and nothing else — no session data.

---

## 7. Security model

Read this before binding to anything other than localhost.

### What the token protects

A single shared token, one operator. That is proportionate for a personal tool
and nothing heavier would actually get used — but be clear about what sits
behind it. The gate is the only thing between a visitor and a
`--dangerously-skip-permissions` agent with full filesystem access as your user.
On a developer machine that typically means SSH keys, cloud credentials, `.env`
files for other projects, and browser-authenticated CLIs.

**Anyone with the token has a shell on your machine.** Treat it as a root
password, not as a share link.

### The four layers, and why each exists

| Layer | Where | Why |
|---|---|---|
| **Token on every request** |  `server.js:512` | The gate itself. Constant-time compare. |
| **`HttpOnly` cookie** | `server.js:518` | JavaScript on any page cannot read the token, so an XSS anywhere in the app cannot exfiltrate it. |
| **`SameSite=Strict`** | `server.js:518` | The cookie is not attached to cross-site requests, so another site cannot drive your session by making you load a URL. |
| **Origin check on the WebSocket** | `server.js:671` | **The important one.** WebSockets ignore same-origin policy — a cookie alone would let any page you open in any tab open a socket and issue commands. `verifyClient` rejects a mismatched `Origin` with 403 *before* checking the token. |

CORS is same-origin only, not `*`. `X-Frame-Options: SAMEORIGIN`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` are set on
every response.

### `RUFLOW_OPEN=1` — do not

Setting it disables the gate completely: no token, no Origin check, no cookie.
It exists for local development bound to `127.0.0.1`. On any interface that is
not loopback it is an unauthenticated remote shell, publicly reachable, with no
audit trail. There is no scenario where this is acceptable on a public address.

### If you expose it beyond localhost

The token is sent as a cookie and, once, in a query string. Over plain HTTP both
are readable by anything on the path.

- **Put it behind TLS.** A reverse proxy with a real certificate, and add
  `Secure` to the cookie in `server.js:518`.
- **Better: do not expose it at all.** Use an SSH tunnel and keep the server
  bound to loopback:
  ```bash
  ssh -L 3001:localhost:3001 you@your-box
  ```
  Then browse `http://localhost:3001` on your laptop. Nothing is on the public
  internet, and the token never crosses an untrusted network.
- **Consider what `WORK_DIR` exposes.** The agent's `cwd` is where it reads and
  writes. Pointing it at a directory containing credentials for other systems
  means a prompt-injected agent can read them.

`SPEC-v2.md` documents the pre-auth state of this app, when the WebSocket had no
auth at all — kept as a record of why these layers exist.

---

## 8. Running it for real

Under [pm2](https://pm2.keymetrics.io/), so a crash restarts and it survives
reboot:

```bash
npm install -g pm2
pm2 start server.js --name ruflow-ui
pm2 save
pm2 startup          # follow the printed command
```

```bash
pm2 logs ruflow-ui       # includes the unlock line
pm2 reload ruflow-ui     # after code changes
pm2 restart ruflow-ui
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `RUFLOW_TOKEN` | generated | Access token required by every request |
| `RUFLOW_OPEN` | unset | `1` disables auth — localhost only, see section 7 |
| `RUFLOW_SUBAGENT_TEXT` | on | `off` drops `--forward-subagent-text`, hiding subagent narration |
| `SUBAGENT_DELTAS` | on | `off` ignores live subagent stream deltas |

### Tests

```bash
npm test                # unit suites
npm run test:server     # boots an instance on :3099 and runs everything
```

Use `test:server` — several suites need a live server. `auth.test.js` starts its
own gated instance to exercise the token path.

### State on disk

| Path | Contents | Tracked? |
|---|---|---|
| `sessions/` | one JSON file per conversation | no |
| `uploads/` | files attached to turns | no |
| `memory/store.json` | cross-session recall entries | no |
| `.env` | your access token, mode `0600` | no |

All gitignored. `sessions/` in particular holds full transcripts — back it up if
you care about it, and never commit it.

---

## 9. Troubleshooting

**Every turn fails with an authentication error, but `claude -p "hi"` works.**
The hardcoded `HOME` from section 4 step 3. The child process is looking for
credentials in `/home/claude-user/.claude/`.

**`spawn claude ENOENT`.** The CLI is not on the `PATH` the child receives — and
`server.js:1464` *replaces* `PATH` rather than extending it. Add your Node/npm
bin directory there, or symlink `claude` into `/usr/local/bin`.

**The page says "Ruflow is locked".** Your cookie is missing, expired, or the
token was rotated. Visit `/?k=<TOKEN>` again — `grep RUFLOW_TOKEN .env`.

**Unlock URL works, then the UI never connects.** The WebSocket Origin check is
rejecting you — look for `[auth] WS rejected, cross-origin` in the logs. It
happens when you reach the server by a different hostname than it sees in
`Host`, which usually means a reverse proxy is not forwarding `Host` and
`Origin` correctly.

**Turns start but nothing renders.** Check the browser console and the server
log together. The stream-event contract lives in `lib/stream-events.js` with
`tests/stream-events.test.js` covering it; a CLI version that changed its
`stream-json` shape will show up as parse failures there.

**Sessions vanish on restart.** `sessions/` is not writable, or `WORK_DIR` moved
out from under a relative path. The server writes sessions relative to its own
directory, not `WORK_DIR`.
