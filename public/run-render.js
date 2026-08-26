// -----------------------------------------------------------------------------
// run-render.js — DOM half of U4-RENDER, plus the RENDER HALF of U5-VERDICT and
// U6-SUBAGENT (SPEC-v2.md). Turns a RunModel Run (public/run-model.js, pure,
// no DOM) into the process-log DOM the owner watches while a turn runs, and
// keeps it live-updating without re-parsing anything already on screen.
//
// THE ONE RULE THAT MATTERS: a live `say` block is exactly one text node,
// updated with `appendData`, `white-space: pre-wrap`. No markdown, no
// innerHTML, no highlight until the instant it seals. That path is
// `flushBlockText()` below — read it before touching anything else in this
// file. Everything else (tool rows, agent lanes, the verdict/trail wrap) is
// comparatively rare (one event per tool call, one promotion per run) and is
// applied synchronously; only text/thinking deltas go through the rAF
// dirty-set, because those are the ones that can arrive 12+ times a second.
//
// SCOPE, DELIBERATELY EXCLUDED (see the report handed to the integration
// agent for the reasoning):
//   - Group collapsing ("≥6 consecutive act blocks -> one row"). Needs a
//     summarizeToolGroup() pure function in run-model.js; that file's own
//     header explicitly excludes it and my task brief did not name it either.
//     Every act block renders individually today — correct, just not folded.
//   - Tier 3 (negative-claim supersede chip). run-model.js's negClaims stays
//     empty by design (out of its scope too); nothing to render yet.
//   - U7's shell/diff/path highlighters for the lazy detail pane. Detail
//     bodies render plain, escaped text — deliberately, so this file does not
//     reach into another unit's job.
//
// PUBLIC API — window.RunRender
//   .mountRun(container, opts)        Start a NEW live run. opts:
//                                        { id, sessionId, model, startedAt,
//                                          prompt, home }
//                                      `home`, if given, is stripped as a path
//                                      PREFIX for display only (never a global
//                                      replace) — same rule as run-model.js's
//                                      own tildeHome(), reproduced here because
//                                      onToolStart() never passes a home to it.
//                                      Returns a RunView (see below).
//   .renderSavedRun(container, opts)  Replay a PERSISTED assistant message's
//                                      blocks[] (U2-PERSIST's on-disk shape,
//                                      {k, lane, seq, ...}) into a static,
//                                      already-sealed run. opts:
//                                        { id, sessionId, model, prompt,
//                                          blocks, status, endedAt, cost,
//                                          duration, outputTokens, home }
//                                      Reuses the exact same builders as a
//                                      live run by replaying the persisted
//                                      array as a synthetic event sequence
//                                      through RunModel.ingest() — "one
//                                      renderer, two entry points" (SPEC-v2.md
//                                      U2-PERSIST), not a second render path.
//   RunView (returned by mountRun):
//     .run                 the RunModel Run object (read-only; for debugging)
//     .root                the `.run` <section> element
//     .ingest(event)        feed one server->client stream event (the exact
//                           envelope shape in SPEC-v2.md's event contract —
//                           runId/seq/lane already stamped)
//     .setToolOutput(toolId, content)
//                           call when a `tool_output_full` response arrives
//                           (see "Full output" below) — fills in the detail
//                           pane past TOOL_OUTPUT_RENDER_CHARS
//     .setShowThinking(bool)
//                           show/hide this run's `think` blocks
//     .destroy()            stop this run's participation in the shared
//                           ticker (call on session switch / teardown)
//
// Full output — this file never touches the WebSocket (it isn't mine to
// open). When rendered output is truncated past
// RunModel.TOOL_OUTPUT_RENDER_CHARS, the detail pane shows a button; clicking
// it dispatches a CustomEvent('ruflow:fetch-tool-output', {detail:{toolId,
// sessionId}}) on the mount container. The integration agent listens for
// that, sends the existing `fetch_tool_output` message, and on the
// `tool_output_full` reply calls `view.setToolOutput(toolId, content)`.
//
// REQUIRED SCRIPT TAGS, after run-model.js and highlight-wire.js's vendor
// chain, before app.js (see the report for the exact block):
//   <script src="run-model.js"></script>
//   <script src="vendor/marked/marked.min.js"></script>
//   <script src="vendor/highlightjs/highlight.min.js"></script>
//   <script src="vendor/dompurify/purify.min.js"></script>
//   <script src="highlight-wire.js"></script>
//   <script src="run-render.js"></script>
//   <script src="app.js"></script>
// -----------------------------------------------------------------------------

(function (global) {
  'use strict';

  var RunModel = global.RunModel;
  var Highlight = global.RuflowHighlight;
  if (!RunModel) throw new Error('run-render.js: run-model.js must load first');
  if (!Highlight) throw new Error('run-render.js: highlight-wire.js (+ its vendor chain) must load first');

  var TICK_MS = 1000;
  var AGENT_HUES = 4; // --agent-1..4, round-robin by spawn order (SPEC-v2.md)

  // ===========================================================================
  // Formatting helpers — pure, no DOM. `precise` gives one decimal for
  // sub-minute durations (individual rows, where the extra digit is the only
  // signal something is still moving); aggregates (trail summary, run-foot)
  // pass precise=false and round to the second.
  // ===========================================================================

  function fmtDuration(ms, precise) {
    if (ms == null || ms < 0 || isNaN(ms)) return '';
    var s = ms / 1000;
    if (s < 60) return (precise ? s.toFixed(1) : String(Math.round(s))) + 's';
    var m = Math.floor(s / 60);
    var rem = Math.round(s - m * 60);
    if (rem === 60) { m += 1; rem = 0; }
    return m + 'm' + rem + 's';
  }

  function fmtOffset(ms) {
    return '+' + fmtDuration(ms, true);
  }

  function fmtTokens(n) {
    if (n == null) return '';
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + 'k';
  }

  // First sentence of a text, for the sticky .peek line. Deliberately dumb
  // (split on the first ., ! or ? followed by space/end) — anything smarter is
  // an LLM-shaped rabbit hole the spec already rejected for bigger jobs than
  // this one.
  var SENTENCE_END_RE = /[.!?](\s|$)/;
  function firstSentence(text, maxLen) {
    var trimmed = (text || '').trim();
    if (!trimmed) return '';
    var m = SENTENCE_END_RE.exec(trimmed);
    var s = m ? trimmed.slice(0, m.index + 1) : trimmed;
    if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
    return s;
  }

  // Reproduced from run-model.js's tildeHome() — that function is exported
  // but onToolStart() never calls it with a `home`, so target strings arrive
  // here un-collapsed. This is presentation only (never mutates block.target)
  // and is a prefix-only match, never a global replace, for the same reason
  // the model-layer version is: a command that merely *mentions* the home
  // dir mid-sentence must not be mangled.
  function tildeHome(str, home) {
    if (!home || typeof str !== 'string' || str.indexOf(home) !== 0) return str;
    return '~' + str.slice(home.length);
  }

  function splitTargetForDisplay(target, home) {
    var t = tildeHome(target || '', home);
    var slash = t.lastIndexOf('/');
    if (slash === -1) return { dir: '', base: t };
    return { dir: t.slice(0, slash + 1), base: t.slice(slash + 1) };
  }

  function kindLabel(block) {
    if (block.kind === 'agent') return 'agent';
    if (block.kind2 === 'command') return (block.toolName || 'command').toLowerCase();
    return block.kind2 || 'other';
  }

  // ===========================================================================
  // Element factory — one tiny helper so builders below read as structure, not
  // seven-argument createElement calls. `cls` and `text` are always set via
  // className/textContent, never innerHTML — every string that reaches this
  // function can be model-controlled (a tool name, a file path, a caption)
  // and textContent is XSS-safe by construction, so nothing here needs an
  // escaping helper.
  // ===========================================================================

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ===========================================================================
  // Sealed-content rendering — the ONLY place marked/hljs/DOMPurify get called
  // from this file, and only ever on a block that is already sealed.
  // ===========================================================================

  function paintSealed(messageTextEl, text) {
    messageTextEl.innerHTML = Highlight.renderSealed(text || '');
  }

  // ===========================================================================
  // Block builders — one per kind. Each returns the <li class="blk ..."> and
  // stashes it on block.el / block.bodyEl (run-model.js documents both as
  // "renderer-owned DOM ref; this module never reads it" — this is that
  // owner). Live text blocks (say/think) get a bare text node as their only
  // child so the hot path is `appendData`, never innerHTML.
  // ===========================================================================

  function buildGutter(block, run) {
    var g = el('div', 'gut mono');
    if (block.kind === 'say' || block.kind === 'think') {
      g.textContent = fmtOffset(block.startedAt - run.startedAt);
    }
    return g;
  }

  function buildSayOrThink(block, run) {
    var isThink = block.kind === 'think';
    var li = el('li', 'blk ' + block.kind);
    li.dataset.blkId = block.id;
    li.dataset.state = 'live';

    /*
     * Unattributed lane text is labelled where it appears. Left unmarked it is
     * ordinary prose sitting beside the real answer, and — because it belongs to
     * no lane the trail collects — it stays visible after everything else folds
     * away. Marking it note also makes it ineligible for verdict promotion.
     */
    if (isUnattributed(block.lane)) {
      li.classList.add('unattributed');
      li.dataset.role = 'note';
      block.role = 'note';
      var tag = el('div', 'unattributed-tag');
      tag.textContent = 'unattributed agent output';
      li.appendChild(tag);
    }

    li.appendChild(buildGutter(block, run));
    var body = el('div', isThink ? 'body think' : 'body prose');
    var mt = el('div', 'message-text');
    mt.appendChild(document.createTextNode(''));
    body.appendChild(mt);
    li.appendChild(body);
    block.el = li;
    block.bodyEl = mt;
    return li;
  }

  // A rendered .row for an act/agent block — the clickable summary line. Kept
  // separate from buildAct/buildAgent because upgradeToAgent() rebuilds it in
  // place when a Task's stream_lane_open arrives just after its
  // stream_tool_start (the ordering guarantee — see SPEC-v2.md).
  function buildRow(block, home) {
    var row = el('button', 'row');
    row.type = 'button';
    row.appendChild(el('span', 'k mono', kindLabel(block)));

    if (block.kind === 'agent') {
      row.appendChild(el('b', null, block.target || block.agentType || 'agent'));
      if (block.caption) row.appendChild(el('span', 'cap', block.caption));
      row.appendChild(el('span', 'ct mono', ''));
    } else {
      var t = splitTargetForDisplay(block.target, home);
      var code = el('code', 'target mono');
      if (t.dir) code.appendChild(el('span', 'dir', t.dir));
      if (t.base) code.appendChild(document.createTextNode(t.base));
      if (t.dir || t.base) row.appendChild(code);
      if (block.caption) row.appendChild(el('span', 'cap', block.caption));
    }

    var glyph = el('span', 'glyph mono', '');
    row.appendChild(glyph);
    return row;
  }

  function buildAct(block, run) {
    var li = el('li', 'blk act');
    li.dataset.blkId = block.id;
    li.dataset.kind = block.kind2 || 'other';
    li.dataset.state = block.state;
    if (block.toolId) li.dataset.toolId = block.toolId;
    li.appendChild(buildGutter(block, run));
    li.appendChild(buildRow(block, run._home));
    var detail = el('div', 'detail');
    detail.hidden = true;
    li.appendChild(detail);
    block.el = li;
    block.bodyEl = detail; // "renderer-owned"; detail body for act/agent, not text
    markLive(li.querySelector('.gut'), block.startedAt); // ticks until stream_tool_result freezes it
    return li;
  }

  function agentHueClass(index) {
    return 'hue-' + (((index - 1) % AGENT_HUES) + 1);
  }

  function buildAgent(block, run, agentIndex) {
    var li = el('li', 'blk agent ' + agentHueClass(agentIndex));
    li.dataset.blkId = block.id;
    li.dataset.state = block.state;
    if (block.toolId) li.dataset.toolId = block.toolId;
    li.dataset.laneId = block.toolId || '';
    li.appendChild(buildGutter(block, run));
    var rail = el('div', 'rail');
    li.appendChild(rail);
    var main = el('div', 'agent-main');
    main.appendChild(buildRow(block, run._home));
    var tail = el('pre', 'tail mono');
    main.appendChild(tail);
    var nested = el('ol', 'lane nested');
    nested.dataset.lane = block.toolId || '';
    // "Two altitudes" (SPEC-v2.md): the 3-line tail above is always visible
    // (glance) — the full nested lane is drill-down, hidden until the row is
    // clicked. Unlike an act block's .detail this is NOT lazily built: its
    // content is populated continuously by nested tool events whether or not
    // it is currently shown, so collapsing it never loses anything.
    nested.hidden = true;
    main.appendChild(nested);
    li.appendChild(main);
    block.el = li;
    block.bodyEl = nested;
    block._tailEl = tail;
    block._tailLines = [];
    return li;
  }

  function buildNote(block) {
    var li = el('li', 'blk note');
    li.dataset.blkId = block.id;
    li.dataset.state = block.state;
    li.textContent = block.text || '';
    block.el = li;
    return li;
  }

  // ===========================================================================
  // Live text flush — the hot path. ONE text node per say/think block,
  // ONE appendData call per rAF frame, no matter how many stream_text
  // deltas arrived that frame. `_rendered` (chars already painted) is a
  // renderer-owned counter living on the block object, not in run-model.js.
  // ===========================================================================

  function flushBlockText(block) {
    if (!block.bodyEl || block.sealed) return; // sealed blocks are immutable — never re-touched here
    var node = block.bodyEl.firstChild;
    if (!node) { node = document.createTextNode(''); block.bodyEl.appendChild(node); }
    var have = block._rendered || 0;
    var full = block.text || '';
    if (full.length > have) {
      node.appendData(full.slice(have));
      block._rendered = full.length;
    }
  }

  // Finalize a block that seal() just marked sealed=true: paint its markdown
  // once, freeze its gutter/state, and never touch it again. Called from
  // every path that can seal a say/think block (tool-start seal, 4s idle
  // seal via the shared ticker, stream_end's all-lanes seal).
  function finalizeSayBlock(block) {
    if (!block.el || block._finalized) return;
    block._finalized = true;
    if (block.bodyEl) paintSealed(block.bodyEl, block.text);
    block.el.dataset.state = block.state; // 'ok'
    applyRoleClass(block);
  }

  function finalizeThinkBlock(block) {
    if (!block.el || block._finalized) return;
    block._finalized = true;
    // think is dim italic mono, never markdown — it is model reasoning, not
    // an answer, and highlighting it would imply it is meant to be read as
    // formatted output.
    if (block.bodyEl) block.bodyEl.textContent = block.text;
    block.el.dataset.state = block.state;
  }

  // Tier 1 (structural demotion) and Tier 2 (verdict) both resolve to
  // block.role in run-model.js; this is the one place that role becomes a
  // DOM attribute. Colour + opacity only, via CSS on [data-role] — see
  // style.css. Never touched: font-size, padding, margin (SPEC-v2.md "Do NOT
  // change font-size, padding or margin during demotion").
  function applyRoleClass(block) {
    if (block.kind !== 'say' || !block.el) return;
    if (block.role) block.el.dataset.role = block.role;
    else delete block.el.dataset.role;
  }

  // ===========================================================================
  // Shared 1s ticker — ONE setInterval for the whole page, started on the
  // first live run and cleared when none remain. Writes textContent on
  // `.is-live` elements (run-head elapsed + any still-open act/agent
  // duration) and drives the SEAL_IDLE_MS half of the seal rule, since
  // run-model.js owns no timer of its own.
  // ===========================================================================

  var liveRuns = new Map(); // runId -> RunView
  var tickHandle = null;

  function tick() {
    var now = Date.now();
    var nodes = document.getElementsByClassName('is-live'); // one live collection, per SPEC-v2.md perf item 9
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var started = Number(n.dataset.started);
      if (!started) continue;
      n.textContent = fmtDuration(now - started, true);
    }
    liveRuns.forEach(function (view) {
      var sealed = RunModel.sealIdleSays(view.run, now);
      for (var j = 0; j < sealed.length; j++) {
        var b = sealed[j];
        if (b.kind === 'think') finalizeThinkBlock(b); else finalizeSayBlock(b);
      }
    });
  }

  function registerLiveRun(view) {
    liveRuns.set(view.run.id, view);
    if (!tickHandle) tickHandle = setInterval(tick, TICK_MS);
  }

  function unregisterLiveRun(view) {
    liveRuns.delete(view.run.id);
    if (liveRuns.size === 0 && tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  }

  function markLive(node, startedAt) {
    node.classList.add('is-live');
    node.dataset.started = String(startedAt);
    node.textContent = fmtDuration(Date.now() - startedAt, true); // don't wait up to 1s for the first tick to paint anything
  }
  function freezeLive(node, text) {
    node.classList.remove('is-live');
    delete node.dataset.started;
    if (text != null) node.textContent = text;
  }

  // ===========================================================================
  // Container setup — the delegated click listener, the tail sentinel +
  // IntersectionObserver auto-follow, and the show-thinking flag all live at
  // the CONTAINER level (one per scroll region), not per run. Idempotent: a
  // second mountRun() on the same container is a no-op here.
  // ===========================================================================

  function ensureContainer(container) {
    if (container._runRenderCtx) return container._runRenderCtx;

    var sentinel = document.createElement('div');
    sentinel.id = 'tail-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    container.appendChild(sentinel);

    var ctx = { sentinel: sentinel, autoFollow: true };

    // Auto-follow: watch the sentinel, not scrollHeight/scrollTop (SPEC-v2.md
    // perf item 4 — "No scrollHeight/scrollTop/clientHeight anywhere").
    if ('IntersectionObserver' in global) {
      var io = new IntersectionObserver(function (entries) {
        ctx.autoFollow = entries[entries.length - 1].isIntersecting;
      }, { root: container, threshold: 0 });
      io.observe(sentinel);
      ctx.io = io;
    }

    // ONE delegated click listener for every run mounted in this container
    // (SPEC-v2.md perf item 8 — replaces the inline onclick attribute-
    // injection path). Handles: an act row's lazy detail pane, an agent
    // row's drill-down nested lane, and the "load full output" button.
    container.addEventListener('click', function (ev) {
      var loadBtn = ev.target.closest('.load-full-output');
      if (loadBtn) {
        var toolId = loadBtn.dataset.toolId;
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading…';
        container.dispatchEvent(new CustomEvent('ruflow:fetch-tool-output', {
          detail: { toolId: toolId, sessionId: container.dataset.sessionId || null },
        }));
        return;
      }
      var row = ev.target.closest('.row');
      if (!row || !container.contains(row)) return;
      var li = row.closest('.blk');
      if (!li) return;
      if (li.classList.contains('agent')) {
        var nested = li.querySelector(':scope > .agent-main > .lane.nested');
        if (nested) nested.hidden = !nested.hidden;
      } else {
        var detail = li.querySelector(':scope > .detail');
        if (detail) toggleDetail(li, detail);
      }
    });

    container._runRenderCtx = ctx;
    return ctx;
  }

  function maybeAutoFollow(ctx) {
    if (ctx.autoFollow) ctx.sentinel.scrollIntoView({ block: 'end' });
  }

  // ===========================================================================
  // Lazy detail body — hidden AND empty until first expand (perf item 6).
  // Built from data already sitting on the block object (block.output,
  // block.toolInputRaw — the latter is a renderer-owned field this file
  // attaches at tool-start time, since run-model.js's Block keeps only the
  // resolved `target`, not the raw input, per its own scope).
  // ===========================================================================

  function toggleDetail(li, detail) {
    if (detail.hidden) {
      if (!detail.dataset.built) buildDetailBody(li, detail);
      detail.hidden = false;
    } else {
      detail.hidden = true;
    }
  }

  function buildDetailBody(li, detail) {
    detail.dataset.built = '1';
    var block = detail._block;
    if (!block) return;

    if (block.toolInputRaw != null) {
      var inputPre = el('pre', 'detail-input');
      inputPre.textContent = safeStringify(block.toolInputRaw);
      detail.appendChild(inputPre);
    }
    if (block.output != null) {
      var shown = block.output.length > RunModel.TOOL_OUTPUT_RENDER_CHARS
        ? block.output.slice(0, RunModel.TOOL_OUTPUT_RENDER_CHARS)
        : block.output;
      var outPre = el('pre', 'detail-output');
      outPre.textContent = shown;
      detail.appendChild(outPre);
      if (block.truncated || block.output.length > RunModel.TOOL_OUTPUT_RENDER_CHARS) {
        var btn = el('button', 'load-full-output', 'Load full output (' + fmtTokens(block.fullChars || block.output.length) + ' chars)');
        btn.type = 'button';
        btn.dataset.toolId = block.toolId;
        detail.appendChild(btn);
      }
    }
    if (!block.toolInputRaw && block.output == null) {
      detail.appendChild(el('p', 'detail-empty', 'No output.'));
    }
  }

  function safeStringify(obj) {
    try { return JSON.stringify(obj, null, 2); } catch (e) { return String(obj); }
  }

  // ===========================================================================
  // Run-head + run skeleton
  // ===========================================================================

  function buildRunSkeleton(run, prompt) {
    var root = el('section', 'run');
    root.dataset.runId = run.id;
    root.dataset.status = 'live';

    var head = el('header', 'run-head');
    head.appendChild(el('span', 'glyph', '●'));
    var modelEl = el('span', 'model chip mono', run.model || '');
    head.appendChild(modelEl);
    var elapsedEl = el('span', 'elapsed mono', '0.0s');
    markLive(elapsedEl, run.startedAt);
    head.appendChild(elapsedEl);
    var burnEl = el('span', 'burn mono', '');
    head.appendChild(burnEl);
    var peekEl = el('p', 'peek', '');
    head.appendChild(peekEl);
    root.appendChild(head);

    if (prompt) {
      var promptWrap = el('div', 'prompt');
      var promptText = el('div', 'message-text', prompt);
      promptWrap.appendChild(promptText);
      root.appendChild(promptWrap);
    }

    var mainOl = el('ol', 'lane');
    mainOl.dataset.lane = 'main';
    root.appendChild(mainOl);

    var foot = el('footer', 'run-foot mono');
    foot.hidden = true;
    root.appendChild(foot);

    return { root: root, head: head, modelEl: modelEl, elapsedEl: elapsedEl, burnEl: burnEl, peekEl: peekEl, mainOl: mainOl, foot: foot };
  }

  // ===========================================================================
  // Event ingestion — one function per event type, mirroring run-model.js's
  // own dispatcher shape but adding the DOM work RunModel deliberately does
  // not do. Kept as a big switch (not a lookup table) to match run-model.js's
  // own ingest() for anyone reading both files side by side.
  // ===========================================================================

  function laneOl(run, laneId, mainOl) {
    if (!laneId || laneId === 'main') return mainOl;
    var lane = run.lanes.get(laneId);
    if (lane && lane._flattenInto) return lane._flattenInto; // depth-cap spill (see below)
    var agentBlock = lane && lane.agentBlockId ? run.byId.get(lane.agentBlockId) : null;
    return agentBlock && agentBlock.bodyEl ? agentBlock.bodyEl : mainOl;
  }

  /*
   * Text the CLI emitted while a subagent lane was open but which carried no
   * parent_tool_use_id. The server tags it _unattributed rather than guessing.
   *
   * The spec is explicit that this must be a VISIBLE TELL, not a silent misfile:
   * it has no agentBlockId, so laneOl() falls through to main and it would
   * otherwise render as ordinary assistant prose, indistinguishable from the
   * answer and sitting outside the trail that collapses everything else.
   */
  function isUnattributed(laneId) {
    return laneId === '_unattributed';
  }

  function insertInOrder(ol, li, seq) {
    // Blocks arrive in seq order on every path this file uses (live wire
    // order, or the replay's own monotonic synthetic counter), so appendChild
    // is always correct; insertInOrder exists as one guarded seam rather than
    // scattering appendChild calls, in case a future caller ever needs to
    // splice an out-of-order block back in.
    ol.appendChild(li);
  }

  function ingestEvent(view, els, event, dirty, scheduleFlush) {
    var run = view.run;

    switch (event.type) {
      case 'stream_start': {
        RunModel.ingest(run, event);
        if (event.requestedModel && event.model && event.requestedModel !== event.model) {
          els.modelEl.textContent = event.requestedModel + ' → ' + event.model;
        } else {
          els.modelEl.textContent = event.model || run.model || '';
        }
        return;
      }

      case 'stream_lifecycle':
        RunModel.ingest(run, event);
        return;

      case 'stream_text':
      case 'stream_thinking': {
        var lane0 = RunModel.laneFor(run, event.lane);
        var wasOpen = event.type === 'stream_text' ? lane0.openSay : lane0.openThink;
        var block = RunModel.ingest(run, event);
        if (!block) return;
        if (!wasOpen) {
          // First delta of a new block — build its <li> immediately so it
          // appears with the first token, not on the next rAF frame.
          var ol = laneOl(run, event.lane, els.mainOl);
          var li = buildSayOrThink(block, run);
          insertInOrder(ol, li, block.seq);
        }
        dirty.add(block);
        scheduleFlush();
        return;
      }

      case 'stream_tool_start': {
        var lane1 = RunModel.laneFor(run, event.lane);
        var openSay = lane1.openSay; // captured BEFORE ingest — onToolStart mutates this
        var actBlock = RunModel.ingest(run, event);
        if (!actBlock) return;
        actBlock.toolInputRaw = event.toolInput != null ? event.toolInput : null;

        // The seal rule's other half: what happened to the open say block.
        // finalizeSayBlock() always repaints from the authoritative
        // block.text, not from whatever appendData had caught up to, so
        // there is nothing to flush first — paintSealed() is the flush.
        if (openSay) {
          if (run.byId.has(openSay.id)) {
            finalizeSayBlock(openSay); // >= SEAL_MIN_CHARS: sealed in place
          } else {
            // < SEAL_MIN_CHARS: absorbed as the new row's caption; run-model.js
            // already popped it from lane.blocks/run.byId — remove its <li>.
            if (openSay.el && openSay.el.parentNode) openSay.el.parentNode.removeChild(openSay.el);
          }
          dirty.delete(openSay);
        }
        // run-model.js's onToolStart only closes lane.openSay, not
        // lane.openThink (see its own onStreamEnd for the pattern this
        // mirrors) — a tool call does not structurally end a thinking block
        // the way it ends prose, but leaving it open here would let the
        // NEXT stream_thinking event on this lane (which the server treats
        // as a fresh block once its own tool_use clears openThinkBlock)
        // silently append onto an already-live one. Close it explicitly.
        if (lane1.openThink) {
          var openThink = lane1.openThink;
          RunModel.seal(run, lane1, openThink);
          lane1.openThink = null;
          finalizeThinkBlock(openThink);
          dirty.delete(openThink);
        }

        var ol1 = laneOl(run, event.lane, els.mainOl);
        var actLi = buildAct(actBlock, run);
        insertInOrder(ol1, actLi, actBlock.seq);

        if (lane1.id !== 'main') updateAgentCounters(run, lane1);
        return;
      }

      case 'stream_tool_result': {
        var lane2 = RunModel.laneFor(run, event.lane);
        var block2 = RunModel.ingest(run, event);
        if (!block2 || !block2.el) return;
        var li2 = block2.el;
        li2.dataset.state = block2.state;
        var glyph2 = li2.querySelector('.glyph');
        if (glyph2) glyph2.textContent = block2.state === 'err' ? '✗' : '✓';
        var durEl = li2.querySelector('.gut');
        if (durEl) freezeLive(durEl, fmtDuration(block2.endedAt - block2.startedAt, true));
        if (block2.bodyEl) block2.bodyEl._block = block2; // detail pane reads this lazily on first expand
        if (lane2.id !== 'main') updateAgentCounters(run, lane2);
        return;
      }

      case 'stream_lane_open': {
        // onLaneOpen() already calls laneFor() on the parent internally —
        // no need to do it again here.
        var agentBlock = RunModel.ingest(run, event);
        if (!agentBlock) return;

        var childLane = run.lanes.get(event.laneId);
        var overCap = childLane.depth >= RunModel.LANE_DEPTH_CAP;

        if (overCap) {
          // Depth cap — SPEC-v2.md "Nesting": no third level of nested <ol>.
          // Flatten this lane's own rows into its PARENT's rendered <ol>
          // (the innermost real nested list that exists) with a "↳ agentType"
          // prefix per row, instead of building a doubly-nested list.
          var parentLaneId = event.parentLane || 'main';
          childLane._flattenInto = laneOl(run, parentLaneId, els.mainOl);
          upgradeToFlatAgentMarker(agentBlock, childLane);
        } else {
          upgradeToAgent(agentBlock, run, agentSpawnIndex(run));
        }
        return;
      }

      case 'stream_lane_close': {
        var lane3 = run.lanes.get(event.laneId);
        if (lane3) {
          // Close out anything still open in the child lane — run-model.js's
          // onLaneClose intentionally leaves this to the renderer (see its
          // own header comment: "kept minimal").
          if (lane3.openSay) {
            var closingSay = lane3.openSay;
            RunModel.seal(run, lane3, closingSay); // clears lane3.openSay itself
            finalizeSayBlock(closingSay);
          }
          if (lane3.openThink) {
            var closingThink = lane3.openThink;
            RunModel.seal(run, lane3, closingThink);
            lane3.openThink = null; // seal() only clears lane.openSay — see stream_tool_start's comment
            finalizeThinkBlock(closingThink);
          }
        }
        var agentBlock2 = RunModel.ingest(run, event);
        if (agentBlock2 && agentBlock2.el) finalizeAgentRow(agentBlock2, lane3);
        return;
      }

      case 'stream_fallback': {
        var noteBlock = RunModel.ingest(run, event);
        if (!noteBlock) return;
        var noteOl = laneOl(run, event.lane, els.mainOl);
        noteOl.appendChild(buildNote(noteBlock));
        els.modelEl.textContent = event.from + ' → ' + event.to;
        return;
      }

      case 'stream_error': {
        var errBlock = RunModel.ingest(run, event);
        if (!errBlock) return;
        var errOl = laneOl(run, event.lane, els.mainOl);
        errOl.appendChild(buildNote(errBlock));
        els.root.dataset.status = 'fail';
        return;
      }

      case 'stream_end': {
        // onStreamEnd() seals every lane's open say/think AND clears the
        // lane.openSay/openThink pointers that are the only references to
        // them — capture those references first, or there is no way to find
        // and finalize them (paint markdown, freeze state) afterward. This
        // is the highest-traffic seal path of all: a run's final answer
        // almost always ends here, with no trailing tool call.
        var toFinalize = collectOpenTextBlocks(run);
        var result = RunModel.ingest(run, event);
        for (var fi = 0; fi < toFinalize.say.length; fi++) finalizeSayBlock(toFinalize.say[fi]);
        for (var fj = 0; fj < toFinalize.think.length; fj++) finalizeThinkBlock(toFinalize.think[fj]);
        els.root.dataset.status = run.status;
        renderStreamEnd(view, els, event, result);
        unregisterLiveRun(view);
        return;
      }

      default:
        return; // unknown event type — ignored, matches run-model.js's own dispatcher
    }
  }

  function collectOpenTextBlocks(run) {
    var say = [], think = [];
    run.lanes.forEach(function (lane) {
      if (lane.openSay) say.push(lane.openSay);
      if (lane.openThink) think.push(lane.openThink);
    });
    return { say: say, think: think };
  }

  function agentSpawnIndex(run) {
    var n = 0;
    run.lanes.forEach(function (l) { if (l.id !== 'main') n++; });
    return n; // this lane was just added by laneFor(), so it is already counted
  }

  function upgradeToAgent(block, run, spawnIndex) {
    var oldLi = block.el;
    var parent = oldLi && oldLi.parentNode;
    var newLi = buildAgent(block, run, spawnIndex);
    if (block.toolId) newLi.dataset.toolId = block.toolId;
    if (parent) parent.replaceChild(newLi, oldLi);
    markLive(newLi.querySelector('.gut'), block.startedAt);
  }

  function upgradeToFlatAgentMarker(block, lane) {
    // Rows from a depth-capped lane render flat, each prefixed "↳ agentType",
    // inside the parent's already-nested <ol>. The agent block itself becomes
    // a single marker row (no rail, no tail, no third <ol>) so its later
    // stream_lane_close still has a real element to update.
    if (block.el) {
      var row = block.el.querySelector('.row');
      if (row) {
        var kEl = row.querySelector('.k');
        if (kEl) kEl.textContent = '↳ ' + (block.target || 'agent');
      }
    }
  }

  function updateAgentCounters(run, lane) {
    var agentBlock = lane.agentBlockId ? run.byId.get(lane.agentBlockId) : null;
    if (!agentBlock || !agentBlock.el) return;
    var ctEl = agentBlock.el.querySelector('.ct');
    if (ctEl) {
      ctEl.textContent = lane.toolCount + (lane.toolCount === 1 ? ' tool' : ' tools') +
        (lane.currentTool ? ' · ' + lane.currentTool : '');
    }
    // Ring-buffer tail — exactly SUBAGENT_TAIL_LINES, textContent replaced
    // (never appended), fixed height regardless of run length.
    if (agentBlock._tailLines && lane.currentTool) {
      agentBlock._tailLines.push(lane.currentTool);
      while (agentBlock._tailLines.length > RunModel.SUBAGENT_TAIL_LINES) agentBlock._tailLines.shift();
      if (agentBlock._tailEl) agentBlock._tailEl.textContent = agentBlock._tailLines.join('\n');
    }
  }

  function finalizeAgentRow(block, lane) {
    var li = block.el;
    li.dataset.state = block.state;
    var durEl = li.querySelector('.gut');
    if (durEl) freezeLive(durEl, fmtDuration(block.endedAt - block.startedAt, true));
    var ctEl = li.querySelector('.ct');
    if (ctEl && lane) {
      ctEl.textContent = lane.toolCount + ' steps · ' + fmtDuration(block.endedAt - block.startedAt, false);
    }
    var glyph = li.querySelector('.glyph');
    if (glyph) glyph.textContent = block.state === 'err' ? '✗' : '✓';
  }

  // ===========================================================================
  // Tier 2 render — verdict promotion + trail wrap. Model state (which block
  // is role='verdict') is already decided by RunModel.onStreamEnd(); this is
  // purely the DOM operation. THE VERDICT'S <li> IS NEVER MOVED, NEVER
  // REBUILT, NEVER EVEN QUERIED beyond reading its position — the only
  // mutation on it anywhere in this function is a class list convenience for
  // its own children (signoff lines), which does not change its parent or
  // its index in that parent.
  // ===========================================================================

  function renderStreamEnd(view, els, event, result) {
    var run = view.run;
    var main = run.lanes.get('main');

    // Re-sync data-role for every main-lane say block — promoteVerdict()
    // reassigns role on all of them in one pass, superseding whatever Tier 1
    // had already set live.
    if (main) {
      for (var i = 0; i < main.blocks.length; i++) {
        var b = main.blocks[i];
        if (b.kind === 'say' && b.el) applyRoleClass(b);
      }
    }

    var verdict = result && result.verdictId ? run.byId.get(result.verdictId) : null;
    if (verdict && verdict.el) {
      wrapTrail(els, main, verdict, result.signoffIds || []);
      /*
       * The peek is only useful when the answer it previews is off screen.
       *
       * It was set unconditionally, so a short answer got its first sentence
       * printed in the sticky header and then the whole answer immediately
       * below — which reads as the assistant replying twice. That is exactly
       * what it looked like to the owner, and they were right to call it.
       *
       * So: observe the verdict, and only carry the peek while the verdict is
       * not visible. Sticky context when you have scrolled away, nothing at all
       * when you can already see the thing.
       */
      bindPeek(els, verdict);
    }

    // Footer — "done 4m12s · 18.4k out · $0.62 · model"
    var parts = [];
    parts.push((run.status === 'ok' ? 'done ' : run.status + ' ') + fmtDuration(event.duration, false));
    if (event.outputTokens != null) parts.push(fmtTokens(event.outputTokens) + ' out');
    if (event.cost != null) parts.push('$' + Number(event.cost).toFixed(2));
    parts.push(event.model || run.model || '');
    els.foot.textContent = parts.join(' · ');
    els.foot.hidden = false;

    freezeLive(els.elapsedEl, fmtDuration(event.duration, true));
    if (event.tokensPerSecond) els.burnEl.textContent = event.tokensPerSecond + ' tok/s';
  }

  /*
   * Show the run head's peek line only while the verdict is scrolled out of
   * view. One observer per run, disconnected by destroy() along with the rest.
   */
  function bindPeek(els, verdict) {
    var text = firstSentence(verdict.text, 160);
    if (!text) return;

    if (typeof IntersectionObserver !== 'function') {
      return; // no observer, no peek — better silent than duplicated
    }
    if (els._peekObs) els._peekObs.disconnect();

    els._peekObs = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        els.peekEl.textContent = entries[i].isIntersecting ? '' : text;
      }
    }, { root: null, threshold: 0 });
    els._peekObs.observe(verdict.el);
  }

  function wrapTrail(els, main, verdict, signoffIds) {
    var mainOl = els.mainOl;
    var verdictLi = verdict.el;
    var signoffSet = {};
    for (var i = 0; i < signoffIds.length; i++) signoffSet[signoffIds[i]] = true;

    // Everything strictly before the verdict in array order is "the steps
    // before the answer" (SPEC-v2.md's own trail summary example) — every
    // kind, not just say, which is what makes the summary meaningful.
    var predecessors = [];
    var counts = { read: 0, edit: 0, cmd: 0, err: 0 };
    var verdictIdx = main.blocks.indexOf(verdict);
    for (var j = 0; j < verdictIdx; j++) {
      var pb = main.blocks[j];
      if (!pb.el) continue;
      predecessors.push(pb);
      if (pb.kind2 === 'read') counts.read++;
      else if (pb.kind2 === 'command') counts.cmd++;
      else if (pb.kind2 === 'edit' || pb.kind2 === 'write') counts.edit++;
      if (pb.state === 'err') counts.err++;
    }

    // Trailing signoffs merge into the verdict's own body as status lines and
    // leave the DOM — their text now lives in verdict.signoffs, duplicating
    // the <li> would just repeat it.
    for (var k = verdictIdx + 1; k < main.blocks.length; k++) {
      var tb = main.blocks[k];
      if (signoffSet[tb.id] && tb.el && tb.el.parentNode) tb.el.parentNode.removeChild(tb.el);
    }
    if (verdict.signoffs && verdict.signoffs.length && verdict.bodyEl) {
      var mt = verdict.bodyEl.querySelector('.message-text') || verdict.bodyEl;
      for (var s = 0; s < verdict.signoffs.length; s++) {
        mt.appendChild(el('div', 'signoff', verdict.signoffs[s]));
      }
    }

    if (predecessors.length === 0) return; // nothing to collapse — verdict was the whole run

    var frag = document.createDocumentFragment();
    for (var m = 0; m < predecessors.length; m++) frag.appendChild(predecessors[m].el);

    var trailLi = el('li', 'trail-wrap');
    var details = el('details', 'trail');
    var summary = el('summary', 'mono');
    var summaryParts = [predecessors.length + ' step' + (predecessors.length === 1 ? '' : 's') + ' before the answer'];
    var countBits = [];
    if (counts.read) countBits.push('read ' + counts.read);
    if (counts.edit) countBits.push('edited ' + counts.edit);
    if (counts.cmd) countBits.push('ran ' + counts.cmd);
    if (countBits.length) summaryParts.push(countBits.join(', '));
    if (counts.err) summaryParts.push(counts.err + ' failed');
    summary.textContent = summaryParts.join(' · ');
    details.appendChild(summary);

    var innerOl = el('ol', 'lane');
    innerOl.appendChild(frag);
    details.appendChild(innerOl);
    trailLi.appendChild(details);

    // Outcome-dependent default open state (SPEC-v2.md Tier 2): collapsed on
    // a clean success, expanded whenever there is anything to investigate.
    details.open = !(counts.err === 0 && verdict.el.closest('.run').dataset.status === 'ok');

    // ONE insertion, before the verdict node — the verdict itself is never
    // touched by this function beyond reading verdictIdx above.
    mainOl.insertBefore(trailLi, verdictLi);
  }

  // ===========================================================================
  // mountRun — public entry point for a live run.
  // ===========================================================================

  function mountRun(container, opts) {
    opts = opts || {};
    var ctx = ensureContainer(container);
    var run = RunModel.createRun({
      id: opts.id, sessionId: opts.sessionId, model: opts.model, startedAt: opts.startedAt || Date.now(),
    });
    run._home = opts.home || null;

    var els = buildRunSkeleton(run, opts.prompt);
    container.insertBefore(els.root, ctx.sentinel);

    var dirty = new Set();
    var rafScheduled = false;
    function flush() {
      rafScheduled = false;
      dirty.forEach(flushBlockText);
      dirty.clear();
      maybeAutoFollow(ctx);
    }
    function scheduleFlush() {
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(flush);
    }

    var view = {
      run: run,
      root: els.root,
      ingest: function (event) { ingestEvent(view, els, event, dirty, scheduleFlush); },
      setToolOutput: function (toolId, content) {
        var block = findBlockByToolId(run, toolId);
        if (!block) return;
        block.output = content;
        block.truncated = false;
        if (block.bodyEl) { block.bodyEl.dataset.built = ''; block.bodyEl.innerHTML = ''; buildDetailBody(block.el, block.bodyEl); }
      },
      setShowThinking: function (v) {
        if (v) els.root.setAttribute('data-show-thinking', '1');
        else els.root.removeAttribute('data-show-thinking');
      },
      destroy: function () {
        // The peek observer outlives the run otherwise — one leaked observer
        // per turn, each still holding a reference to that turn's DOM.
        if (els._peekObs) { els._peekObs.disconnect(); els._peekObs = null; }
        unregisterLiveRun(view);
      },
    };

    registerLiveRun(view);
    return view;
  }

  function findBlockByToolId(run, toolId) {
    var found = null;
    run.byId.forEach(function (b) { if (!found && b.toolId === toolId) found = b; });
    return found;
  }

  // ===========================================================================
  // renderSavedRun — U2-PERSIST replay. Converts a persisted blocks[] array
  // (server shape: {k, lane, seq, ...}) into the same synthetic event
  // sequence a live run would have produced, and feeds it through the exact
  // same ingest() pipeline above. "One renderer, two entry points" — this
  // function's entire job is the shape conversion, not a second way to build
  // DOM.
  // ===========================================================================

  function renderSavedRun(container, opts) {
    opts = opts || {};
    var ctx = ensureContainer(container);
    var run = RunModel.createRun({
      id: opts.id, sessionId: opts.sessionId, model: opts.model, startedAt: opts.startedAt || Date.now(),
    });
    run._home = opts.home || null;

    var els = buildRunSkeleton(run, opts.prompt);
    container.insertBefore(els.root, ctx.sentinel);
    freezeLive(els.elapsedEl, fmtDuration(opts.duration, true));

    // ingestEvent() requires a dirty set (it's the live hot-path's contract),
    // but nothing here ever reads it back: every block replayed is sealed by
    // the synthetic stream_end below, and finalize*Block() always repaints
    // from block.text directly — it never depends on prior appendData state,
    // so there is no live-paint step to flush first.
    var dirty = new Set();
    var view = { run: run, root: els.root, ingest: function () {}, setToolOutput: function () {}, setShowThinking: function (v) {
      if (v) els.root.setAttribute('data-show-thinking', '1'); else els.root.removeAttribute('data-show-thinking');
    }, destroy: function () {
      if (els._peekObs) { els._peekObs.disconnect(); els._peekObs = null; }
    } };

    var seq = 0;
    function next() { return ++seq; }

    function replay(list, parentLane) {
      for (var i = 0; i < list.length; i++) {
        var pb = list[i];
        /*
         * Each persisted block carries its OWN lane. Replaying everything as the
         * caller's lane is not a cosmetic slip: an _unattributed block replayed as
         * main finds main's openSay still open and CONCATENATES onto it, so leaked
         * subagent text is glued onto the assistant's prose and can then be
         * promoted as the verdict — the answer the reader is shown.
         * Verified in jsdom before this fix.
         */
        var lane = pb.lane || parentLane;
        if (pb.k === 'say') {
          ingestEvent(view, els, { type: 'stream_text', text: pb.text, lane: lane, seq: next() }, dirty, function () {});
        } else if (pb.k === 'think') {
          ingestEvent(view, els, { type: 'stream_thinking', text: pb.text, lane: lane, seq: next() }, dirty, function () {});
        } else if (pb.k === 'act') {
          ingestEvent(view, els, {
            type: 'stream_tool_start', toolId: pb.toolId, toolName: pb.toolName, toolInput: pb.input,
            kind: pb.kind, lane: lane, seq: next(),
          }, dirty, function () {});
          ingestEvent(view, els, {
            type: 'stream_tool_result', toolId: pb.toolId, content: pb.output, isError: pb.isError,
            truncated: pb.truncated, fullChars: pb.fullChars, lane: lane, seq: next(),
          }, dirty, function () {});
          var actBlock = run.byId.get('blk_' + (seq - 1));
          if (actBlock) freezeLive(actBlock.el.querySelector('.gut'), fmtDuration(pb.ms, true));
        } else if (pb.k === 'agent') {
          ingestEvent(view, els, {
            type: 'stream_tool_start', toolId: pb.laneId, toolName: 'Task',
            toolInput: { subagent_type: pb.agentType, description: pb.label }, kind: 'agent', lane: lane, seq: next(),
          }, dirty, function () {});
          ingestEvent(view, els, {
            type: 'stream_lane_open', laneId: pb.laneId, parentLane: lane, agentType: pb.agentType, label: pb.label, lane: lane, seq: next(),
          }, dirty, function () {});
          replay(pb.blocks || [], pb.laneId);
          ingestEvent(view, els, {
            type: 'stream_lane_close', laneId: pb.laneId, status: pb.status, resultChars: null, lane: lane, seq: next(),
          }, dirty, function () {});
          var agentBlock = findBlockByToolId(run, pb.laneId);
          if (agentBlock && agentBlock.el) freezeLive(agentBlock.el.querySelector('.gut'), fmtDuration(pb.ms, true));
        }
      }
    }

    replay(opts.blocks || [], 'main');

    ingestEvent(view, els, {
      type: 'stream_end', seq: next(), lane: 'main',
      isError: opts.status === 'fail', duration: opts.duration, cost: opts.cost,
      outputTokens: opts.outputTokens, tokensPerSecond: opts.tokensPerSecond, model: opts.model,
    }, dirty, function () {});

    return view;
  }

  // ===========================================================================
  // Exports
  // ===========================================================================

  global.RunRender = {
    mountRun: mountRun,
    renderSavedRun: renderSavedRun,
    // exposed for the /tmp visual harness and for unit-style poking, not part
    // of the API contract the integration agent needs day to day
    _internal: { fmtDuration: fmtDuration, fmtOffset: fmtOffset, firstSentence: firstSentence, splitTargetForDisplay: splitTargetForDisplay },
  };
})(typeof window !== 'undefined' ? window : globalThis);
