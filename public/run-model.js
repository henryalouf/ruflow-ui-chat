// -----------------------------------------------------------------------------
// run-model.js — the Run/Lane/Block state machine, per SPEC-v2.md.
//
// PURE. No DOM, no document, no window, no setTimeout, no fetch. It only ever
// reads and mutates the plain objects it is handed. That is what makes the
// seal rule and the stale-conclusion tiers unit-testable without a browser,
// and it is why the renderer — not this file — owns every `el`/`bodyEl`
// reference, every CSS class, and every scroll/DOM decision.
//
// Implements (per SPEC-v2.md "Block model", "The seal rule",
// "Stale-conclusion mechanism", U3-CORE):
//   - Run / Lane / Block factories with the fields the spec lists
//   - laneFor() — get-or-create, so interleaved lanes never corrupt each
//     other's state (the client-side analogue of the server's
//     messageTextByLane fix)
//   - the seq replay fence: ingest() drops any event where seq <= run.lastSeq
//   - THE SEAL RULE: SEAL_MIN_CHARS=40 seals-or-absorbs on tool start,
//     SEAL_IDLE_MS=4000 seals on text silence, stream_end seals everything
//   - classifyTool() / resolveTarget() with the spec's ordered probe list
//   - Tier 1 (live structural demotion, role='note') and Tier 2 (verdict
//     promotion + substantive/sign-off test, role='verdict'), as MODEL
//     STATE ONLY — no DOM class is ever touched here, the renderer reads
//     block.role and applies colour/opacity or wraps the trail.
//
// Deliberately NOT here (scope note for whoever picks up the rest of
// U3-CORE / U5-VERDICT): summarizeToolGroup()'s "N reads · M edits" text,
// wrapTrail()'s DOM wrapping, and the Tier-3 negative-claim chip. Those were
// named in SPEC-v2.md's U3-CORE description but explicitly excluded from
// this task's brief, which scoped U3-CORE down to structures + seal rule +
// classify/resolveTarget + Tier 1/2 roles only. Run.counts and Block.target
// are already shaped so a group-summary function can be added later without
// touching anything in this file.
// -----------------------------------------------------------------------------

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Named constants — kept here per SPEC-v2.md's "Performance plan" section,
  // which states plainly that all of these live in run-model.js. Not every one
  // is consumed by the logic below (TOOL_OUTPUT_RENDER_CHARS, GROUP_MIN_ACTS,
  // LIVE_ACTS_PER_LANE and SUBAGENT_TAIL_LINES are rendering-time decisions),
  // but this is their one source of truth so nobody hardcodes a second copy.
  // ---------------------------------------------------------------------------

  var SEAL_MIN_CHARS = 40;
  var SEAL_IDLE_MS = 4000;
  var LIVE_ACTS_PER_LANE = 60;       // older act rows fold into the group summary
  var TOOL_OUTPUT_RENDER_CHARS = 20000; // beyond this, renderer offers fetch_tool_output
  var SUBAGENT_TAIL_LINES = 3;
  var GROUP_MIN_ACTS = 6;
  var LANE_DEPTH_CAP = 2;

  // ---------------------------------------------------------------------------
  // classifyTool() — tool name -> kind2, the fine-grained classification used
  // for Run.counts, group-summary buckets, and U9's graphify trigger
  // (kind2 in {edit, write}). Deliberately a small closed map: an unknown
  // or MCP tool degrades to 'other' rather than guessing.
  // ---------------------------------------------------------------------------

  var TOOL_KIND_MAP = {
    Read: 'read',
    NotebookRead: 'read',
    Grep: 'search',
    Glob: 'search',
    WebSearch: 'search',
    WebFetch: 'fetch',
    Write: 'write',
    Edit: 'edit',
    MultiEdit: 'edit',
    NotebookEdit: 'edit',
    Bash: 'command',
    BashOutput: 'command',
    KillShell: 'command',
    Task: 'agent',
    Agent: 'agent',
  };

  function classifyTool(toolName) {
    if (!toolName) return 'other';
    // mcp__server__toolName -> toolName, matching the strip already used
    // for display elsewhere in this codebase (public/app.js getToolSummary).
    var bare = toolName.replace(/^mcp__.*__/, '');
    return TOOL_KIND_MAP[bare] || 'other';
  }

  // ---------------------------------------------------------------------------
  // resolveTarget() — the ordered probe list from SPEC-v2.md U3-CORE:
  //   command, file_path, path, pattern, url, query, description, name
  // First non-empty string field wins. `home`, if supplied, is stripped as a
  // path PREFIX and replaced with '~' (never a global string replace — a
  // command that merely mentions the home dir mid-sentence must not be
  // mangled). No default is baked in here: an environment-specific path has
  // no place in a generic, testable module, so callers that want tilde
  // collapsing pass their own home directory.
  // ---------------------------------------------------------------------------

  var TARGET_PROBE_ORDER = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'name'];

  function tildeHome(str, home) {
    if (!home || typeof str !== 'string' || str.indexOf(home) !== 0) return str;
    return '~' + str.slice(home.length);
  }

  function resolveTarget(toolName, input, home) {
    if (!input || typeof input !== 'object') return '';
    for (var i = 0; i < TARGET_PROBE_ORDER.length; i++) {
      var value = input[TARGET_PROBE_ORDER[i]];
      if (typeof value === 'string' && value.length > 0) return tildeHome(value, home);
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  function createRun(opts) {
    opts = opts || {};
    return {
      id: opts.id || null,
      sessionId: opts.sessionId || null,
      startedAt: opts.startedAt || Date.now(),
      model: opts.model || null,
      status: 'live', // 'live' | 'ok' | 'fail' | 'cancel'
      lanes: new Map(),
      byId: new Map(),
      lastSeq: 0,
      counts: { read: 0, edit: new Set(), cmd: 0, err: 0 },
    };
  }

  // laneFor() — get-or-create. Lanes come into existence the moment any event
  // references their id, whether that's stream_lane_open naming one explicitly
  // or a stray stream_text/stream_tool_start arriving for a lane we haven't
  // been told about yet (out-of-order delivery). Either way this is the ONE
  // place a Lane object is minted, so 'main' and every subagent lane share
  // identical shape and initial state.
  function laneFor(run, laneId, meta) {
    meta = meta || {};
    var id = laneId || 'main';
    var lane = run.lanes.get(id);
    if (lane) {
      // Backfill metadata that stream_lane_open supplies but that an earlier,
      // out-of-order event couldn't have known yet.
      if (meta.agentType && !lane.agentType) lane.agentType = meta.agentType;
      if (meta.label && !lane.label) lane.label = meta.label;
      return lane;
    }
    var parentLane = meta.parentLane != null ? meta.parentLane : (id === 'main' ? null : 'main');
    var parent = id === 'main' ? null : run.lanes.get(parentLane);
    lane = {
      id: id,
      parentLane: parentLane,
      agentType: meta.agentType || null,
      label: meta.label || null,
      depth: meta.depth != null ? meta.depth : (id === 'main' ? 0 : (parent ? parent.depth + 1 : 1)),
      status: 'live',
      blocks: [],
      openSay: null,
      openThink: null,      // mirrors openSay for kind:'think'; not a spec-literal field
                             // (spec lists only openSay on Lane), added because 'think'
                             // needs the same open-accumulator slot to be functional.
      byToolId: new Map(),
      tail: [],              // ring buffer of the subagent's last SUBAGENT_TAIL_LINES lines;
                              // populated by the renderer (U6), left empty here
      startedAt: Date.now(),
      toolCount: 0,
      currentTool: null,
    };
    run.lanes.set(id, lane);
    return lane;
  }

  var LANE_UNATTRIBUTED = '_unattributed';

  function createBlock(run, lane, kind, seq) {
    var block = {
      id: 'blk_' + seq,   // seq is unique and monotonic per run (event contract),
                           // so it doubles as a deterministic block id with no
                           // separate counter to keep in sync
      kind: kind,          // 'say' | 'think' | 'act' | 'agent' | 'note'
      lane: lane.id,
      seq: seq,
      el: null,             // renderer-owned DOM ref; this module never reads it
      bodyEl: null,          // renderer-owned DOM ref; this module never reads it
      text: '',
      sealed: false,
      state: 'live',        // 'live' | 'ok' | 'err'
      role: null,            // null | 'verdict' | 'note' — 'say' blocks only
      toolId: null,
      toolName: null,
      kind2: null,
      target: null,
      caption: null,
      output: null,
      truncated: false,
      startedAt: Date.now(),
      endedAt: null,
      negClaims: [],          // Tier 3 field, always empty: the scan that
                               // populates it is out of this file's scope
      lastDeltaAt: Date.now(), // internal bookkeeping for SEAL_IDLE_MS; not a
                                // spec-literal field, required to know when a
                                // 'say' or 'think' block has gone quiet
    };
    lane.blocks.push(block);
    run.byId.set(block.id, block);
    return block;
  }

  // ---------------------------------------------------------------------------
  // THE SEAL RULE
  //
  // seal() closes a block (say/think, most commonly). It never assigns a role
  // by itself — Tier 1 demotion is a separate, explicit step (see
  // demoteIfFollowedByWork) fired only from the tool-start path, never from an
  // idle-timeout or stream_end seal. A block that went quiet on its own might
  // still turn out to be the run's actual conclusion; only proven-followed-by-
  // more-work blocks get greyed out live.
  // ---------------------------------------------------------------------------

  function seal(run, lane, block) {
    if (block.sealed) return block; // idempotent — stream_end seals "all lanes"
                                     // even for blocks a tool-start already sealed
    block.sealed = true;
    block.state = 'ok';
    block.endedAt = Date.now();
    if (lane.openSay === block) lane.openSay = null;
    return block;
  }

  // absorbAsCaption() — pure text extraction; the caller is responsible for
  // popping the block out of lane.blocks and run.byId. Named to match the
  // spec's pseudocode so the two are easy to read side by side.
  function absorbAsCaption(sayBlock) {
    var trimmed = sayBlock.text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // Tier 1 — live structural demotion. "A say block followed by more work is,
  // by the model's own behaviour, not a conclusion." Only the most recent say
  // block in the lane is ever a live candidate; anything role has already been
  // decided for (by an earlier call to this, or later by promoteVerdict) is
  // left alone.
  function demoteIfFollowedByWork(lane) {
    for (var i = lane.blocks.length - 1; i >= 0; i--) {
      var b = lane.blocks[i];
      if (b.kind !== 'say') continue;
      if (b.sealed && b.role === null) b.role = 'note';
      break;
    }
  }

  // onToolStart() — the whole fix, verbatim from SPEC-v2.md's pseudocode,
  // adapted only to take an explicit `run` (this module holds no implicit
  // per-run closure state; a page may have more than one Run in memory, e.g.
  // while scrolling reloaded history).
  function onToolStart(run, event) {
    var lane = laneFor(run, event.lane);
    var openSay = lane.openSay;
    var caption = null;

    if (openSay) {
      var trimmed = openSay.text.trim();
      if (trimmed.length >= SEAL_MIN_CHARS) {
        seal(run, lane, openSay); // -> its own block; next delta opens a new one
      } else {
        caption = absorbAsCaption(openSay); // short preamble becomes the tool row's caption
        lane.blocks.pop();                  // openSay is always the tail of lane.blocks
        run.byId.delete(openSay.id);
        lane.openSay = null;
      }
    }

    // Tier 1 fires here: covers the block just sealed above, AND any earlier
    // idle-sealed block this lane hadn't yet learned was followed by work.
    demoteIfFollowedByWork(lane);

    var block = createBlock(run, lane, 'act', event.seq);
    block.toolId = event.toolId;
    block.toolName = event.toolName;
    // Trust the server's classification when the wire already carries one
    // (U1-WIRE's classifyTool()); fall back to our own for older persisted
    // sessions or a defensive re-derive.
    block.kind2 = event.kind || classifyTool(event.toolName);
    block.target = resolveTarget(event.toolName, event.toolInput);
    if (caption) block.caption = caption;

    lane.byToolId.set(event.toolId, block);
    lane.toolCount++;
    lane.currentTool = event.toolName;
    return block;
  }

  function onToolResult(run, event) {
    var lane = laneFor(run, event.lane);
    var block = lane.byToolId.get(event.toolId);
    if (!block) return null; // result for a tool call we never saw start — drop it,
                              // never fabricate a row for it

    block.state = event.isError ? 'err' : 'ok';
    block.output = event.content;
    block.truncated = !!event.truncated;
    block.sealed = true;
    block.endedAt = Date.now();

    if (block.state === 'err') run.counts.err++;
    if (block.kind2 === 'read') run.counts.read++;
    else if (block.kind2 === 'command') run.counts.cmd++;
    else if ((block.kind2 === 'edit' || block.kind2 === 'write') && block.target) run.counts.edit.add(block.target);

    if (lane.currentTool === block.toolName) lane.currentTool = null;
    return block;
  }

  function onText(run, event) {
    var lane = laneFor(run, event.lane);
    var block = lane.openSay;
    if (!block) {
      block = createBlock(run, lane, 'say', event.seq);
      lane.openSay = block;
    }
    block.text += event.text;
    block.lastDeltaAt = Date.now();
    return block;
  }

  function onThinking(run, event) {
    var lane = laneFor(run, event.lane);
    var block = lane.openThink;
    if (!block) {
      block = createBlock(run, lane, 'think', event.seq);
      lane.openThink = block;
    }
    block.text += event.text;
    block.lastDeltaAt = Date.now();
    return block;
  }

  // sealIdleSays() — the 4s-text-silence half of the seal rule. Not a timer:
  // this module owns no setTimeout. The renderer's shared ticker calls this
  // on every tick with `now`; nothing else drives it. Deliberately does NOT
  // call demoteIfFollowedByWork — going quiet is not evidence more work
  // follows, only a subsequent tool start is.
  function sealIdleSays(run, now) {
    now = now || Date.now();
    var sealed = [];
    run.lanes.forEach(function (lane) {
      var s = lane.openSay;
      if (s && !s.sealed && (now - s.lastDeltaAt) >= SEAL_IDLE_MS) {
        seal(run, lane, s);
        sealed.push(s);
      }
    });
    return sealed;
  }

  // ---------------------------------------------------------------------------
  // Subagent lanes (stream_lane_open / stream_lane_close) — kept minimal.
  // Full behaviour (ring-buffer tail, round-robin hues, the depth-cap
  // flattening render policy) is U6-SUBAGENT's job; what's here is only
  // enough structural plumbing that ingest() has somewhere real to route
  // lane-scoped events, which "interleaved lanes" below depends on.
  // ---------------------------------------------------------------------------

  function onLaneOpen(run, event) {
    var parentId = event.parentLane || 'main';
    var parent = laneFor(run, parentId);
    var lane = laneFor(run, event.laneId, {
      parentLane: parentId,
      agentType: event.agentType,
      label: event.label,
      depth: parent.depth + 1,
    });

    // Ordering guarantee (SPEC-v2.md): stream_tool_start for the Task always
    // precedes stream_lane_open, and laneId === that same tool_use's toolId.
    // onToolStart already built a generic 'act' row for it in the parent
    // lane — upgrade that row to kind:'agent' in place rather than minting a
    // second, duplicate block for the same call.
    var block = parent.byToolId.get(event.laneId);
    if (!block) block = createBlock(run, parent, 'agent', event.seq); // defensive: lane_open with no preceding tool_start
    block.kind = 'agent';
    block.target = event.agentType || lane.agentType || null;
    block.caption = event.label || lane.label || null;
    lane.agentBlockId = block.id; // not a spec-literal Lane field; lets
                                   // onLaneClose find its own card back
    return block;
  }

  function onLaneClose(run, event) {
    var lane = run.lanes.get(event.laneId);
    if (!lane) return null;
    lane.status = event.status || 'ok';
    var block = lane.agentBlockId ? run.byId.get(lane.agentBlockId) : null;
    if (block) {
      block.state = event.status === 'error' ? 'err' : 'ok';
      block.sealed = true;
      block.endedAt = Date.now();
      if (event.resultChars != null) block.output = event.resultChars + ' chars';
    }
    return block;
  }

  function onFallback(run, event) {
    var lane = laneFor(run, event.lane);
    var block = createBlock(run, lane, 'note', event.seq);
    block.text = 'requested ' + event.from + ' → served ' + event.to + (event.reason ? ' (' + event.reason + ')' : '');
    block.sealed = true;
    block.state = 'ok';
    return block;
  }

  function onError(run, event) {
    var lane = laneFor(run, event.lane);
    var block = createBlock(run, lane, 'note', event.seq);
    block.text = event.error || 'error';
    block.sealed = true;
    block.state = 'err';
    run.status = 'fail';
    return block;
  }

  function onStreamStart(run, event) {
    run.sessionId = event.sessionId || run.sessionId;
    run.model = event.model || run.model;
    return run;
  }

  // ---------------------------------------------------------------------------
  // Tier 2 — verdict promotion. MODEL STATE ONLY: this decides which block
  // is role='verdict' and which are role='note'. It never touches a DOM node
  // and never moves anything in lane.blocks — "wrap predecessors into
  // <details>" is a render-time operation on top of this decision, not part
  // of it.
  // ---------------------------------------------------------------------------

  var LIST_RE = /(^|\n)[ \t]{0,3}([-*+]|\d+[.)])[ \t]+/;
  var HEADING_RE = /(^|\n)[ \t]{0,3}#{1,6}[ \t]/;
  var TABLE_RE = /\|.*\|/;
  var FENCE_RE = /```/;

  /*
   * A sign-off is a contentless closing remark — "Done.", "Pushed to main."
   * Anything else is a candidate verdict.
   *
   * The threshold was 120 characters, which swallowed real answers. A one-line
   * reply like "Found it at public/app.js:112 — escapeAttr wraps escapeHtml and
   * additionally encodes the double quote." is 101 characters and IS the answer,
   * but it was classified as a sign-off, demoted to a note, and nothing was
   * promoted in its place — leaving the reader with no bright text at all. That
   * is the failure this whole rebuild exists to prevent, arrived at from the
   * other direction.
   *
   * 60 is deliberately below SEAL_MIN_CHARS's neighbourhood: a genuine sign-off
   * is a handful of words. Anything longer is carrying information.
   */
  var SIGNOFF_MAX_CHARS = 60;

  function isSubstantive(text) {
    var trimmed = (text || '').trim();
    if (!trimmed) return false; // nothing to promote
    var singleLine = trimmed.indexOf('\n') === -1;
    var short = trimmed.length <= SIGNOFF_MAX_CHARS;
    var structural = FENCE_RE.test(trimmed) || LIST_RE.test(trimmed) || HEADING_RE.test(trimmed) || TABLE_RE.test(trimmed);
    var signoffShaped = singleLine && short && !structural;
    return !signoffShaped;
  }

  // promoteVerdict() — walk the MAIN lane backwards for the last substantive
  // say; that one becomes role='verdict' in place (never moved). Every other
  // 'say' block in the lane becomes role='note', including the ones this
  // walk skipped over as non-substantive trailing sign-offs ("Done.",
  // "Pushed to main.") — those additionally get their text collected onto
  // verdict.signoffs so the renderer can print the ".signoff status line"
  // without re-running the substantive test itself.
  function promoteVerdict(run) {
    var main = run.lanes.get('main');
    if (!main) return { verdictId: null, signoffIds: [] };

    var verdict = null;
    var signoffIds = [];
    var lastSay = null;
    for (var i = main.blocks.length - 1; i >= 0; i--) {
      var b = main.blocks[i];
      if (b.kind !== 'say') continue;
      if (!lastSay) lastSay = b;
      if (isSubstantive(b.text)) { verdict = b; break; }
      signoffIds.push(b.id);
    }
    signoffIds.reverse(); // walked backward; renderer wants reading order

    /*
     * Fallback: if every say in the run reads as a sign-off, promote the last one
     * anyway. A turn whose blocks are all short is still a turn with an answer in
     * it, and leaving nothing bright is strictly worse than promoting something
     * slightly too small — the reader would otherwise be handed a page of
     * uniformly grey text with no landing point.
     */
    if (!verdict && lastSay) {
      verdict = lastSay;
      var idx = signoffIds.indexOf(lastSay.id);
      if (idx !== -1) signoffIds.splice(idx, 1);
    }

    for (var j = 0; j < main.blocks.length; j++) {
      var sb = main.blocks[j];
      if (sb.kind !== 'say') continue;
      sb.role = (sb === verdict) ? 'verdict' : 'note';
    }

    if (verdict && signoffIds.length) {
      verdict.signoffs = signoffIds.map(function (id) { return run.byId.get(id).text.trim(); });
    }

    return { verdictId: verdict ? verdict.id : null, signoffIds: signoffIds };
  }

  function onStreamEnd(run, event) {
    // seal() fires on stream_end "all lanes" — a run that ends mid-sentence
    // still needs its final fragment sealed and readable.
    run.lanes.forEach(function (lane) {
      if (lane.openSay) seal(run, lane, lane.openSay);
      if (lane.openThink) {
        lane.openThink.sealed = true;
        lane.openThink.state = 'ok';
        lane.openThink.endedAt = Date.now();
        lane.openThink = null;
      }
    });
    run.status = event.isError ? 'fail' : 'ok';
    return promoteVerdict(run);
  }

  // ---------------------------------------------------------------------------
  // ingest() — the single dispatcher. Every event passes through the seq
  // fence before anything else touches run state: "Client drops any event
  // where seq <= run.lastSeq" (SPEC-v2.md, Event contract / Envelope). This
  // is the replay fence — without it, a reconnect/history replay can regress
  // an already-finished block back to live, or double-count a tool result.
  // ---------------------------------------------------------------------------

  function ingest(run, event) {
    if (!event || typeof event.seq !== 'number') return null;
    if (event.seq <= run.lastSeq) return null; // dropped: replay or duplicate
    run.lastSeq = event.seq;

    switch (event.type) {
      case 'stream_start': return onStreamStart(run, event);
      case 'stream_lifecycle': return null; // pure liveness signal; nothing to hold
      case 'stream_text': return onText(run, event);
      case 'stream_thinking': return onThinking(run, event);
      case 'stream_tool_progress': return null; // partial-input display is a U4 concern
      case 'stream_tool_start': return onToolStart(run, event);
      case 'stream_tool_result': return onToolResult(run, event);
      case 'stream_lane_open': return onLaneOpen(run, event);
      case 'stream_lane_close': return onLaneClose(run, event);
      case 'stream_fallback': return onFallback(run, event);
      case 'stream_error': return onError(run, event);
      case 'stream_end': return onStreamEnd(run, event);
      default: return null; // unknown event type — ignored, not an error
    }
  }

  // ---------------------------------------------------------------------------
  // Exports — one namespace, so a plain <script> tag adds exactly one global.
  // ---------------------------------------------------------------------------

  var RunModel = {
    // constants
    SEAL_MIN_CHARS: SEAL_MIN_CHARS,
    SEAL_IDLE_MS: SEAL_IDLE_MS,
    LIVE_ACTS_PER_LANE: LIVE_ACTS_PER_LANE,
    TOOL_OUTPUT_RENDER_CHARS: TOOL_OUTPUT_RENDER_CHARS,
    SUBAGENT_TAIL_LINES: SUBAGENT_TAIL_LINES,
    GROUP_MIN_ACTS: GROUP_MIN_ACTS,
    LANE_DEPTH_CAP: LANE_DEPTH_CAP,
    LANE_UNATTRIBUTED: LANE_UNATTRIBUTED,

    // factories
    createRun: createRun,
    laneFor: laneFor,

    // dispatcher
    ingest: ingest,

    // individual event handlers — exported for direct testing and for a
    // renderer that wants to call them without building a synthetic envelope
    onStreamStart: onStreamStart,
    onText: onText,
    onThinking: onThinking,
    onToolStart: onToolStart,
    onToolResult: onToolResult,
    onLaneOpen: onLaneOpen,
    onLaneClose: onLaneClose,
    onFallback: onFallback,
    onError: onError,
    onStreamEnd: onStreamEnd,

    // seal rule
    seal: seal,
    absorbAsCaption: absorbAsCaption,
    sealIdleSays: sealIdleSays,

    // tool classification
    classifyTool: classifyTool,
    resolveTarget: resolveTarget,

    // stale-conclusion mechanism (model state)
    isSubstantive: isSubstantive,
    promoteVerdict: promoteVerdict,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RunModel;
  } else {
    global.RunModel = RunModel;
  }
})(typeof window !== 'undefined' ? window : globalThis);
