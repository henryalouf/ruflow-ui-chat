const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  createEmitStream,
  createStreamEventProcessor,
  classifyTool,
  capChars,
  TOOL_OUTPUT_WIRE_CHARS,
  TOOL_OUTPUT_DISK_CHARS,
} = require('../lib/stream-events');

// ---------------------------------------------------------------------------
// Fixture builders — shaped like the stream-json lines server.js parses.
// ---------------------------------------------------------------------------

function textDelta(text, parentId) {
  const e = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } };
  if (parentId) e.parent_tool_use_id = parentId;
  return e;
}
function thinkingDelta(text, parentId) {
  const e = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } } };
  if (parentId) e.parent_tool_use_id = parentId;
  return e;
}
function assistantText(text, parentId) {
  const e = { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  if (parentId) e.parent_tool_use_id = parentId;
  return e;
}
function assistantThinking(text, parentId) {
  const e = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } };
  if (parentId) e.parent_tool_use_id = parentId;
  return e;
}
function assistantToolUse(blocks, parentId) {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  const e = { type: 'assistant', message: { content: list.map(b => ({ type: 'tool_use', ...b })) } };
  if (parentId) e.parent_tool_use_id = parentId;
  return e;
}
function toolResult(toolId, content, isError, parentId) {
  const e = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: !!isError }] } };
  if (parentId) e.parent_tool_use_id = parentId;
  return e;
}
function resultEvent(overrides = {}) {
  return {
    type: 'result',
    total_cost_usd: 0.01,
    duration_ms: 1000,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0 } },
    subtype: 'success',
    is_error: false,
    ...overrides,
  };
}

function byType(sent, type) {
  return sent.filter(e => e.type === type);
}

function makeHarness(procOpts = {}) {
  const sent = [];
  const { emitStream, runId } = createEmitStream({ send: (o) => sent.push(o) });
  const session = { id: 'sess-1', name: 'Test Session', messages: [] };
  const saved = [];
  const memoryCalls = [];
  const syncCalls = [];
  let broadcastCount = 0;

  const processor = createStreamEventProcessor({
    emitStream,
    session,
    userText: 'hello',
    model: 'sonnet',
    saveSession: (s) => saved.push(s),
    autoExtractMemory: (...args) => memoryCalls.push(args),
    syncSessionToVectorDb: (s) => { syncCalls.push(s); return Promise.resolve(); },
    broadcastSessionUpdate: () => { broadcastCount++; },
    generateFollowUps: () => ['a', 'b', 'c'],
    ...procOpts,
  });

  return {
    processor, sent, session, saved, memoryCalls, syncCalls, runId,
    getBroadcastCount: () => broadcastCount,
  };
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('createEmitStream — envelope', () => {
  it('stamps a monotonic seq starting at 1', () => {
    const sent = [];
    const { emitStream } = createEmitStream({ send: (o) => sent.push(o) });
    emitStream({ type: 'a' });
    emitStream({ type: 'b' });
    emitStream({ type: 'c' });
    assert.deepStrictEqual(sent.map(e => e.seq), [1, 2, 3]);
  });

  it('stamps the same runId on every event from one instance', () => {
    const sent = [];
    const { emitStream, runId } = createEmitStream({ send: (o) => sent.push(o) });
    emitStream({ type: 'a' });
    emitStream({ type: 'b' });
    assert.ok(runId);
    assert.strictEqual(sent[0].runId, runId);
    assert.strictEqual(sent[1].runId, runId);
  });

  it('defaults lane to main when not set, but respects an explicit lane', () => {
    const sent = [];
    const { emitStream } = createEmitStream({ send: (o) => sent.push(o) });
    emitStream({ type: 'a' });
    emitStream({ type: 'b', lane: 'tu_07' });
    assert.strictEqual(sent[0].lane, 'main');
    assert.strictEqual(sent[1].lane, 'tu_07');
  });

  it('returns the stamped object so callers can read back the assigned seq', () => {
    const { emitStream } = createEmitStream({ send: () => {} });
    const stamped = emitStream({ type: 'x' });
    assert.strictEqual(stamped.type, 'x');
    assert.strictEqual(stamped.seq, 1);
  });

  it('two instances mint two different runIds', () => {
    const a = createEmitStream({ send: () => {} });
    const b = createEmitStream({ send: () => {} });
    assert.notStrictEqual(a.runId, b.runId);
  });
});

// ---------------------------------------------------------------------------
// classifyTool / capChars
// ---------------------------------------------------------------------------

describe('classifyTool', () => {
  it('maps known tools to their kind', () => {
    assert.strictEqual(classifyTool('Read'), 'read');
    assert.strictEqual(classifyTool('Write'), 'write');
    assert.strictEqual(classifyTool('Edit'), 'edit');
    assert.strictEqual(classifyTool('MultiEdit'), 'edit');
    assert.strictEqual(classifyTool('Bash'), 'command');
    assert.strictEqual(classifyTool('Grep'), 'search');
    assert.strictEqual(classifyTool('Glob'), 'search');
    assert.strictEqual(classifyTool('WebFetch'), 'web');
    assert.strictEqual(classifyTool('Task'), 'agent');
    assert.strictEqual(classifyTool('TodoWrite'), 'todo');
  });

  it('falls back to other for an unrecognized tool name', () => {
    assert.strictEqual(classifyTool('SomeFutureTool'), 'other');
  });
});

describe('capChars', () => {
  it('does not truncate text under the max', () => {
    const r = capChars('hello', 10);
    assert.deepStrictEqual(r, { text: 'hello', truncated: false, fullChars: 5 });
  });

  it('truncates and reports the real length when over the max', () => {
    const r = capChars('hello world', 5);
    assert.strictEqual(r.text, 'hello');
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.fullChars, 11);
  });
});

// ---------------------------------------------------------------------------
// Main-lane text accumulation — parity with the pre-extraction behavior.
// Mirrors tests/accumulator.test.js's scenarios, but through the real
// processor rather than a standalone reimplementation.
// ---------------------------------------------------------------------------

describe('processStreamEvent — main lane text accumulation', () => {
  it('keeps text from every assistant message in a tool-using turn', () => {
    const { processor } = makeHarness();
    for (const t of ['Let me ', 'search ', 'for that.']) processor.processStreamEvent(textDelta(t));
    processor.processStreamEvent(assistantText('Let me search for that.'));

    for (const t of ['Found ', 'it.']) processor.processStreamEvent(textDelta(t));
    processor.processStreamEvent(assistantText('Found it.'));

    assert.strictEqual(processor.getAccumulatedText(), 'Let me search for that.Found it.');
  });

  it('does not re-send text the deltas already delivered', () => {
    const { processor, sent } = makeHarness();
    for (const t of ['Hello ', 'world']) processor.processStreamEvent(textDelta(t));
    processor.processStreamEvent(assistantText('Hello world'));

    const text = byType(sent, 'stream_text').map(e => e.text).join('');
    assert.strictEqual(text, 'Hello world');
    assert.strictEqual(processor.getAccumulatedText(), 'Hello world');
  });

  it('still captures text when no deltas arrived (partial messages disabled)', () => {
    const { processor } = makeHarness();
    processor.processStreamEvent(assistantText('First.'));
    processor.processStreamEvent(assistantText('Second.'));
    assert.strictEqual(processor.getAccumulatedText(), 'First.Second.');
  });

  it('handles a message split across several text blocks', () => {
    const { processor } = makeHarness();
    processor.processStreamEvent(textDelta('Part one. '));
    processor.processStreamEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }] },
    });
    assert.strictEqual(processor.getAccumulatedText(), 'Part one. Part two.');
  });

  it('survives a long turn with many tool calls', () => {
    const { processor } = makeHarness();
    const expected = [];
    for (let i = 0; i < 14; i++) {
      const line = `Step ${i}. `;
      processor.processStreamEvent(textDelta(line));
      processor.processStreamEvent(assistantText(line));
      processor.processStreamEvent(assistantToolUse({ id: `t${i}`, name: 'Read', input: { file_path: `/f${i}` } }));
      expected.push(line);
    }
    processor.processStreamEvent(textDelta('Done.'));
    processor.processStreamEvent(assistantText('Done.'));
    expected.push('Done.');

    assert.strictEqual(processor.getAccumulatedText(), expected.join(''));
  });
});

// ---------------------------------------------------------------------------
// The critical companion change: per-lane dedupe. Two concurrent subagent
// lanes must not corrupt each other's startsWith dedupe — this is the exact
// failure the spec calls out for a single shared currentMessageText.
// ---------------------------------------------------------------------------

describe('processStreamEvent — per-lane dedupe isolation', () => {
  it('keeps two concurrently-open lanes\' text independent and non-duplicated', () => {
    const { processor, sent } = makeHarness();

    // Two Task subagents dispatched in the same assistant message — the
    // normal shape for parallel tool calls.
    processor.processStreamEvent(assistantToolUse([
      { id: 'taskA', name: 'Task', input: { subagent_type: 'researcher', description: 'Audit A' } },
      { id: 'taskB', name: 'Task', input: { subagent_type: 'reviewer', description: 'Audit B' } },
    ]));

    // Interleaved deltas across both lanes.
    processor.processStreamEvent(textDelta('Alpha step one. ', 'taskA'));
    processor.processStreamEvent(textDelta('Beta step one. ', 'taskB'));
    processor.processStreamEvent(textDelta('Alpha step two.', 'taskA'));
    processor.processStreamEvent(textDelta('Beta step two.', 'taskB'));

    // Each lane's complete assistant block covers exactly what its own
    // deltas already sent — a single shared dedupe variable would compare
    // this against the OTHER lane's interleaved text and misfire.
    processor.processStreamEvent(assistantText('Alpha step one. Alpha step two.', 'taskA'));
    processor.processStreamEvent(assistantText('Beta step one. Beta step two.', 'taskB'));

    const aText = byType(sent, 'stream_text').filter(e => e.lane === 'taskA').map(e => e.text).join('');
    const bText = byType(sent, 'stream_text').filter(e => e.lane === 'taskB').map(e => e.text).join('');
    assert.strictEqual(aText, 'Alpha step one. Alpha step two.');
    assert.strictEqual(bText, 'Beta step one. Beta step two.');

    // No leakage into the main transcript.
    assert.strictEqual(processor.getAccumulatedText(), '');

    // And each lane's nested blocks[] carries exactly its own text, not the
    // other lane's, and not a duplicate of it.
    const [agentA, agentB] = processor.getBlocks().filter(b => b.k === 'agent');
    assert.strictEqual(agentA.blocks[0].text, 'Alpha step one. Alpha step two.');
    assert.strictEqual(agentB.blocks[0].text, 'Beta step one. Beta step two.');
  });

  it('routes text with no parent_tool_use_id to _unattributed while a lane is open, never to main', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 'taskA', name: 'Task', input: { subagent_type: 'researcher', description: 'Audit' } }));

    processor.processStreamEvent(textDelta('stray text with no lane attribution'));

    const strayEvents = byType(sent, 'stream_text');
    assert.strictEqual(strayEvents.length, 1);
    assert.strictEqual(strayEvents[0].lane, '_unattributed');
    // Never routed into the persisted main transcript.
    assert.strictEqual(processor.getAccumulatedText(), '');
  });
});

// ---------------------------------------------------------------------------
// Tool lifecycle: act blocks, wire vs disk output caps.
// ---------------------------------------------------------------------------

describe('processStreamEvent — tool lifecycle', () => {
  it('emits stream_tool_start with a kind and records a legacy toolBlocks entry', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 't1', name: 'Bash', input: { command: 'ls' } }));

    const start = byType(sent, 'stream_tool_start')[0];
    assert.strictEqual(start.toolId, 't1');
    assert.strictEqual(start.toolName, 'Bash');
    assert.strictEqual(start.kind, 'command');
    assert.strictEqual(start.lane, 'main');

    assert.strictEqual(processor.getToolBlocks().length, 1);
    assert.strictEqual(processor.getToolBlocks()[0].toolId, 't1');
  });

  it('caps stream_tool_result content on the wire at TOOL_OUTPUT_WIRE_CHARS', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 't1', name: 'Bash', input: { command: 'yes' } }));
    const huge = 'x'.repeat(TOOL_OUTPUT_WIRE_CHARS + 500);
    processor.processStreamEvent(toolResult('t1', huge, false));

    const result = byType(sent, 'stream_tool_result')[0];
    assert.strictEqual(result.content.length, TOOL_OUTPUT_WIRE_CHARS);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.fullChars, huge.length);
  });

  it('caps the persisted act block output at TOOL_OUTPUT_DISK_CHARS, independent of the wire cap', () => {
    const { processor } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 't1', name: 'Read', input: { file_path: '/big.txt' } }));
    const big = 'y'.repeat(TOOL_OUTPUT_DISK_CHARS + 200);
    processor.processStreamEvent(toolResult('t1', big, false));

    const actBlock = processor.getBlocks().find(b => b.k === 'act' && b.toolId === 't1');
    assert.strictEqual(actBlock.output.length, TOOL_OUTPUT_DISK_CHARS);
    assert.strictEqual(actBlock.truncated, true);
    assert.strictEqual(actBlock.fullChars, big.length);
    assert.ok(actBlock.ms >= 0);
  });

  it('marks an act block errored when the tool_result is an error', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 't1', name: 'Bash', input: { command: 'false' } }));
    processor.processStreamEvent(toolResult('t1', 'command not found', true));

    const wire = byType(sent, 'stream_tool_result')[0];
    assert.strictEqual(wire.isError, true);
    const actBlock = processor.getBlocks().find(b => b.k === 'act');
    assert.strictEqual(actBlock.isError, true);
    assert.strictEqual(processor.getToolBlocks()[0].isError, true);
  });
});

// ---------------------------------------------------------------------------
// stream_tool_progress — content_block_start / input_json_delta
// ---------------------------------------------------------------------------

describe('processStreamEvent — tool progress', () => {
  it('gives the tool name instantly on content_block_start, then accumulates partial_json', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "l' } },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 's"}' } },
    });

    const progress = byType(sent, 'stream_tool_progress');
    assert.strictEqual(progress.length, 3);
    assert.strictEqual(progress[0].toolName, 'Bash');
    assert.strictEqual(progress[0].partialInput, '');
    assert.strictEqual(progress[1].partialInput, '{"command": "l');
    assert.strictEqual(progress[2].partialInput, '{"command": "ls"}');
  });

  it('keys progress by lane so two lanes reusing the same index do not collide', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 'taskA', name: 'Task', input: { subagent_type: 'x', description: 'y' } }));

    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'sub1', name: 'Grep' } },
      parent_tool_use_id: 'taskA',
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'main1', name: 'Bash' } },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'sub-json' } },
      parent_tool_use_id: 'taskA',
    });

    const progress = byType(sent, 'stream_tool_progress');
    const subUpdate = progress.find(p => p.toolId === 'sub1' && p.partialInput === 'sub-json');
    assert.ok(subUpdate, 'the subagent lane delta must update the subagent tool, not the main one');
  });
});

// ---------------------------------------------------------------------------
// Subagent lanes: ordering guarantee, agent block, thinking blocks.
// ---------------------------------------------------------------------------

describe('processStreamEvent — subagent lanes', () => {
  it('emits stream_tool_start before stream_lane_open, and stream_lane_close before stream_tool_result', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 'taskA', name: 'Task', input: { subagent_type: 'researcher', description: 'Audit auth' } }));
    processor.processStreamEvent(toolResult('taskA', 'subagent report text', false));

    const order = sent.map(e => e.type);
    assert.ok(order.indexOf('stream_tool_start') < order.indexOf('stream_lane_open'));
    assert.ok(order.indexOf('stream_lane_close') < order.indexOf('stream_tool_result'));

    const open = byType(sent, 'stream_lane_open')[0];
    assert.strictEqual(open.laneId, 'taskA');
    assert.strictEqual(open.parentLane, 'main');
    assert.strictEqual(open.agentType, 'researcher');
    assert.strictEqual(open.label, 'Audit auth');

    const close = byType(sent, 'stream_lane_close')[0];
    assert.strictEqual(close.status, 'ok');
    assert.strictEqual(close.resultChars, 'subagent report text'.length);
  });

  it('persists a k:"agent" block (not an act block) with nested blocks for the lane', () => {
    const { processor } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 'taskA', name: 'Task', input: { subagent_type: 'researcher', description: 'Audit auth' } }));
    processor.processStreamEvent(textDelta('Looking at session.js.', 'taskA'));
    processor.processStreamEvent(assistantText('Looking at session.js.', 'taskA'));
    processor.processStreamEvent(toolResult('taskA', 'done', false));

    const agentBlock = processor.getBlocks().find(b => b.k === 'agent');
    assert.ok(agentBlock);
    assert.strictEqual(agentBlock.laneId, 'taskA');
    assert.strictEqual(agentBlock.agentType, 'researcher');
    assert.strictEqual(agentBlock.status, 'ok');
    assert.ok(agentBlock.ms >= 0);
    assert.strictEqual(agentBlock.blocks.length, 1);
    assert.strictEqual(agentBlock.blocks[0].k, 'say');
    assert.strictEqual(agentBlock.blocks[0].text, 'Looking at session.js.');

    // Not duplicated into the flat legacy bag.
    assert.strictEqual(processor.getToolBlocks().some(t => t.toolId === 'taskA'), true); // Task itself is a main-lane tool_use
  });

  it('marks a lane that never closes as cancelled once the run is finalized', () => {
    const { processor } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 'taskA', name: 'Task', input: { subagent_type: 'researcher', description: 'Audit' } }));
    processor.processStreamEvent(textDelta('partial work', 'taskA'));
    processor.processStreamEvent(assistantText('partial work', 'taskA'));

    // The run is killed mid-subagent — no tool_result ever arrives.
    processor.finalizeIfUnsaved();

    const agentBlock = processor.getBlocks().find(b => b.k === 'agent');
    assert.strictEqual(agentBlock.status, 'cancel');
    assert.ok(agentBlock.ms >= 0);
  });
});

describe('processStreamEvent — thinking blocks', () => {
  it('emits stream_thinking and never adds it to accumulatedText', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(thinkingDelta('pondering the '));
    processor.processStreamEvent(assistantThinking('pondering the approach'));

    const thoughts = byType(sent, 'stream_thinking').map(e => e.text).join('');
    assert.strictEqual(thoughts, 'pondering the approach');
    assert.strictEqual(processor.getAccumulatedText(), '');

    const thinkBlock = processor.getBlocks().find(b => b.k === 'think');
    assert.strictEqual(thinkBlock.text, 'pondering the approach');
  });
});

// ---------------------------------------------------------------------------
// SUBAGENT_DELTAS=off — the verification-gate fallback.
// ---------------------------------------------------------------------------

describe('SUBAGENT_DELTAS off', () => {
  it('suppresses delta routing while any lane is open, but complete assistant blocks still land', () => {
    const { processor, sent } = makeHarness({ subagentDeltasOn: false });
    processor.processStreamEvent(assistantToolUse({ id: 'taskA', name: 'Task', input: { subagent_type: 'x', description: 'y' } }));

    processor.processStreamEvent(textDelta('should be suppressed', 'taskA'));
    assert.strictEqual(byType(sent, 'stream_text').length, 0);

    processor.processStreamEvent(assistantText('the real complete text', 'taskA'));
    const texts = byType(sent, 'stream_text');
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].text, 'the real complete text');
  });

  it('does not suppress deltas once every lane has closed', () => {
    const { processor, sent } = makeHarness({ subagentDeltasOn: false });
    processor.processStreamEvent(assistantToolUse({ id: 'taskA', name: 'Task', input: { subagent_type: 'x', description: 'y' } }));
    processor.processStreamEvent(toolResult('taskA', 'done', false));

    processor.processStreamEvent(textDelta('main text after subagent closed'));
    const texts = byType(sent, 'stream_text');
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].text, 'main text after subagent closed');
  });
});

// ---------------------------------------------------------------------------
// result event — models[], subtype/isError, stream_fallback
// ---------------------------------------------------------------------------

describe('processStreamEvent — result', () => {
  it('reports all modelUsage keys and passes subtype/isError through', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantText('done.'));
    processor.processStreamEvent(resultEvent({
      subtype: 'error_max_turns',
      is_error: true,
      modelUsage: {
        'claude-sonnet-5': { inputTokens: 5, outputTokens: 5 },
        'claude-haiku-4-5': { inputTokens: 2, outputTokens: 1 },
      },
    }));

    const end = byType(sent, 'stream_end')[0];
    assert.deepStrictEqual(end.models.sort(), ['claude-haiku-4-5', 'claude-sonnet-5']);
    assert.strictEqual(end.subtype, 'error_max_turns');
    assert.strictEqual(end.isError, true);
  });

  it('emits stream_fallback when more than one model was used', () => {
    const { processor, sent } = makeHarness();
    processor.processStreamEvent(assistantText('done.'));
    processor.processStreamEvent(resultEvent({
      modelUsage: {
        'claude-sonnet-5': { inputTokens: 5, outputTokens: 5 },
        'claude-opus-5': { inputTokens: 2, outputTokens: 1 },
      },
    }));
    assert.strictEqual(byType(sent, 'stream_fallback').length, 1);
  });

  it('emits stream_fallback when the resolved model differs from the requested one', () => {
    const { processor, sent } = makeHarness({ model: 'opus' });
    processor.processStreamEvent(assistantText('done.'));
    processor.processStreamEvent(resultEvent({ modelUsage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1 } } }));

    const fb = byType(sent, 'stream_fallback')[0];
    assert.strictEqual(fb.from, 'opus');
    assert.strictEqual(fb.to, 'claude-sonnet-5');
  });

  it('does not emit stream_fallback when a single model matches the request', () => {
    const { processor, sent } = makeHarness({ model: 'sonnet' });
    processor.processStreamEvent(assistantText('done.'));
    processor.processStreamEvent(resultEvent({ modelUsage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1 } } }));
    assert.strictEqual(byType(sent, 'stream_fallback').length, 0);
  });

  it('preserves the [1m] suffix on the resolved model', () => {
    const { processor, sent } = makeHarness({ model: 'sonnet[1m]' });
    processor.processStreamEvent(assistantText('done.'));
    processor.processStreamEvent(resultEvent({ modelUsage: { 'anthropic/claude-sonnet-5[1m]': { inputTokens: 1, outputTokens: 1 } } }));
    const end = byType(sent, 'stream_end')[0];
    assert.strictEqual(end.model, 'claude-sonnet-5[1m]');
  });
});

// ---------------------------------------------------------------------------
// Persistence — U2-PERSIST
// ---------------------------------------------------------------------------

describe('persistence (persistTurn / finalizeIfUnsaved)', () => {
  it('saves user + assistant messages with content, toolBlocks, and blocks together', () => {
    const { processor, session, saved, memoryCalls, syncCalls, getBroadcastCount } = makeHarness();
    processor.processStreamEvent(textDelta('Checking the config. '));
    processor.processStreamEvent(assistantText('Checking the config. '));
    processor.processStreamEvent(assistantToolUse({ id: 't1', name: 'Bash', input: { command: 'cat config' } }));
    processor.processStreamEvent(toolResult('t1', 'ok=true', false));
    processor.processStreamEvent(assistantText('All good.'));
    processor.processStreamEvent(resultEvent());

    assert.strictEqual(session.messages.length, 2);
    assert.strictEqual(session.messages[0].role, 'user');
    assert.strictEqual(session.messages[1].role, 'assistant');
    assert.strictEqual(session.messages[1].content, 'Checking the config. All good.');
    assert.strictEqual(session.messages[1].toolBlocks.length, 1);
    assert.ok(Array.isArray(session.messages[1].blocks));
    assert.ok(session.messages[1].blocks.length >= 2); // at least a say and an act

    assert.strictEqual(saved.length, 1);
    assert.strictEqual(memoryCalls.length, 1);
    assert.strictEqual(syncCalls.length, 1);
    assert.strictEqual(getBroadcastCount(), 1);
  });

  it('finalizeIfUnsaved is a no-op once result has already saved the turn (no double save)', () => {
    const { processor, session, saved } = makeHarness();
    processor.processStreamEvent(assistantText('done.'));
    processor.processStreamEvent(resultEvent());
    assert.strictEqual(saved.length, 1);

    processor.finalizeIfUnsaved();
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(session.messages.length, 2);
  });

  it('finalizeIfUnsaved saves the turn (as the close-fallback) when result never arrived', () => {
    const { processor, session, saved, sent } = makeHarness();
    processor.processStreamEvent(assistantText('partial answer before the process died'));
    processor.finalizeIfUnsaved();

    assert.strictEqual(saved.length, 1);
    assert.strictEqual(session.messages[1].content, 'partial answer before the process died');
    // No cost info was ever set, so a bare fallback stream_end is emitted.
    const end = byType(sent, 'stream_end')[0];
    assert.strictEqual(end.cost, null);
  });

  it('does not save anything for a turn with no text, no tools, and no blocks', () => {
    const { processor, session, saved } = makeHarness();
    processor.finalizeIfUnsaved();
    assert.strictEqual(saved.length, 0);
    assert.strictEqual(session.messages.length, 0);
  });
});

// ---------------------------------------------------------------------------
// system/init lifecycle
// ---------------------------------------------------------------------------

describe('processStreamEvent — lifecycle', () => {
  it('captures the CLI session id and emits stream_lifecycle session_ready on system/init', () => {
    const { processor, session, sent, saved } = makeHarness();
    processor.processStreamEvent({ type: 'system', subtype: 'init', session_id: 'cli-abc-123' });

    assert.strictEqual(session.cliSessionId, 'cli-abc-123');
    assert.strictEqual(saved.length, 1);
    const lifecycle = byType(sent, 'stream_lifecycle')[0];
    assert.strictEqual(lifecycle.phase, 'session_ready');
  });
});

// ---------------------------------------------------------------------------
// fetch_tool_output support — in-memory lookup
// ---------------------------------------------------------------------------

describe('getFullToolOutput', () => {
  it('returns the full (uncapped-for-wire) tool_result content by toolId', () => {
    const { processor } = makeHarness();
    processor.processStreamEvent(assistantToolUse({ id: 't1', name: 'Bash', input: { command: 'yes' } }));
    const huge = 'z'.repeat(TOOL_OUTPUT_WIRE_CHARS + 1000);
    processor.processStreamEvent(toolResult('t1', huge, false));

    assert.strictEqual(processor.getFullToolOutput('t1').length, huge.length);
  });

  it('returns null for an unknown toolId', () => {
    const { processor } = makeHarness();
    assert.strictEqual(processor.getFullToolOutput('nope'), null);
  });
});

// ---------------------------------------------------------------------------
// A finished turn must append to the session's CURRENT state
//
// handleChat loads the session once and holds that object for the whole
// streamed reply. Two turns on the same session each mutated their own stale
// snapshot, and whichever saved last silently dropped the other's messages — a
// lost update, which temp+rename does nothing to prevent.
// ---------------------------------------------------------------------------
describe('persistTurn — concurrent turns do not clobber each other', () => {
  it('appends through appendSessionMessages rather than the held snapshot', () => {
    const appends = [];
    const h = makeHarness({
      appendSessionMessages: (id, msgs) => {
        appends.push({ id, msgs });
        // Simulate a concurrent turn having landed during this stream.
        return { id, messages: [{ role: 'user', content: 'earlier turn' }].concat(msgs) };
      },
    });
    h.processor.processStreamEvent(textDelta('the answer'));
    h.processor.processStreamEvent(assistantText('the answer'));
    h.processor.finalizeIfUnsaved();

    assert.strictEqual(appends.length, 1, 'the turn must persist via the fresh-read append');
    assert.strictEqual(appends[0].id, 'sess-1');
    assert.strictEqual(appends[0].msgs.length, 2, 'a user and an assistant message');
    assert.strictEqual(appends[0].msgs[0].role, 'user');
    assert.strictEqual(appends[0].msgs[1].role, 'assistant');
    assert.match(appends[0].msgs[1].content, /the answer/);
    // A turn that landed mid-stream must survive into the in-memory copy.
    assert.strictEqual(h.session.messages[0].content, 'earlier turn',
      'a concurrently-added message must not be dropped');
    assert.strictEqual(h.session.messages.length, 3);
  });

  it('falls back to the snapshot path when no appender is injected', () => {
    // Paired positive case: the older call shape must keep working.
    const h = makeHarness();
    h.processor.processStreamEvent(textDelta('legacy answer'));
    h.processor.processStreamEvent(assistantText('legacy answer'));
    h.processor.finalizeIfUnsaved();
    assert.ok(h.saved.length >= 1, 'the fallback must still save');
    assert.strictEqual(h.session.messages.length, 2, 'and still record both messages');
  });
});
