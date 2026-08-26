'use strict';

/*
 * Stream event processing — extracted from server.js's processStreamEvent.
 *
 * Two exports do the real work:
 *
 *   createEmitStream({ send })   — the envelope. Stamps runId/seq/lane on every
 *                                  server->client stream event, in one place, per
 *                                  the spec's "Event contract > Envelope" section.
 *                                  No timers, no socket — just a counter, so it is
 *                                  directly unit-testable.
 *
 *   createStreamEventProcessor() — a pure factory (SPEC-v2.md, U1-WIRE). Everything
 *                                  side-effecting (saveSession, memory sync, the
 *                                  broadcast) is injected, not imported, so a test
 *                                  can feed it a recorded stream-json fixture and
 *                                  assert on calls without a real WebSocket, a real
 *                                  session file, or a real Claude process.
 *
 * server.js is the only caller. It supplies the real `send`, the real session, and
 * wraps the returned emitStream with the per-lane text-coalescing timer (which
 * needs setTimeout + ws.bufferedAmount, i.e. things this file deliberately does not
 * touch — see U8-PERF's server half, done in server.js around this module).
 */

const { v4: uuidv4 } = require('uuid');

// Named per the spec's "Named constants" list (SEAL_MIN_CHARS etc. are the client's
// run-model.js constants and do not belong here — these two are the server's half).
const TOOL_OUTPUT_WIRE_CHARS = 120_000; // sent over the wire, live
const TOOL_OUTPUT_DISK_CHARS = 32_000;  // written into the session file

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Every server->client stream event gains runId/seq/lane in this one place.
 * runId is minted once, at spawn (when this is created); seq is monotonic
 * starting at 1; lane defaults to 'main' when the caller didn't set one.
 */
function createEmitStream({ send }) {
  const runId = uuidv4();
  let seq = 0;

  function emitStream(o) {
    o.runId = runId;
    o.seq = ++seq;
    if (!o.lane) o.lane = 'main';
    send(o);
    return o; // callers capture the stamped seq to timestamp a persisted block
  }

  return { emitStream, runId };
}

// ---------------------------------------------------------------------------
// Tool classification — feeds the `kind` field on stream_tool_start and the
// persisted act block. Deliberately name-only: resolveTarget() (deriving a
// display target from toolInput) is a client-side, DOM-adjacent concern in
// run-model.js and has no reason to be duplicated here.
// ---------------------------------------------------------------------------

const TOOL_KIND = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'command',
  BashOutput: 'command',
  KillBash: 'command',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent',
  TodoWrite: 'todo',
};

/*
 * Which tool name means "this spawned a subagent".
 *
 * It was a bare `toolName === 'Task'` comparison. CLI 2.1.226 called it Task;
 * 2.1.227 calls it Agent, and the box moved to .227 between the spec being
 * written and the build landing. The gate stopped matching, so no lane ever
 * opened: no rail, no tail, no nested lane, and the Agent result fell through
 * to the generic renderer, which printed the raw content-block array including
 * agentId and SendMessage plumbing into the transcript.
 *
 * A set rather than another literal, because this name has now changed once and
 * the failure is silent when it changes again — nothing errors, the feature
 * just quietly is not there.
 */
const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);
function isSubagentTool(name) {
  return SUBAGENT_TOOL_NAMES.has(name);
}

function classifyTool(toolName) {
  return TOOL_KIND[toolName] || 'other';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cap a string, reporting whether it was cut and how long it really was. */
function capChars(str, max) {
  str = str || '';
  if (str.length <= max) return { text: str, truncated: false, fullChars: str.length };
  return { text: str.slice(0, max), truncated: true, fullChars: str.length };
}

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {function} opts.emitStream   - stamped envelope sender (see createEmitStream)
 * @param {object}   opts.session      - mutated in place (cliSessionId, messages)
 * @param {string}   opts.userText     - the prompt this run answers, for persistence
 * @param {boolean}  opts.isSystemRequest - housekeeping turn (title generation and
 *   the like). Runs normally but is never written to the session, so it does not
 *   appear in the transcript, inflate the message count, or reach the second brain.
 * @param {string}   opts.model        - requested model string (for stream_fallback)
 * @param {function} opts.saveSession
 * @param {function} opts.autoExtractMemory     - (userText, assistantText, sessionName)
 * @param {function} opts.syncSessionToVectorDb  - (session) => Promise
 * @param {function} opts.broadcastSessionUpdate - () => void
 * @param {function} opts.generateFollowUps      - (text, toolBlocks) => string[]
 * @param {boolean}  [opts.subagentDeltasOn=true] - SUBAGENT_DELTAS escape hatch
 *   (SPEC-v2.md "Verification step before default-on"). When false, text/thinking
 *   deltas are suppressed entirely while any lane is open — the stream_event
 *   envelope's parent_tool_use_id is unverified on this CLI build, so a delta
 *   can't be safely attributed to a lane; the complete `assistant` block (which
 *   is verified to carry it) is used instead. Slightly less live, never wrong.
 */
function createStreamEventProcessor(opts) {
  const {
    emitStream,
    session,
    userText,
    isSystemRequest = false,
    model,
    saveSession,
    autoExtractMemory,
    syncSessionToVectorDb,
    broadcastSessionUpdate,
    generateFollowUps,
    subagentDeltasOn = true,
  } = opts;

  // Legacy state — kept byte-for-byte equivalent to the pre-extraction behavior
  // for the main lane, because old sessions and existing renderers depend on it.
  let accumulatedText = '';
  let toolBlocks = [];
  let costInfo = null;
  let messagesSaved = false;

  /*
   * currentMessageText was a single variable feeding a startsWith dedupe against
   * the complete `assistant` text block, to avoid re-sending what the delta path
   * already delivered. With lanes, one variable is wrong: a subagent's deltas and
   * the main lane's deltas can now interleave on the wire, and a single dedupe
   * string would compare a lane B block's full text against lane A's accumulated
   * prefix, corrupting both (duplicating or swallowing text on whichever lane
   * loses the race). This MUST land together with lane routing — see report.
   */
  const messageTextByLane = new Map();
  const thinkingTextByLane = new Map(); // same dedupe, for `thinking` blocks

  // laneId (a Task tool_use id) -> { parentLane, agentType, label, startedAt, block }
  const openLanes = new Map();

  // Per-lane block currently accumulating text — closed (not sealed; sealing with
  // SEAL_MIN_CHARS/absorb-as-caption is a run-model.js/client rendering decision,
  // not reproduced here) the instant a tool starts in that lane.
  const openSayBlock = new Map();
  const openThinkBlock = new Map();

  // toolId -> the act/agent block awaiting its tool_result.
  const openActBlock = new Map();

  // `${lane}:${index}` -> { toolId, toolName, partial } for input_json_delta
  // accumulation. Keyed by lane as well as index because a subagent's own
  // content-block indices are not guaranteed to avoid the main stream's.
  const toolProgressByIndex = new Map();

  // toolId -> full tool_result content, for the fetch_tool_output handler.
  const toolOutputMap = new Map();

  // Ordered, in emission order — U2-PERSIST. Only 'main' and '_unattributed'
  // blocks live at the top level; a lane's own blocks live in the SAME array
  // object as its agent block's `.blocks` (laneBuffers below), so nesting of
  // arbitrary depth falls out for free with no explicit "attach at close" step.
  const blocks = [];
  const laneBuffers = new Map(); // laneId -> nested blocks[] (shared ref with the agent block)

  function laneBlockList(lane) {
    if (lane === 'main' || lane === '_unattributed') return blocks;
    let list = laneBuffers.get(lane);
    if (!list) { list = []; laneBuffers.set(lane, list); }
    return list;
  }

  function appendSay(lane, text, wireSeq) {
    let block = openSayBlock.get(lane);
    if (!block) {
      block = { k: 'say', lane, seq: wireSeq, text: '' };
      laneBlockList(lane).push(block);
      openSayBlock.set(lane, block);
    }
    block.text += text;
  }

  function appendThink(lane, text, wireSeq) {
    let block = openThinkBlock.get(lane);
    if (!block) {
      block = { k: 'think', lane, seq: wireSeq, text: '' };
      laneBlockList(lane).push(block);
      openThinkBlock.set(lane, block);
    }
    block.text += text;
  }

  function processStreamEvent(event) {
    if (!event || !event.type) return;

    // Lane derivation — SPEC-v2.md "Lane derivation", one line, computed once
    // per event, ahead of everything else.
    const lane = event.parent_tool_use_id || (openLanes.size > 0 ? '_unattributed' : 'main');

    // System init — capture CLI session ID.
    if (event.type === 'system' && event.subtype === 'init') {
      if (event.session_id) {
        session.cliSessionId = event.session_id;
        saveSession(session);
      }
      emitStream({ type: 'stream_lifecycle', phase: 'session_ready' });
      return;
    }

    // Assistant message (potentially partial with --include-partial-messages)
    const assistantContent = event.type === 'assistant'
      ? (event.message?.content || event.content)
      : null;
    if (event.type === 'assistant' && Array.isArray(assistantContent)) {
      for (const block of assistantContent) {
        if (block.type === 'text') {
          const fullText = block.text || '';
          if (!fullText) continue;

          const seen = messageTextByLane.get(lane) || '';
          let remainder;
          if (seen && fullText.startsWith(seen)) {
            remainder = fullText.slice(seen.length);
            messageTextByLane.set(lane, fullText);
          } else {
            // No deltas covered this block (partial messages off, or a second
            // text block in the same message).
            remainder = fullText;
            messageTextByLane.set(lane, seen + fullText);
          }
          if (remainder) {
            if (lane === 'main') accumulatedText += remainder;
            const wire = emitStream({ type: 'stream_text', text: remainder, lane });
            appendSay(lane, remainder, wire.seq);
          }
        } else if (block.type === 'thinking') {
          const fullText = block.thinking || '';
          if (!fullText) continue;

          const seen = thinkingTextByLane.get(lane) || '';
          let remainder;
          if (seen && fullText.startsWith(seen)) {
            remainder = fullText.slice(seen.length);
            thinkingTextByLane.set(lane, fullText);
          } else {
            remainder = fullText;
            thinkingTextByLane.set(lane, seen + fullText);
          }
          // Thinking never enters accumulatedText — it is not part of the
          // persisted main transcript, only of the ordered blocks[] record.
          if (remainder) {
            const wire = emitStream({ type: 'stream_thinking', text: remainder, lane });
            appendThink(lane, remainder, wire.seq);
          }
        } else if (block.type === 'tool_use') {
          // A tool starting ends whatever prose/thinking was open in this lane —
          // the structural half of the seal rule. (The SEAL_MIN_CHARS /
          // absorb-as-caption decision is rendering, not recorded here.)
          openSayBlock.delete(lane);
          openThinkBlock.delete(lane);

          const toolId = block.id || uuidv4();
          const toolName = block.name;
          const kind = classifyTool(toolName);
          const startWire = emitStream({
            type: 'stream_tool_start', toolId, toolName, toolInput: block.input, kind, lane,
          });

          if (isSubagentTool(toolName)) {
            const agentType = block.input?.subagent_type || null;
            const label = block.input?.description || null;
            const agentBlock = {
              k: 'agent', lane, seq: startWire.seq,
              laneId: toolId, agentType, label,
              status: 'live', ms: null,
              blocks: [],
            };
            laneBlockList(lane).push(agentBlock);
            // Same array reference as agentBlock.blocks — pushes to this lane's
            // buffer land directly inside the persisted agent block, at any depth.
            laneBuffers.set(toolId, agentBlock.blocks);
            openActBlock.set(toolId, agentBlock);
            openLanes.set(toolId, { parentLane: lane, agentType, label, startedAt: Date.now(), block: agentBlock });

            // Ordering guarantee: stream_tool_start (above) always precedes
            // stream_lane_open.
            emitStream({ type: 'stream_lane_open', laneId: toolId, parentLane: lane, agentType, label, lane });
          } else {
            const actBlock = {
              k: 'act', lane, seq: startWire.seq,
              toolId, toolName, kind, input: block.input,
              output: null, isError: false, truncated: false, fullChars: 0,
              ms: null, startedAt: Date.now(),
            };
            laneBlockList(lane).push(actBlock);
            openActBlock.set(toolId, actBlock);
          }

          // Legacy flat bag, main lane only. Subagent-internal tool calls are
          // new information that only existed once --forward-subagent-text was
          // added; flattening them in here would feed an unlaned wall of tool
          // calls to every renderer that still reads toolBlocks directly.
          if (lane === 'main') {
            toolBlocks.push({ toolId, toolName, toolInput: block.input, toolOutput: null, isError: false });
          }
        }
      }
      // This assistant message is complete. The next one starts its own delta
      // run for THIS lane only — other lanes' dedupe state is untouched.
      messageTextByLane.set(lane, '');
      thinkingTextByLane.set(lane, '');
      return;
    }

    // User message containing tool results
    const userContent = event.type === 'user'
      ? (event.message?.content || event.content)
      : null;
    if (event.type === 'user' && Array.isArray(userContent)) {
      for (const block of userContent) {
        if (block.type !== 'tool_result') continue;

        const toolId = block.tool_use_id;
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        const isError = !!block.is_error;

        toolOutputMap.set(toolId, content);

        if (openLanes.has(toolId)) {
          // Ordering guarantee: stream_lane_close before the Task's stream_tool_result.
          const laneInfo = openLanes.get(toolId);
          const status = isError ? 'error' : 'ok';
          emitStream({ type: 'stream_lane_close', laneId: toolId, status, resultChars: content.length, lane });
          laneInfo.block.status = status;
          laneInfo.block.ms = Date.now() - laneInfo.startedAt;
          openLanes.delete(toolId);
          openActBlock.delete(toolId);
        } else {
          const actBlock = openActBlock.get(toolId);
          if (actBlock) {
            const disk = capChars(content, TOOL_OUTPUT_DISK_CHARS);
            actBlock.output = disk.text;
            actBlock.truncated = disk.truncated;
            actBlock.fullChars = disk.fullChars;
            actBlock.isError = isError;
            actBlock.ms = Date.now() - actBlock.startedAt;
            openActBlock.delete(toolId);
          }
        }

        const wire = capChars(content, TOOL_OUTPUT_WIRE_CHARS);
        emitStream({
          type: 'stream_tool_result', toolId, content: wire.text, isError,
          truncated: wire.truncated, fullChars: wire.fullChars, lane,
        });

        if (lane === 'main') {
          const existing = toolBlocks.find(t => t.toolId === toolId);
          if (existing) { existing.toolOutput = content; existing.isError = isError; }
        }
      }
      return;
    }

    // Stream event — token-by-token delta from --include-partial-messages
    if (event.type === 'stream_event') {
      const inner = event.event;
      if (!inner) return;

      if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
        // Gives the tool name instantly, before the assistant block resolves.
        const key = lane + ':' + inner.index;
        const toolId = inner.content_block.id;
        const toolName = inner.content_block.name;
        toolProgressByIndex.set(key, { toolId, toolName, partial: '' });
        emitStream({ type: 'stream_tool_progress', toolId, toolName, partialInput: '', lane });
        return;
      }

      if (inner.type === 'content_block_stop') {
        toolProgressByIndex.delete(lane + ':' + inner.index);
        return;
      }

      if (inner.type === 'content_block_delta') {
        const delta = inner.delta;

        if (delta?.type === 'text_delta' && delta.text) {
          if (!subagentDeltasOn && openLanes.size > 0) return; // see SUBAGENT_DELTAS above
          const seen = messageTextByLane.get(lane) || '';
          messageTextByLane.set(lane, seen + delta.text);
          if (lane === 'main') accumulatedText += delta.text;
          const wire = emitStream({ type: 'stream_text', text: delta.text, lane });
          appendSay(lane, delta.text, wire.seq);
          return;
        }

        if (delta?.type === 'thinking_delta' && delta.thinking) {
          if (!subagentDeltasOn && openLanes.size > 0) return;
          const seen = thinkingTextByLane.get(lane) || '';
          thinkingTextByLane.set(lane, seen + delta.thinking);
          const wire = emitStream({ type: 'stream_thinking', text: delta.thinking, lane });
          appendThink(lane, delta.thinking, wire.seq);
          return;
        }

        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const key = lane + ':' + inner.index;
          const progress = toolProgressByIndex.get(key);
          if (progress) {
            progress.partial += delta.partial_json;
            emitStream({
              type: 'stream_tool_progress', toolId: progress.toolId,
              toolName: progress.toolName, partialInput: progress.partial, lane,
            });
          }
          return;
        }
      }
      return;
    }

    // Result — final message with cost info; save session immediately
    if (event.type === 'result') {
      const usage = event.usage || {};
      const modelUsage = event.modelUsage || {};
      const modelKeys = Object.keys(modelUsage);
      const modelKey = modelKeys[0] || '';
      const modelInfo = modelUsage[modelKey] || {};
      /*
       * Keep the [1m] suffix — see server.js history. It is the only signal that
       * the 1M-context variant actually served the request. The vendor prefix is
       * still dropped, since it carries nothing for the UI. Unchanged from the
       * pre-extraction logic on purpose.
       */
      const resolvedModel = modelKey.replace(/^[^/]*\//, '') || model;

      costInfo = {
        cost: event.total_cost_usd ?? event.cost_usd ?? null,
        duration: event.duration_ms ?? null,
      };

      persistTurn();

      /*
       * `model` is the ALIAS passed to --model ('opus', 'sonnet[1m]', ...);
       * `resolvedModel` is always a fully-resolved id ('claude-opus-5', ...).
       * Those two are never string-equal even on a perfectly normal turn, so
       * a straight !== would fire stream_fallback on every single result.
       * A real fallback is a FAMILY mismatch — "opus" requested but nothing
       * in the resolved id contains "opus" (e.g. it silently served sonnet).
       */
      const requestedFamily = (model || '').replace(/\[1m\]$/, '').toLowerCase();
      const familyMismatch = requestedFamily && !resolvedModel.toLowerCase().includes(requestedFamily);

      if (modelKeys.length > 1 || familyMismatch) {
        emitStream({
          type: 'stream_fallback', from: model, to: resolvedModel,
          reason: modelKeys.length > 1 ? 'multi-model' : 'resolved-differs',
        });
      }

      emitStream({
        type: 'stream_end',
        cost: costInfo.cost,
        duration: costInfo.duration,
        sessionId: session.id,
        model: resolvedModel,
        models: modelKeys, // all modelUsage keys — a turn that ran a subagent on a
                            // second model no longer reports only one of them
        // error_max_turns / error_during_execution must stop reporting as success;
        // the client now has what it needs to tell the difference.
        subtype: event.subtype || null,
        isError: !!event.is_error,
        inputTokens: modelInfo.inputTokens ?? usage.input_tokens ?? null,
        outputTokens: modelInfo.outputTokens ?? usage.output_tokens ?? null,
        cacheReadTokens: modelInfo.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? null,
        tokensPerSecond: costInfo.duration > 0 ? Math.round((modelInfo.outputTokens || 0) / (costInfo.duration / 1000)) : null,
        followUps: generateFollowUps(accumulatedText, toolBlocks),
      });
      return;
    }
  }

  /** A lane that never got its tool_result (killed/cancelled mid-subagent) must
   *  not sit forever as 'live' in a saved, finished transcript. */
  function sweepOpenLanes() {
    for (const info of openLanes.values()) {
      info.block.status = 'cancel'; // matches the client Run.status vocabulary
      info.block.ms = Date.now() - info.startedAt;
    }
    openLanes.clear();
  }

  function persistTurn() {
    if (messagesSaved) return;
    /*
     * Housekeeping turns are not conversation.
     *
     * The client has always sent isSystemRequest:true on its title-generation
     * call, and the server has always ignored it — the prompt was pushed into
     * session.messages like any other, so "Generate a concise 3-5 word title…"
     * and its reply became visible turns, inflated the message count, and were
     * synced into the vector DB as if the user had asked them. One real session
     * here holds two exchanges and eight messages.
     *
     * The v2 renderer made it obvious rather than causing it: every saved turn
     * now draws a run header, so the title call shows up as a stray empty run.
     */
    if (isSystemRequest) { messagesSaved = true; return; }
    if (!accumulatedText && toolBlocks.length === 0 && blocks.length === 0) return;
    sweepOpenLanes();

    session.messages.push({
      role: 'user', content: userText, timestamp: new Date().toISOString(), toolBlocks: [],
    });
    session.messages.push({
      role: 'assistant',
      content: accumulatedText,
      timestamp: new Date().toISOString(),
      toolBlocks: [...toolBlocks],
      blocks, // U2-PERSIST — ordered, in emission order; content/toolBlocks kept for old sessions
    });
    saveSession(session);
    messagesSaved = true;

    try { autoExtractMemory(userText, accumulatedText, session.name); } catch (_) {}
    syncSessionToVectorDb(session).catch((e) => {
      console.error('[agentdb] Session sync failed for ' + session.id + ':', e.message);
    });
    broadcastSessionUpdate();
  }

  /** Called from child.on('close') — the safety net if 'result' never arrived. */
  function finalizeIfUnsaved() {
    persistTurn();
    if (!costInfo) {
      emitStream({ type: 'stream_end', cost: null, duration: null, sessionId: session.id });
    }
  }

  function getFullToolOutput(toolId) {
    return toolOutputMap.has(toolId) ? toolOutputMap.get(toolId) : null;
  }

  return {
    processStreamEvent,
    finalizeIfUnsaved,
    getFullToolOutput,
    getAccumulatedText: () => accumulatedText,
    getToolBlocks: () => toolBlocks,
    getBlocks: () => blocks,
    getCostInfo: () => costInfo,
  };
}

module.exports = {
  createEmitStream,
  createStreamEventProcessor,
  classifyTool,
  capChars,
  TOOL_OUTPUT_WIRE_CHARS,
  TOOL_OUTPUT_DISK_CHARS,
};
