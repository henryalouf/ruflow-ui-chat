# ruflow-ui v2 — implementation spec

Produced by an 8-agent research and design workflow on 2026-08-10: OpenClaw feature
research (verified from source), a frontend map, a backend map, empirical model
verification, then three independent design angles judged into this single spec.

This file is the source of truth for the v2 build. Where it disagrees with a summary
in a chat message, this file wins.

## Chosen spine

**Spine = Proposal 1 (the Run/Lane/Block process log).** The turn stops being a message and becomes a `Run` that owns ordered `Lane`s of `Block`s, routed by `parent_tool_use_id`. Everything the owner asked for is a consequence of that one model rather than a separate feature: multi-block rendering is the default because there is no bubble to break up; the subagent preview is the same renderer mounted one level in; the stale-conclusion fix is a structural property of an ordered log; and the O(n²) markdown re-parse becomes structurally impossible because only the open tail block is ever mutable.

Grafted onto it:

- **From Proposal 3: `SEAL_MIN_CHARS` absorb-as-caption.** P1 (and OpenClaw) flush on *every* tool start, which turns "Let me check." → Read → "Now the config." into three fragment bubbles. P3's rule — seal only if the open text is ≥40 trimmed chars, otherwise absorb it as the tool row's caption — fixes OpenClaw's actual failure mode. This is the single most important graft.
- **From Proposal 3: the 96px monospace gutter with per-row durations, `tabular-nums`, delegated events, ring-buffer subagent tails, server-side text coalescing with first-delta-immediate, and seal-on-4s-silence** (which is what makes highlight-on-seal not leave a long final answer unhighlighted).
- **From Proposal 2: the verdict/trail mechanism.** P1 lifts the final text out of the log into a sibling band; P2 leaves the verdict node exactly where it is and wraps only its *predecessors* in `<details>`. P2 is right and I take it wholesale, plus P2's "substantive" sign-off rule and its outcome-dependent default-open state.
- **From Proposal 2: the asymmetry argument** that any lexical supersede rule may only ever mark blocks that structural demotion has *already* collapsed, so a false positive is invisible until you open the trail.

Proposal 3's three-column instrument panel is kept but demoted to the last shippable unit (U11), because it is the only part of the design that is not load-bearing for the two problems the owner actually named.

## Rationale and conflicts called

**Why P1's spine over P2's or P3's.** All three converge on the same seal rule, so the spine choice is really "what is the primary object". P2 makes it the *verdict* — elegant for reading, but it has no answer for concurrent subagents because a verdict is singular and lanes are plural. P3 makes it the *run with instruments* — correct, but it front-loads a three-column layout and an instrument column that are pure additions and would delay the fix. P1 makes it the *lane*, which is the only one of the three that generalises to `parent_tool_use_id` without a second concept. Lanes give you the subagent preview for free; verdicts and instruments are then features you hang off lanes, not the other way round.

**Conflicts, called:**

1. *Seal on every tool start (P1) vs absorb short preambles (P3).* → **P3.** Fragment spam is a real, documented OpenClaw failure and 40 chars of "Let me check the config" is semantically a caption for the tool it introduces, not a message.
2. *Verdict lifted into its own band (P1) vs verdict node untouched and predecessors wrapped (P2).* → **P2.** Never move the DOM node the user is currently reading; wrapping predecessors is one reflow above the fold, lifting is a reflow through it.
3. *Strikethrough superseded sentences (P1, P2) vs chip only (P3).* → **P3.** A wrong strikethrough is destructive and unrecoverable; a wrong chip is additive and ignorable. Ship the chip.
4. *Semantic/LLM contradiction detection (all three reject).* → **Rejected, unanimously and correctly.** A utility-model pass costs a call at exactly the moment the user is waiting for the finish.
5. *Mono body text.* → **Structure is mono, prose is not.** Three paragraphs of Menlo is measurably slower to read; the terminal conviction comes from grid alignment, not the body face.
6. *Two-column (P1/P2) vs three-column (P3).* → **Two columns now, instrument column as U11.** It is genuinely good and genuinely optional.
7. *`remend` / `marked-highlight` dependency.* → **Neither.** Vendor pinned marked + highlight.js + DOMPurify locally and wire hljs through a renderer override; fence repair is ~40 lines and only needed on the seal-on-silence path.

**Corrections to the recon that change the plan.** Three "reliability issues" in the backend map are already fixed in the live file and must not be re-fixed: `accumulatedText` now appends with a `currentMessageText` `startsWith` dedupe (server.js:1358-1396), `syncSessionToVectorDb` opens the DB fresh per sync and writes via temp+rename through a serialised `_syncChain` (server.js:164-231), and `source_path` is now unique per exchange (server.js:202). But `agentdb.sqlite` still contains exactly **1** row matching `ruflow-ui%` (384 chars, the legacy collided row) against 652 memories total — so the running server process predates the fix. U9 must include a restart and a one-off backfill, not just code. Likewise `public/index.html:99-112` already ships the verified aliases with correct labels, so U10 is server-side hardening only, not a picker rewrite.

**One thing that outranks all of it.** The WebSocket has no auth and no `Origin` check, CORS is `*`, and it spawns `claude --dangerously-skip-permissions` as `claude-user` with full filesystem access on a box reachable at a publicly reachable address. Any page the owner opens in any tab can drive it. All three proposals flagged this independently. It is U0 and it lands first, because a better UI increases time-in-app and therefore exposure.

## Event contract

## Envelope

Every server→client stream event gains three fields, assigned in **one** place — a `emitStream(obj)` helper inside the per-connection closure that wraps `send()`:

```js
function emitStream(o) { o.runId = runId; o.seq = ++seqCounter; if (!o.lane) o.lane = 'main'; send(o); }
```

`runId` = `uuidv4()` minted at spawn. `seq` = monotonic int per run, starting at 1. `lane` = `'main'` | a Task `tool_use` id | `'_unattributed'`.

Client drops any event where `seq <= run.lastSeq` (12 lines, in the dispatcher). This is the reconnect/replay fence: without it a history replay can regress a finished tool card back to `running`.

## Lane derivation (server, one line, top of `processStreamEvent`)

```js
const lane = event.parent_tool_use_id
  || (openLanes.size > 0 ? '_unattributed' : 'main');
```

`_unattributed` renders as a dim `note` row in main reading "unattributed agent output" — it is a visible tell, not a silent misfile. Never route unattributed text into `accumulatedText`.

**Critical companion change:** `currentMessageText` (server.js:1382-1396) is a single variable feeding a `startsWith` dedupe. With lanes it must become `const messageTextByLane = new Map()`. Interleaved lanes otherwise corrupt the dedupe and duplicate or swallow text. This is a bug `--forward-subagent-text` *introduces*; it must land in the same commit as the flag.

## Events — server → client

| type | fields (beyond runId/seq/lane) | emitted from `stream-json` |
|---|---|---|
| `stream_start` | `sessionId, model, requestedModel` | immediately after `spawn` (server.js:1234) |
| `stream_lifecycle` | `phase: 'spawning' \| 'session_ready'` | `spawning` at spawn; `session_ready` on `system/init` |
| `stream_text` | `text` | `stream_event`→`content_block_delta`→`text_delta`; **and** the `assistant`→`text` block remainder path (existing dedupe, now per-lane) |
| `stream_thinking` | `text` | `stream_event`→`content_block_delta`→`thinking_delta.thinking`; **and** `assistant` block `type:'thinking'`. Currently dropped entirely. |
| `stream_tool_progress` | `toolId, toolName, partialInput` | `stream_event`→`content_block_start` where `content_block.type==='tool_use'` (gives the name instantly), then `content_block_delta`→`input_json_delta.partial_json` accumulated per `index`. Currently dropped. |
| `stream_tool_start` | `toolId, toolName, toolInput, kind` | `assistant` block `type:'tool_use'` (existing site server.js:1398-1404) + new `kind` from `classifyTool()` |
| `stream_tool_result` | `toolId, content, isError, truncated, fullChars` | `user` block `type:'tool_result'` (server.js:1432). `content` capped at `TOOL_OUTPUT_WIRE_CHARS = 120_000`; `truncated:true` + `fullChars` when cut. |
| `stream_lane_open` | `laneId, parentLane, agentType, label` | emitted **in addition to** `stream_tool_start` when `block.name === 'Task'`. `laneId = block.id`, `agentType = block.input.subagent_type`, `label = block.input.description`. All three already arrive today, unlabelled. |
| `stream_lane_close` | `laneId, status: 'ok'\|'error', resultChars` | on the `tool_result` whose `tool_use_id` matches an open lane |
| `stream_fallback` | `from, to, reason` | on `result`, when `Object.keys(event.modelUsage).length > 1` or the resolved model ≠ requested |
| `stream_end` | existing fields **+** `models: string[]` (all `modelUsage` keys, not just `[0]`), `subtype`, `isError` | `result` (server.js:1494-1514). **Must stop reporting `error_max_turns` / `error_during_execution` as success** — read `event.subtype` and `event.is_error`. |
| `stream_error` | `error` | unchanged sites |

## Events — client → server (new)

| type | fields | response |
|---|---|---|
| `fetch_tool_output` | `toolId` | `{type:'tool_output_full', toolId, content}` — served from an in-memory `Map<toolId,string>` scoped to the run, plus a session-file fallback |

## Text coalescing (server, `emitStream` for `stream_text` only)

Buffer per lane; flush on **50 ms** *or* **400 chars**, whichever first. **The first delta of a run flushes immediately** — time-to-first-token must not regress. Add `if (ws.bufferedAmount > 1e6) window = 200` backpressure; `send()` currently calls `ws.send` unconditionally.

## Ordering guarantee

`stream_tool_start` for a Task is always emitted **before** its `stream_lane_open`, and `stream_lane_close` before the Task's `stream_tool_result`. The client may therefore assume the agent card exists when a lane opens.

## Block model

## Model (client, `public/run-model.js` — pure, no DOM, unit-testable)

```js
Run  = { id, sessionId, startedAt, model, status:'live'|'ok'|'fail'|'cancel',
         lanes: Map<laneId, Lane>, byId: Map<blockId, Block>, lastSeq: 0,
         counts: { read:0, edit:Set, cmd:0, err:0 } }

Lane = { id, parentLane, agentType, label, depth, status,
         blocks: [], openSay: null, byToolId: Map<toolId, Block>,
         tail: [], startedAt, toolCount: 0, currentTool: null }

Block = { id, kind, lane, seq, el, bodyEl, text, sealed,
          state:'live'|'ok'|'err', role: null|'verdict'|'note',
          toolId, toolName, kind2, target, caption, output, truncated,
          startedAt, endedAt, negClaims: [] }
```

## Five kinds. Not seven.

| kind | created by | renders |
|---|---|---|
| `say` | `stream_text` when `lane.openSay == null` | prose. Live: **one text node**, `appendData(delta)`, `white-space: pre-wrap`, no parse. Sealed: markdown + hljs, once, forever. |
| `think` | `stream_thinking` | dim italic mono, collapsed by default behind a "thinking" toggle in the composer bar. Never enters `accumulatedText`. |
| `act` | `stream_tool_start` | one 26px row: gutter duration · kind label · target · caption · status glyph. Body `hidden` **and empty** until first expand. |
| `agent` | `stream_lane_open` | an `act` row with violet rail, containing a fixed 3-line `<pre class="tail">` ring buffer **and** a nested `<ol class="lane">` rendered by the same renderer at `depth+1` |
| `note` | `stream_fallback`, `stream_error`, `stream_lifecycle`, truncation | one dim mono row, no body |

`verdict` is **not** a kind — it is `say` with `role='verdict'`. `group` is **not** a kind — it is a derived `<div class="grp">` wrapper inserted at seal.

## The seal rule (the whole fix)

```js
const SEAL_MIN_CHARS = 40;   // named constant, top of run-model.js — this WILL be tuned
const SEAL_IDLE_MS   = 4000;

function onToolStart(d) {
  const L = laneFor(d.lane);
  const s = L.openSay;
  if (s) {
    if (s.text.trim().length >= SEAL_MIN_CHARS) {
      seal(s);                    // -> its own block, demoted, next delta opens a new one
    } else {
      absorbAsCaption(s, d);      // short preamble becomes the tool row's caption
      L.blocks.pop(); s.el.remove();
    }
    L.openSay = null;
  }
  appendAct(L, d);
}
```

`seal()` also fires on `stream_end` (all lanes) and on a 4 s text-silence timer per open `say` — the latter is what lets a long final answer get progressively highlighted instead of staying plain until the run ends.

**A sealed block is immutable.** It is parsed and highlighted exactly once and never re-rendered for the life of the session. This is simultaneously the correctness rule and the performance rule.

## Nesting

Exactly one level of visual nesting. `agent` blocks contain a nested lane `<ol>` inset 20px with a dimmed rail. **Depth cap = 2**: a subagent that spawns a subagent renders flat in the grandparent lane with a `↳ agentType` prefix. Hard cap, no config — a config option here just relocates the bug.

## Group collapsing

At `stream_end`, any run of **≥6 consecutive `act` blocks in one lane with no `say` between them** and **zero errors** collapses into one 22px row: `▸ 6 reads · 2 edits · 1 command · 4.1s`. File counts dedupe by resolved target path (`Set<string>`), falling back to call count. Any error in the run → stays expanded. Pure function, no LLM.

## DOM skeleton

```html
<section class="run" data-run-id data-status="live">
  <header class="run-head">            <!-- position:sticky; top:0 -->
    <span class="glyph"/> <span class="model chip mono"/>
    <span class="elapsed mono" data-live/> <span class="burn mono"/>
    <p class="peek"><!-- first sentence of the verdict, live-updated at stream_end --></p>
  </header>
  <div class="prompt">…user text…</div>
  <details class="trail"><summary class="mono">7 steps before the answer</summary>
    <ol class="lane" data-lane="main">
      <li class="blk say sup"        data-blk><div class="gut mono">+0.8s</div><div class="body prose"/></li>
      <li class="blk act" data-kind="command" data-state="ok" data-tool-id>
        <div class="gut mono">1.4s</div>
        <button class="row"><span class="k mono">bash</span><code class="target mono"><span class="dir">~/repos/</span><b>build.sh</b></code><span class="cap">Let me check the config</span></button>
        <div class="detail" hidden></div>
      </li>
      <li class="blk agent" data-lane-id data-state="live">
        <div class="gut mono">2m14s</div>
        <button class="row"><span class="k mono">agent</span><b>researcher</b><span class="cap">Audit auth module</span><span class="ct mono">11 tools · Grep</span></button>
        <pre class="tail mono">…3 rolling lines…</pre>
        <ol class="lane nested" data-lane="tu_07">…same renderer, depth 1…</ol>
      </li>
      <div class="grp" data-count="9">▸ 6 reads · 2 edits · 1 command · 4.1s</div>
      <li class="blk note" data-note="fallback">requested opus → served claude-sonnet-5 (429)</li>
    </ol>
  </details>
  <article class="blk say" data-role="verdict">…final answer, full weight, NEVER moved…</article>
  <footer class="run-foot mono">done 4m12s · 18.4k out · $0.62 · claude-opus-5</footer>
</section>
<div id="tail-sentinel" aria-hidden="true"></div>
```

`.message-text` survives as an inner class inside `.blk .body` so existing copy / search / word-count / collapse code (app.js:711, 2423, 2823, 527) keeps working. The outer container is deliberately renamed so every stale `.message` selector fails loudly rather than half-working.

## Persistence parity — ships in the same release or the feature is a live-only illusion

Assistant messages gain an ordered `blocks[]` alongside the existing `content` / `toolBlocks` (kept for old sessions):

```json
{ "role":"assistant", "content":"…", "toolBlocks":[…],
  "blocks":[
    {"k":"say","lane":"main","seq":4,"text":"…"},
    {"k":"act","lane":"main","seq":7,"toolId":"tu_01","toolName":"Bash","kind":"command",
     "input":{…},"caption":"Let me check the config","output":"…","isError":false,"truncated":false,"ms":1400},
    {"k":"agent","lane":"main","seq":9,"laneId":"tu_07","agentType":"researcher","label":"Audit auth module","status":"ok","ms":134000}
  ] }
```

`renderSavedMessage` renders `blocks[]` through the **same** renderer when present, falls back to the legacy path when absent. One renderer, two entry points — never two divergent render paths again.

## Stale-conclusion mechanism

**Honest framing up front: two of the three tiers are deterministic and always correct. The third is a lexical heuristic and will sometimes be wrong. It is designed so that being wrong is invisible.**

OpenClaw has no supersede feature at all — 33,068 paths searched, zero hits. They sidestep it structurally. So does this.

### Tier 1 — Live structural demotion (deterministic, zero risk, ~6 lines)

A `say` block followed by more work is, by the model's own behaviour, not a conclusion — if it believed that sentence it would have stopped calling tools. So `seal()` sets `data-role="note"` at the exact instant the next tool starts:

```css
.blk.say[data-role="note"] .body {
  color: var(--fg-dim); opacity: .62;
  transition: opacity .4s, color .4s;
}
```

The user **watches** "I could not find X" lose its authority the moment the agent goes back to look. Colour and opacity only — **never font-size, never padding**; either reflows every row below and yanks the scroll position out from under someone mid-read. Over two runs this teaches a legible rule: grey is provisional, bright is current.

### Tier 2 — Verdict promotion + trail wrap (deterministic, one reflow)

At `stream_end`:

1. Walk `lanes.main.blocks` backwards for the last **substantive** `say`. Substantive = **NOT** (single line **AND** ≤120 trimmed chars **AND** no code fence, list, heading or table). Non-substantive trailing blocks are *sign-offs* ("Done.", "Pushed to main.") — they append to the verdict as a `.signoff` status line instead of becoming it.
2. Set `role='verdict'` on it. **Do not move it.**
3. Move every preceding block into `<details class="trail">` via one `DocumentFragment`, inserted *before* the verdict node. Summary is derived from the block array: `18 steps · read 6, edited 3, ran 4 · 1 failed · 41s`.
4. Mirror the verdict's **first sentence** into `.run-head .peek`, which is `position: sticky; top: 0`. Scrolling a 40-step run, the strip pinned to the top of your viewport now reads the *final* answer.

**Default open state is outcome-dependent** — this does more for daily usability than any amount of analysis:

- run succeeded → trail **collapsed**. You wanted the answer.
- run failed / cancelled / contains any errored `act` → trail **expanded**. You wanted the trail.

Belt and braces: the trail's `<summary>` second line always previews the opening sentence of the last *demoted* `say`. When promotion picks wrong, the real answer is still visible without expanding.

### Tier 3 — Negative-claim cross-reference chip (HEURISTIC — this is the one that can be wrong)

Applied **only** to blocks Tier 1 has already demoted. Never to the verdict.

At seal, scan the block's text (skipping code fences and blockquotes) for:

```js
/\b(could ?n[o']?t find|can ?n[o']?t find|not found|no such|does ?n[o']?t exist|
doesn'?t exist|unable to (find|locate)|don'?t see|there is no|no matches)\b/i
```

On match, capture the nearby "subject" tokens from the same sentence: backtick-quoted strings, slash-containing paths, and `camelCase`/`snake_case`/`kebab-case` identifiers ≥6 chars.

At `stream_end`, for each demoted block with captures: if a **later** block **in the same run** either (a) is an `act` with `isError === false` whose resolved `target` contains one of those tokens, or (b) is a `say` containing one of those tokens and *not* itself matching the negative pattern — append a chip to the block header:

```
⤫ superseded → step 14
```

Clicking it scrolls to that block.

**What it does:** adds a cross-reference. **What it never does:** hide text, rewrite text, strike text through, or claim the sentence is false.

**Why the asymmetry makes this shippable:** a false positive renders inside a `<details>` that is closed on every successful run. The cost of being wrong is a stray chip nobody sees; the cost of being right is the exact case the owner described. If anyone ever makes the trail default-open on success, **this rule must be pulled** — that is the condition it depends on.

Ships behind `localStorage['ruflow-supersede'] !== 'off'`, default on.

### Recall (~60-70%) and what it misses, stated plainly

Catches "couldn't find X → found X". Catches roughly **zero percent** of subtler reversals — "this is a race condition" → "actually it's a caching bug". For those, Tiers 1 and 2 are the entire answer, and that is acceptable, because demotion plus a sticky verdict already fixes the *reading order*, which is the owner's actual complaint.

### Explicitly rejected

A utility-model pass that regenerates an authoritative summary after the run (OpenClaw's session observation) is the "correct" general answer. Not building it: a second model call per turn, firing at exactly the moment the user is waiting for the finish, adding latency and cost and a new failure mode, on a tool whose owner ranked reliability above novelty. Deterministic and traceable beats smart and opaque on a control surface.

## Subagent preview

## What the backend can actually observe

Verified on this box: `claude --help` in CLI 2.1.226 lists `--forward-subagent-text` — *"Forward subagent text and thinking blocks as assistant/user messages with parent_tool_use_id set."* Adding it at server.js:1126-1133 is the entire unlock. There is no other source of subagent activity in `stream-json`.

Observable, therefore renderable:
- **Which agent** — `Task` tool_use `input.subagent_type`
- **Doing what** — `input.description`
- **How long** — wall clock between `tool_use` and its `tool_result`
- **Every text block it writes** — assistant events with `parent_tool_use_id`
- **Every tool it calls, and the result** — tool_use / tool_result with `parent_tool_use_id`
- **Its thinking blocks** — same events, `type:'thinking'`
- **Result size and status** — the Task's `tool_result`

Not observable, and the UI must not pretend otherwise: **partial stdout of a running Bash inside a subagent, ANSI colour, a cursor, or anything resembling a PTY.** `stream-json` carries structured events. Say this to the owner before building: what you get is *strictly more* than OpenClaw's Background Tasks rail (which shows only elapsed / tool count / current tool / bounded output) — you get the full nested stream — but it is not a terminal byte stream, and chasing one means a second transport and a second process model.

## Two altitudes. The main log is never interleaved.

**Glance — the agent card.** The `Task` row becomes a `kind:'agent'` block with a violet 2px rail:

```
2m14s ▌ agent  researcher   Audit auth module        11 tools · Grep   [open]
      ▌ ┌ Grep  src/auth/**/*.ts  "verifyToken"
      ▌ │ Read  src/auth/session.ts
      ▌ └ Bash  npm test -- auth
```

That tail is **exactly 3 lines, a ring buffer, `textContent` replaced not appended**. Fixed height, `overflow:hidden`, zero DOM growth however long the subagent runs. This is the "watching it in the terminal" feel at constant cost.

**Drill — the nested lane.** The same `<ol class="lane nested">` inside the card, rendered by the **same** `appendSay` / `appendAct` / `seal` functions at `depth+1`. There is no subagent component, no tasks rail, no separate page — there is a second `<ol>`. Any improvement to the main log automatically improves the subagent view. Collapsed, the card is one line: `✓ agent researcher · 11 steps · 42s`.

Concurrent agents stack vertically, each getting a hue from `--agent-1..4` round-robin by spawn order, used only as a 2px rail and the agent name — never a fill. **Parent-lane prose is never interleaved with children**; that is how you get an unreadable wall.

## Server work (~40 lines, all in the new `lib/stream-events.js`)

1. `args.push('--forward-subagent-text')` — behind `process.env.RUFLOW_SUBAGENT_TEXT !== 'off'` so it is one-line revertible.
2. `lane = event.parent_tool_use_id || (openLanes.size ? '_unattributed' : 'main')` on every assistant/user/stream_event.
3. **`currentMessageText` → `messageTextByLane: Map`.** Non-negotiable: the existing `startsWith` dedupe is a single variable and interleaved lanes corrupt it. Ship with the flag or not at all.
4. Subagent text goes into `laneBuffers`, **never** into `accumulatedText` — the persisted main transcript must stay clean.
5. On `tool_use` with `name === 'Task'`: emit `stream_lane_open`, `openLanes.set(block.id, …)`.
6. On the matching `tool_result`: emit `stream_lane_close`, delete from `openLanes`.
7. Persist lanes in `blocks[]` as `k:'agent'` entries with their own nested `blocks[]`.

## Verification step before default-on (U6 acceptance)

Run one cheap Haiku turn that spawns a `Task`, capture raw stdout to a file, and assert: (a) subagent assistant events carry `parent_tool_use_id`; (b) `stream_event` envelopes carry it too. **If (b) is false**, set `SUBAGENT_DELTAS=off`: suppress `text_delta` routing entirely while any lane is open and derive lane text from complete `assistant` blocks only. Deterministic, slightly less live, never wrong.

## Fallback if the flag disappoints

Card + elapsed timer + live child-tool count + `subagent_type` + `description`, with no nested lane. That is the OpenClaw-parity floor and needs no flag at all — `subagent_type` and `description` already reach the browser today inside `toolInput`, they are simply unlabelled and render as a generic grey box.

## Model picker

**Status: mostly already done, and correctly.** `public/index.html:99-112` already ships bare aliases with verified labels in three optgroups — `sonnet`/`opus`/`haiku` under "Latest", `sonnet[1m]`/`opus[1m]` under "Long context", `fable` under "Heavyweight". The comment block at :90-97 correctly documents why aliases beat pinned IDs. `server.js:1500` already stops stripping `[1m]`. **Do not rewrite the picker.**

Canonical values (verified against CLI 2.1.226 by live probe):

| value | resolves to | label |
|---|---|---|
| `sonnet` | `claude-sonnet-5` | Sonnet 5 — **default** |
| `opus` | `claude-opus-5` | Opus 5 |
| `haiku` | `claude-haiku-4-5-20251001` | **Haiku 4.5** — there is no Haiku 5; `claude-haiku-5` 404s |
| `fable` | `claude-fable-5` | Fable 5 · costliest ($0.057 vs $0.028 opus vs $0.0023 haiku on a one-token probe) |
| `opus[1m]` | `claude-opus-5[1m]` | entitled on this account |
| `sonnet[1m]` | `claude-sonnet-5[1m]` | entitled |

Never offer `haiku[1m]` — HTTP 400, "long context beta not available for this subscription". Never use pinned IDs as *values*: they rot two ways — 404 (`claude-3-5-haiku`) or **silent remap** (`claude-opus-4-1` returns success and bills `claude-opus-5`), which makes the picker lie.

## Remaining work (U10, all server-side, new file `lib/models.js`)

1. **Allowlist.** `server.js:1132` pushes `msg.model` straight to `--model` with no validation. A WebSocket client is not bound by the dropdown, and this server runs `--dangerously-skip-permissions`. Add `const ALLOWED = new Set(['sonnet','opus','haiku','fable','sonnet[1m]','opus[1m]'])`; anything else → fall back to `'sonnet'` and emit a `note`.
2. **Write-back.** `session.model` is set once at `createSession` and never updated when the user switches mid-session, so `handleRegenerate`'s `session.model || 'sonnet'` regenerates with a stale value. Set `session.model = model` in `handleChat` before spawn.
3. **`--fallback-model`.** Push `'--fallback-model', 'sonnet'` when the primary is `opus`, `fable`, or a `[1m]` variant. Overload resilience for the models most likely to 429.
4. **Multi-model attribution.** `server.js:1497` takes `Object.keys(modelUsage)[0]` only — a turn that ran a subagent on a second model reports one of them. Emit `models: Object.keys(event.modelUsage)`. When `length > 1`, or when the resolved model ≠ requested, emit `stream_fallback` and render a `note` row: `requested opus → served claude-sonnet-5 (429)`. Silent degradation currently gets blamed on the app.
5. **Per-run chip.** `.run-head .model` shows `requested → resolved` when they differ, resolved alone when they match. `[1m]` suffix preserved.

**Watch item:** `/home/claude-user/workspace/repos/ruflow/.claude/settings.json` pins `"model": "claude-opus-4-8"`, a previous-generation Opus. `--model` is passed explicitly on every spawn so it cannot leak, but any future code path that omits the flag would silently downgrade.

## Memory and vector wiring

## Current reality (verified live, not from recon)

Three of the recon's listed bugs are **already fixed in server.js**: the sync opens the DB fresh per call and writes via temp+`rename` (:226-229), syncs are serialised through `_syncChain` (:172-178), and `source_path` is unique per exchange (`'ruflow-ui:' + session.id + ':' + index`, :202). Errors are logged, not swallowed.

**But `data/memory/agentdb.sqlite` contains exactly 1 row matching `ruflow-ui%` — the legacy 384-char collided row — against 652 memories and 583 sessions.** The running `node server.js` process predates the fix. U9 must therefore include a **restart plus a one-off backfill**, not just code.

Still genuinely missing, and this is the owner's ask: **all three stores are write-only.** `systemParts` (server.js:1145-1215) never calls `searchMemory`, never touches `agentdb.sqlite`, never reads `graphify-out/`. Graphify has *zero* code wiring — four grep hits, all inside prompt strings (:273, :1167-1169) that ask the model nicely.

## Exact firing points — new file `lib/brain.js`, three functions

### 1. `recallForPrompt(userText)` — fires BEFORE spawn, in `handleChat`, synchronously, budget 150 ms

This is the piece that makes it a second brain instead of a write-only log.

- `searchMemory(userText, 3)` — existing substring scan over `memory/store.json`
- AgentDB keyword recall: open `agentdb.sqlite` **read-only**, `SELECT m.name, s.chunk_text FROM search_index s JOIN memories m ON m.id = s.memory_id WHERE s.chunk_text LIKE ? LIMIT 5` over the 3 longest tokens in `userText`
- Graphify: **only** when `detectSkillsForMessage` matched an architecture route or the text matches `/architect|module|structure|where is|how does .* work|codebase/i` — read `graphify-out/wiki/index.md`, and the single best-matching `Community_*.md` by filename token overlap, truncated to 2000 chars

Push one `systemPart`:
```
--- RECALL (prior context from this workspace's memory. Verify before relying on it.) ---
```
**Hard cap 4000 chars total.** Cache the AgentDB handle by file mtime so repeated turns do not re-read 7.9 MB.

### 2. `commitTurn({session, userText, blocks, resolvedModel})` — fires at `result`, AFTER `saveSession`, non-blocking

Replaces the existing `autoExtractMemory` + `syncSessionToVectorDb` call pair at server.js:1484-1490.

**(a) store.json memory — always, no regex gate.** The current `isTechnical` regex (`/function |class |import |...|curl /i`, :103) silently drops every plain-English turn, and the key is the *session name*, so the `addMemory` upsert makes every turn overwrite the previous one — **at most one row per session, ever**. Fix both:
- key = `` `${session.id}#${turnIndex}` `` (unique, so no upsert collision)
- no regex gate; store every turn where `userText.length ≥ 20`
- value = `Q:` (full) + `A:` (first 800 chars) + `Files: <deduped edit/write targets from blocks[]>` + `Tools: <distinct tool names>`
- tags `['auto','conversation', sessionId]`

**(b) AgentDB vector sync — make it incremental.** `doSyncSession` currently loops **every** pair via `pairExchanges(messages)` on every turn: turn N re-deletes and re-inserts N exchanges and re-chunks them, then exports and rewrites a 7.9 MB file. O(n²) plus a full serialise per turn. Change to `syncOnePair(session, index)` where `index = session.messages.length - 2`. Keep the `DELETE`-then-`INSERT` by `source_path` (idempotent on re-sync). **Debounce the `db.export()` + temp+rename to a 2 s trailing write**, and force-flush on `stream_end` of an idle session and on `SIGTERM`. Keep the `_syncChain` serialisation and the atomic rename exactly as they are.

**(c) Graphify — new, and the only place code gets written.** `queueGraphify(session, blocks)`:
- Fires **only** when `blocks[]` contains an `act` with `kind ∈ {edit, write}` whose resolved target is under `WORK_DIR` and is a code extension (`.js .ts .tsx .jsx .py .go .rs .java .cjs .mjs`). A chat turn about pizza does not touch the graph.
- Coalesces into a **60 s debounce**, one in-flight job max, dropping duplicates.
- `spawn('npx', ['graphify','update'], {cwd: WORK_DIR, detached:true, stdio:['ignore', logFd, logFd]})` with a 10-minute kill timer. **Never awaited, never on the request path.**
- Writes `graphify-out/.last-update.json` `{at, sessionId, files[], status}` so the state is inspectable.
- Emits a `note` block into the run: `graphify queued · 3 files` — so the owner can *see* it fired, which is the difference between "always pushes" and "we hope it pushes".

### 3. `commitSession(session)` — fires on session idle (5 min no turn), `session_delete`, and `SIGTERM`

- Force-flush the debounced AgentDB export
- Write one session-level rollup memory: `key = session:<id>`, value = name + turn count + deduped file list + model(s) used
- `INSERT OR REPLACE INTO sessions` with the final `message_count` and `summary`

## One-off backfill (part of U9, run once)

`scripts/backfill-agentdb.js` — walk `ruflow-ui/sessions/*.json`, call `syncOnePair` for every historical exchange, single export at the end. Delete the legacy `source_path = 'ruflow-ui'` row. Expect roughly 600-900 new `memories` rows. **Then restart the server** — the running process predates the uniqueness fix and will keep writing under the old code until it does.

## Performance plan

## Client — the streaming hot path is 90% of the win

Today `renderStreamingContent` (app.js:416-425) fires every 80 ms and: re-parses the **entire accumulated turn** through marked + DOMPurify → `contentEl.innerHTML = html` (destroying and rebuilding every node in the turn) → re-runs `enhanceCodeBlocks` over everything, rebuilding every line-number gutter by string concat because its idempotency guard was just erased by the innerHTML write → `autoScroll()` reads `scrollHeight` immediately after that write, a forced synchronous layout. A 30k-char turn re-parses 30k chars 12.5×/s. It is quadratic in turn length.

1. **Sealed blocks are immutable.** Parse + highlight once, never again. Kills the quadratic term outright.
2. **Live `say` is one text node**, `appendData(delta)`, `white-space: pre-wrap`. No parse, no innerHTML, no highlight on the hot path.
3. **rAF dirty-set replaces the 80 ms timer.** Coalesces multiple deltas per frame, up to 60fps when idle, and **pauses automatically in background tabs** — the current timer keeps parsing markdown for a tab nobody is looking at.
4. **`IntersectionObserver` on a 1px `#tail-sentinel` replaces all scroll reads.** No `scrollHeight`/`scrollTop`/`clientHeight` anywhere. Also fixes the unthrottled `checkScrollPosition` (app.js:1170-1175).
5. **`content-visibility: auto` on sealed runs**, with `contain-intrinsic-size: auto var(--run-h)` stamped from **one real measurement at seal**. One CSS declaration for ~90% of virtualization, zero scroll-math bugs, working Ctrl-F. Stamping the measured height is what prevents scrollbar jump — verify in Firefox as well as Chromium.
6. **Lazy detail bodies.** `.detail` is `hidden` **and empty**; the output string lives in the block model. A 200-tool run is 200 × ~4 header nodes, not 200 pre-built `<pre>` blocks.
7. **O(1) tool lookup** — `lane.byToolId.get(id)` replaces `document.querySelector('.tool-block[data-tool-id=…]')` (app.js:888), a full-document scan per result over a monotonically growing DOM.
8. **One delegated click listener** on `#run-log`. Removes the inline `onclick="window.__toggleToolBlock(this)"` (which is also an attribute-injection path fed by model-controlled tool names).
9. **One shared 1 s ticker** writing `textContent` on a live `getElementsByClassName('is-live')` collection; stops entirely when no run is active. Sealed rows have frozen durations computed once.
10. **Delete the 30 s `setInterval(updateTimestamps)`** (app.js:3023) — a `querySelectorAll` over the whole transcript, rewriting every timestamp forever. Gutter carries absolute clock + relative offsets, computed once.
11. **Delete `injectFeatureStyles()`** (app.js:2111-2199) — ~80 rules injected at DOMContentLoaded forcing a second style recalc after first paint, using `--bg-hover`/`--accent` when style.css defines `--hover-bg`/`--accent-primary`, so half of it silently falls back to hardcoded dark hex (this is why light theme is broken in those widgets).
12. **Vendor the three CDN scripts** (index.html:13-18: unpinned `marked`, hljs 11.9.0, DOMPurify 3.0.6 — no SRI, blocking first paint). Unpinned marked is literally what broke syntax highlighting.

### Named constants (`run-model.js`)

```
SEAL_MIN_CHARS          = 40
SEAL_IDLE_MS            = 4000
LIVE_ACTS_PER_LANE      = 60      // older act rows fold into the group summary
TOOL_OUTPUT_RENDER_CHARS= 20_000  // full text via fetch_tool_output
SUBAGENT_TAIL_LINES     = 3
GROUP_MIN_ACTS          = 6
LANE_DEPTH_CAP          = 2
```

## Server

13. **Text coalescing** — 50 ms / 400 chars per lane, **first delta of a run immediate**. `--include-partial-messages` produces one WS frame per token today; this cuts frame count 10-20× without touching time-to-first-token.
14. **Backpressure** — `send()` (server.js:~660) calls `ws.send` unconditionally. Above `bufferedAmount > 1e6`, widen that socket's coalescing window to 200 ms. Mandatory before `--forward-subagent-text` goes on, or a slow client queues unbounded server memory.
15. **`TOOL_OUTPUT_WIRE_CHARS = 120_000`** cap with a `truncated` flag; **`TOOL_OUTPUT_DISK_CHARS = 32_000`** cap in the session file. Uncapped `toolOutput` is why one session file is 903 KB, and that file is then re-read by every `listSessions`.
16. **`saveSession` debounce** to a 2 s trailing write, and drop `JSON.stringify(…, null, 2)` — pretty-printing is pure inflation on a file rewritten twice per turn.
17. **`listSessions` mtime cache.** It `readFileSync` + `JSON.parse`s **every** session file and is called from `/api/health`, `get_status`, `list_sessions`, `broadcastSessionUpdate` after every turn, **and `writeHeartbeat` on a 60 s timer** (server.js:239). ~1.3 MB of parsing on a forever-loop.
18. **Incremental AgentDB sync + debounced export** — see the brain section. Currently O(n²) re-insert plus a synchronous 7.9 MB serialise on the event loop, every turn.
19. **`child.stdin.on('error')`** — one line. `child.stdin.write(prompt)` at server.js:1237 has no handler; if `claude` exits before reading (bad flag, auth failure) the EPIPE surfaces as an unhandled stream error and takes the whole server down.

## Measurement — not vibes

Hidden `?perf=1` overlay: `performance.now()` around the rAF flush, block count, DOM node count. **Targets: flush p95 < 4 ms on a 200-block run; first paint < 400 ms with vendored scripts; a 40-tool 30k-char turn settling to ~60 DOM nodes after collapse.** If a change cannot be shown against those numbers, it does not land.

## Work plan

### 1. U0-GATE — auth + Origin allowlist (LANDS FIRST, ALONE)

**Files:** , , , 

**Depends on:** none — blocks nothing, blocked by nothing, but merge first

The WS has no auth and no Origin check, CORS is '*', /upload is unauthenticated, and the spawned CLI runs --dangerously-skip-permissions as claude-user with full filesystem access on a public IP. Any page the owner opens can drive it. Add: RUFLOW_TOKEN from .env; verifyClient on wss checking Origin against an allowlist AND a token in the upgrade query or cookie; token gate on /upload and /api/*; CORS narrowed to the allowlist. Ship as its own PR today, before any UI work — a better UI increases time-in-app and therefore exposure.

### 2. U1-WIRE — event contract (runId, seq, lane, new events)

**Files:** , 

**Depends on:** none

Extract processStreamEvent (server.js:1346-1512) into lib/stream-events.js as a pure factory taking {emitStream, session} — this is what lets U6/U8/U10 proceed without colliding in server.js. Add emitStream() stamping runId/seq/lane. Emit the new events: stream_lifecycle (2 phases), stream_thinking (from thinking_delta and assistant thinking blocks — currently dropped), stream_tool_progress (from content_block_start + input_json_delta — currently dropped), stream_fallback. Add kind to stream_tool_start via classifyTool(). Cap tool_result at TOOL_OUTPUT_WIRE_CHARS=120000 with truncated/fullChars. Read event.subtype and event.is_error on result so error_max_turns stops reporting as success. Add the fetch_tool_output client->server handler. Do NOT add --forward-subagent-text here.

### 3. U2-PERSIST — ordered blocks[] on disk + reload parity

**Files:** , 

**Depends on:** U1-WIRE

Accumulate an ordered blocks[] in emission order alongside accumulatedText and toolBlocks (both kept for old sessions) and write it into the assistant message at server.js:1477. Cap each block's output at TOOL_OUTPUT_DISK_CHARS=32000. Debounce saveSession to a 2s trailing write and drop the 2-space pretty-print. Without this, every segmented run flattens back to one bubble on reload and the whole redesign reads as a regression on refresh — it must ship in the same release as U4.

### 4. U3-CORE — run-model.js (pure, no DOM)

**Files:** , 

**Depends on:** U1-WIRE (contract only — can start against the written contract before U1 merges)

Run/Lane/Block structures, laneFor(), the seal rule with SEAL_MIN_CHARS=40 + absorbAsCaption + SEAL_IDLE_MS=4000, seq fencing, classifyTool() and resolveTarget() with the ordered probe list (command, file_path, path, pattern, url, query, description, name) and $HOME->~, summarizeToolGroup() with Set-based path dedupe, promoteVerdict() with the substantive/sign-off rule, wrapTrail(), and the Tier-3 negative-claim scan. Zero DOM references — every rule above is unit-testable against a recorded stream-json fixture. Land the fixture (one real 40-tool turn captured from stdout) with it.

### 5. U4-RENDER — run-render.js + stylesheet rewrite

**Files:** , , , 

**Depends on:** U3-CORE, U2-PERSIST

DOM builders for the five block kinds, the 96px mono gutter with tabular-nums, the sticky run-head, rAF dirty-set flush, IntersectionObserver auto-follow on #tail-sentinel, one delegated click listener, one shared 1s ticker, lazy detail bodies, content-visibility with height stamped at seal. app.js's six stream_* cases become thin dispatches; delete state.currentAssistantText / currentAssistantEl / currentToolBlocks (the last is already dead — written at :257/:882, never read), delete injectFeatureStyles(), delete the 30s updateTimestamps interval, delete animateMessageEntrance. renderSavedMessage renders blocks[] through the same renderer. Fold all injected rules into style.css with the correct variable names.

### 6. U5-VERDICT — demotion, verdict promotion, trail, supersede chip

**Files:** , , 

**Depends on:** U4-RENDER

Tier 1 live demotion on seal (colour + opacity only, 400ms, never font-size). Tier 2 at stream_end: promote the last substantive say to role='verdict' WITHOUT moving the node, wrap predecessors into <details class="trail"> via one DocumentFragment, mirror the verdict's first sentence into the sticky .peek, set trail open state by outcome (collapsed on success, expanded on failure). Tier 3 chip with jump link, gated behind localStorage['ruflow-supersede'] !== 'off'. Instrument it: log every turn whose promoted verdict is <300 chars so the sign-off rule can be tuned against a real week.

### 7. U6-SUBAGENT — --forward-subagent-text + lanes

**Files:** , , , , 

**Depends on:** U4-RENDER, U8-PERF (backpressure half)

Add the flag behind RUFLOW_SUBAGENT_TEXT!=='off' at server.js:1126-1133. Convert currentMessageText to messageTextByLane:Map (MANDATORY — the existing startsWith dedupe is one variable and interleaved lanes corrupt it; this is a bug the flag introduces). Route lane text into laneBuffers, never accumulatedText. Emit stream_lane_open/close on Task tool_use/tool_result. Client: agent block, violet rail, 3-line ring-buffer tail, nested <ol class="lane"> using the SAME renderer, depth cap 2, round-robin --agent-1..4 hues. Acceptance gate: capture one real Haiku Task turn's raw stdout and assert parent_tool_use_id is present on both assistant events AND stream_event envelopes; if the latter is absent, set SUBAGENT_DELTAS=off and derive lane text from complete assistant blocks only. Requires U8's backpressure to already be merged.

### 8. U7-MARKDOWN — vendor, pin, and actually turn highlighting back on

**Files:** , , , , 

**Depends on:** none

Highlighting is DEAD, not missing: app.js:60-73 sets marked's `highlight` option, removed in marked v5, and index.html:13 pulls unpinned latest — so hljs never runs and the loaded github-dark theme has nothing to paint. Vendor pinned marked + hljs 11.9.0 (common languages only, ~40) + DOMPurify 3.0.6 locally. Wire hljs through a marked.Renderer override (the v5+ API), not setOptions. Add escapeAttr() — the existing escapeHtml (app.js:84-88) does NOT escape '"' and is used inside double-quoted attributes carrying model-controlled paths at :840/:870-875. Add the ~40-line fence-repair pass for the seal-on-silence path only. Add the three regex highlighters: shell command tokenizer, language-diff for all edit/write kinds (generalising the Edit-only pass at :911), and path rendering with dimmed directory prefix + weight-500 basename. Fully independent of U1-U6.

### 9. U8-PERF — server caps, caches, coalescing, crash fix

**Files:** , 

**Depends on:** U1-WIRE

Text coalescing 50ms/400chars per lane with first-delta-immediate. ws.bufferedAmount backpressure (>1e6 -> 200ms window). listSessions mtime cache (currently re-parses every session file from /api/health, get_status, list_sessions, broadcastSessionUpdate AND the 60s heartbeat at server.js:239). child.stdin.on('error') — one line that currently lets an EPIPE take the whole server down. Add the ?perf=1 overlay hooks. Server half is fully independent; the client half (rAF, content-visibility, IntersectionObserver) lives inside U4.

### 10. U9-BRAIN — recall injection, memory writes, incremental vector sync, graphify

**Files:** , , 

**Depends on:** U1-WIRE (for blocks[] shape); otherwise independent

recallForPrompt() injected as a systemPart before spawn, 4000-char cap, 150ms budget — this is the piece that makes memory read/write instead of write-only. commitTurn(): drop the isTechnical regex gate and the session-name upsert key (currently at most ONE memory row per session, ever); switch doSyncSession to syncOnePair(index=len-2) and debounce db.export()+rename to 2s (currently O(n^2) re-insert plus a synchronous 7.9MB serialise per turn); add queueGraphify() gated on edit/write blocks touching code files under WORK_DIR, 60s debounce, detached spawn with a 10-min kill, writing graphify-out/.last-update.json and emitting a visible note block. commitSession() on idle/delete/SIGTERM. Ship scripts/backfill-agentdb.js and RUN IT, then RESTART the server: the uniqueness fix is in the code but agentdb.sqlite still holds exactly 1 legacy ruflow-ui row, so the live process predates it. Touches only the systemParts region and the result branch of server.js — no collision with U1's extraction if U1 lands first.

### 11. U10-MODEL — allowlist, write-back, fallback, multi-model attribution

**Files:** , , 

**Depends on:** U1-WIRE

Do NOT rewrite the picker — index.html:99-112 already ships the verified aliases with correct labels. Add: ALLOWED set validated at server.js:1132 (today any WS string reaches --model on a --dangerously-skip-permissions server); session.model write-back on change (it is set once at createSession and never updated, so regenerate uses a stale value); --fallback-model sonnet when primary is opus/fable/[1m]; emit models[] (all modelUsage keys, not just [0]) and stream_fallback when the resolved model differs from requested; render the requested->resolved chip in .run-head. Preserve the [1m] suffix — server.js:1500 already does this correctly, do not regress it.

### 12. U11-INSTRUMENTS — optional third column (LAST, cut freely)

**Files:** , , 

**Depends on:** U4-RENDER, U6-SUBAGENT

380px collapsible right column toggled with 'l': a 2x2 tabular gauge (ELAPSED / OUT TOK / $ / TOK-S), a live lane roster (main + each subagent with elapsed, tool count, current tool), a step jump index, and an error tray mirroring every failed act with jump links. Auto-collapses to a fixed overlay below 1180px. Purely additive — nothing in U1-U10 depends on it, and it should be cut without hesitation if the core needs another week.

## Do NOT do

- DO NOT re-fix the three backend bugs that are already fixed in the live server.js: accumulatedText already appends with a per-message startsWith dedupe (:1358-1396), syncSessionToVectorDb already opens the DB fresh per call and writes via temp+rename through a serialised _syncChain (:164-231), and source_path is already unique per exchange (:202). Re-'fixing' these will reintroduce the bugs their comments describe.

- DO NOT rewrite the model picker. public/index.html:99-112 already ships the verified bare aliases with correct labels and a comment explaining why. DO NOT convert them to pinned IDs — pinned IDs 404 (claude-3-5-haiku) or silently remap (claude-opus-4-1 bills as claude-opus-5), which makes the picker lie. DO NOT add a 'Haiku 5' — it does not exist; claude-haiku-5 returns 404. DO NOT offer haiku[1m] — HTTP 400, not entitled. DO NOT re-strip the [1m] suffix at server.js:1500.

- DO NOT build semantic or LLM-based contradiction detection, a utility-model session headline, or an end-of-run digest model call. A second model call fires at exactly the moment the user is waiting for the finish, and a confidently wrong summary is worse than a derived one. The verdict's first sentence plus derived counts answer the same question for free.

- DO NOT strike through, hide, rewrite, or reorder any text on the basis of the Tier-3 heuristic. It may only ever add a chip, and only to blocks that structural demotion has already collapsed. If anyone ever makes the trail default-open on success, pull the rule — that asymmetry is the only thing making it shippable.

- DO NOT port OpenClaw's server-side block streaming — EmbeddedBlockChunker, blockStreamingCoalesce, the break-preference chain, the fence close/reopen. That machinery exists because Discord and Slack impose atomic message size limits. We own both ends of the wire. Client-side segmentation at tool boundaries segments on meaning rather than character count and structurally cannot split a code fence, which is the documented bug class (#57875, #24858) in that code.

- DO NOT flush the open text block on EVERY tool start. That is OpenClaw's literal rule and it turns 'Let me check.' -> Read -> 'Now the config.' into fragment spam. Use SEAL_MIN_CHARS=40 with absorb-as-caption below it, and keep it a named constant because it will need tuning against a real 10-minute session.

- DO NOT move the verdict DOM node at stream_end. Promote it in place and wrap its predecessors. Moving the node the user is reading yanks the scroll position.

- DO NOT enable --forward-subagent-text without, in the same commit: (a) converting currentMessageText to a per-lane Map, (b) the lane routing, (c) the 3-line ring-buffer tail, and (d) ws.bufferedAmount backpressure. Any one missing and the flag makes the app measurably worse than it is today.

- DO NOT promise or attempt a PTY for subagents. stream-json carries structured events — there is no cursor, no ANSI, no partial stdout from a Bash running inside a subagent. Say this to the owner before building, not after.

- DO NOT build a virtual-scroll list. content-visibility: auto with contain-intrinsic-size stamped from one real measurement at seal gets ~90% of the benefit, has no scroll-anchoring bugs, and leaves Ctrl-F working.

- DO NOT build split panes, rewind/fork, companion side chat (/btw), show_widget/canvas/iframe embeds, an offline outbox with a sendState machine, steer/queue follow-up modes, a parent->child session tree in the sidebar, or consecutive-duplicate collapsing. Every one is in the OpenClaw inventory and every one is an amplifier on a core that does not exist yet.

- DO NOT add a framework, a bundler, TypeScript, or a build step. Plain <script> tags in order. No-build is load-bearing: the running app stays the source, debuggable from the browser's own sources panel at 2am, which is precisely when it will be needed.

- DO NOT add remend or marked-highlight. Vendor pinned marked + highlight.js + DOMPurify and wire hljs through a marked.Renderer override. Fence repair is ~40 lines and is only needed on the seal-on-silence path.

- DO NOT run hljs, marked, or enhanceCodeBlocks on the streaming tail. Live say blocks are one text node with appendData. Highlighting a half-written function 12 times a second produces flickering wrong colours, and it is the entire performance bug.

- DO NOT change font-size, padding, or margin during demotion. Colour and opacity only. Anything that changes box metrics reflows every row below and moves the text the user is mid-sentence on.

- DO NOT leave injectFeatureStyles() in place alongside the new stylesheet. It defines ~80 rules against --bg-hover and --accent while style.css defines --hover-bg and --accent-primary, so half of it already silently falls back to hardcoded dark hex. Two stylesheets with a mismatched namespace plus a new palette is strictly worse than today.

- DO NOT ship the client renderer without U2-PERSIST in the same release. Old sessions have no blocks[] and will render through the legacy path — that is expected and acceptable — but new sessions flattening on reload will read as the fix being flaky.

- DO NOT backfill interleaving into old sessions. The ordering was never recorded; any reconstruction from the unordered toolBlocks bag would be a guess presented as history.

- DO NOT nest subagent lanes deeper than 2 levels, and do not make the cap configurable. Past two levels the indentation eats the column; a config option just relocates the bug.

- DO NOT fix the adjacent bugs in these PRs. Listed for a separate branch: clearChatArea (app.js:1132-1148) nukes #chat-messages.innerHTML and permanently destroys #scroll-bottom-btn and #chat-search-bar on the first session switch; createChatSearchBar (:2366-2386) early-returns because index.html already defines the id so its listeners never bind, and openChatSearch toggles .open while the CSS keys on .visible (in-chat search has never worked); deleteSessionFile only sets archived:true and nothing ever writes to TRASH_DIR so restore can never succeed; cleanupTrash's comment says 7 days and its code says 30. Sweeping these in violates surgical-change discipline and will make the diffs unreviewable.

- DO NOT invent progress bars, percentage estimates, skeleton shimmer, pulsing cards, or a rotating 'working phrase'. There is no denominator. Liveness comes from changing numbers — elapsed, output tokens, tool count, current tool name — plus exactly one animated element, the rail scanline.

- DO NOT ship any UI work before U0-GATE. The WebSocket is unauthenticated with CORS '*' and drives a --dangerously-skip-permissions CLI as claude-user on a publicly reachable IP; any page the owner opens in any tab can run arbitrary commands on the box. A more pleasant UI increases time-in-app and therefore exposure.
