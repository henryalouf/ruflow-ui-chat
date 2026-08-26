const { describe, it } = require('node:test');
const assert = require('node:assert');
const RunModel = require('../public/run-model.js');

const {
  createRun, laneFor, ingest, sealIdleSays,
  classifyTool, resolveTarget, isSubstantive, promoteVerdict,
  SEAL_MIN_CHARS, SEAL_IDLE_MS,
} = RunModel;

// ---------------------------------------------------------------------------
// run-model.js — the Run/Lane/Block state machine
//
// This is the piece SPEC-v2.md calls "the entire point of this rebuild": the
// seal rule that stops a tool-using turn from fragmenting into a spray of
// bubbles ("Let me check." -> Read -> "Now the config." as three separate
// messages, OpenClaw's literal flush-on-every-tool-start behaviour), plus the
// two deterministic tiers of the stale-conclusion mechanism (a superseded
// "I couldn't find X" greying out live, and the run's actual final answer
// getting promoted in place rather than staying buried under everything that
// came after it).
//
// The model is pure — no DOM — specifically so every rule below can be
// asserted directly against a synthetic event stream, without a browser.
// ---------------------------------------------------------------------------

/** Builds ingest()-ready events with an auto-incrementing per-run seq. */
function emitter() {
  let seq = 0;
  return function ev(type, fields) {
    seq += 1;
    return Object.assign({ type, seq, lane: 'main' }, fields);
  };
}

const SHORT = 'Let me check.'; // 14 trimmed chars, well under SEAL_MIN_CHARS
const LONG = 'Let me investigate this thoroughly by checking the config file first.'; // >= 40 chars

describe('createRun / laneFor', () => {
  it('starts with the shape SPEC-v2.md lists for Run', () => {
    const run = createRun({ id: 'r1', sessionId: 's1', model: 'sonnet' });
    assert.strictEqual(run.status, 'live');
    assert.strictEqual(run.lanes.size, 0);
    assert.strictEqual(run.byId.size, 0);
    assert.strictEqual(run.lastSeq, 0);
    assert.deepStrictEqual(run.counts, { read: 0, edit: new Set(), cmd: 0, err: 0 });
  });

  it('get-or-creates lanes, defaulting to main at depth 0', () => {
    const run = createRun();
    const main = laneFor(run, 'main');
    assert.strictEqual(main.depth, 0);
    assert.strictEqual(main.parentLane, null);
    assert.strictEqual(laneFor(run, 'main'), main, 'same lane object on second lookup');
  });

  it('a subagent lane defaults to depth 1, parented on main', () => {
    const run = createRun();
    const lane = laneFor(run, 'tu_07');
    assert.strictEqual(lane.depth, 1);
    assert.strictEqual(lane.parentLane, 'main');
  });
});

describe('classifyTool', () => {
  it('maps the common tool names to their kind2', () => {
    assert.strictEqual(classifyTool('Read'), 'read');
    assert.strictEqual(classifyTool('Write'), 'write');
    assert.strictEqual(classifyTool('Edit'), 'edit');
    assert.strictEqual(classifyTool('MultiEdit'), 'edit');
    assert.strictEqual(classifyTool('Bash'), 'command');
    assert.strictEqual(classifyTool('Grep'), 'search');
    assert.strictEqual(classifyTool('Glob'), 'search');
    assert.strictEqual(classifyTool('WebFetch'), 'fetch');
    assert.strictEqual(classifyTool('WebSearch'), 'search');
    assert.strictEqual(classifyTool('Task'), 'agent');
  });

  it('degrades an unknown tool to other rather than guessing', () => {
    assert.strictEqual(classifyTool('SomeFutureTool'), 'other');
    assert.strictEqual(classifyTool(''), 'other');
    assert.strictEqual(classifyTool(undefined), 'other');
  });

  it('strips an mcp__server__ prefix before matching', () => {
    assert.strictEqual(classifyTool('mcp__filesystem__Read'), 'read');
    assert.strictEqual(classifyTool('mcp__custom__DoesNotExist'), 'other');
  });
});

describe('resolveTarget', () => {
  it('honours the ordered probe list: command wins over file_path', () => {
    const t = resolveTarget('Bash', { command: 'npm test', file_path: '/x/y.js' });
    assert.strictEqual(t, 'npm test');
  });

  it('falls through the full probe order when earlier fields are absent', () => {
    assert.strictEqual(resolveTarget('Read', { file_path: '/a/b.js' }), '/a/b.js');
    assert.strictEqual(resolveTarget('Glob', { path: '/a' }), '/a');
    assert.strictEqual(resolveTarget('Grep', { pattern: 'TODO' }), 'TODO');
    assert.strictEqual(resolveTarget('WebFetch', { url: 'https://x.test' }), 'https://x.test');
    assert.strictEqual(resolveTarget('WebSearch', { query: 'ruflow' }), 'ruflow');
    assert.strictEqual(resolveTarget('Task', { description: 'Audit auth' }), 'Audit auth');
    assert.strictEqual(resolveTarget('Task', { name: 'researcher' }), 'researcher');
  });

  it('returns empty string when no probed field is present', () => {
    assert.strictEqual(resolveTarget('Bash', {}), '');
    assert.strictEqual(resolveTarget('Bash', null), '');
  });

  it('collapses a $HOME prefix to ~ only when a home dir is supplied', () => {
    const home = '/home/claude-user';
    assert.strictEqual(
      resolveTarget('Read', { file_path: '/home/claude-user/repo/build.sh' }, home),
      '~/repo/build.sh'
    );
    // no home given -> no substitution, raw path passes through unchanged
    assert.strictEqual(
      resolveTarget('Read', { file_path: '/home/claude-user/repo/build.sh' }),
      '/home/claude-user/repo/build.sh'
    );
    // must be a path PREFIX match, not a substring anywhere in the string
    assert.strictEqual(
      resolveTarget('Bash', { command: 'echo not/home/claude-user/here' }, home),
      'echo not/home/claude-user/here'
    );
  });
});

describe('the seal rule', () => {
  it('a short preamble is absorbed as the tool row caption, not its own block', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: SHORT }));
    ingest(run, ev('stream_tool_start', { toolId: 't1', toolName: 'Read', toolInput: { file_path: '/x.js' } }));

    const lane = laneFor(run, 'main');
    assert.strictEqual(lane.openSay, null);
    assert.strictEqual(lane.blocks.length, 1, 'the say block must not survive as its own row');
    assert.strictEqual(lane.blocks[0].kind, 'act');
    assert.strictEqual(lane.blocks[0].caption, SHORT);

    // discarded entirely — not retrievable by id, not left dangling in byId
    assert.strictEqual(run.byId.size, 1);
  });

  it('a >=40-char preamble seals into its own block, not absorbed', () => {
    assert.ok(LONG.length >= SEAL_MIN_CHARS, 'fixture must actually exceed the floor');
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: LONG }));
    ingest(run, ev('stream_tool_start', { toolId: 't1', toolName: 'Bash', toolInput: { command: 'ls' } }));

    const lane = laneFor(run, 'main');
    assert.strictEqual(lane.blocks.length, 2, 'say block AND act block both survive');
    assert.strictEqual(lane.blocks[0].kind, 'say');
    assert.strictEqual(lane.blocks[0].text, LONG);
    assert.strictEqual(lane.blocks[0].sealed, true);
    assert.strictEqual(lane.blocks[1].kind, 'act');
    assert.strictEqual(lane.blocks[1].caption, null, 'nothing to absorb, so no caption');
  });

  it('does not fragment a chain of short preambles into separate bubbles', () => {
    // The exact failure mode SPEC-v2.md names: "Let me check." -> Read ->
    // "Now the config." -> Read -> "One more." -> Bash must NOT become three
    // say bubbles. With SEAL_MIN_CHARS=40 all three are captions.
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: 'Let me check.' }));
    ingest(run, ev('stream_tool_start', { toolId: 't1', toolName: 'Read', toolInput: { file_path: '/a.js' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't1', content: 'ok', isError: false }));
    ingest(run, ev('stream_text', { text: 'Now the config.' }));
    ingest(run, ev('stream_tool_start', { toolId: 't2', toolName: 'Read', toolInput: { file_path: '/b.js' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't2', content: 'ok', isError: false }));
    ingest(run, ev('stream_text', { text: 'One more.' }));
    ingest(run, ev('stream_tool_start', { toolId: 't3', toolName: 'Bash', toolInput: { command: 'ls' } }));

    const lane = laneFor(run, 'main');
    const kinds = lane.blocks.map((b) => b.kind);
    assert.deepStrictEqual(kinds, ['act', 'act', 'act'], 'zero say bubbles from three short preambles');
    assert.deepStrictEqual(lane.blocks.map((b) => b.caption), ['Let me check.', 'Now the config.', 'One more.']);
  });

  it('several tool calls in sequence, with no text between the second pair', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: LONG }));
    ingest(run, ev('stream_tool_start', { toolId: 't1', toolName: 'Read', toolInput: { file_path: '/a.js' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't1', content: 'file contents', isError: false }));
    // no stream_text here — the model went straight into a second tool call
    ingest(run, ev('stream_tool_start', { toolId: 't2', toolName: 'Bash', toolInput: { command: 'npm test' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't2', content: 'pass', isError: false }));

    const lane = laneFor(run, 'main');
    assert.deepStrictEqual(lane.blocks.map((b) => b.kind), ['say', 'act', 'act']);
    assert.strictEqual(lane.toolCount, 2);
    assert.strictEqual(lane.blocks[1].kind2, 'read');
    assert.strictEqual(lane.blocks[2].kind2, 'command');
    assert.strictEqual(lane.blocks[1].state, 'ok');
    assert.strictEqual(lane.blocks[2].state, 'ok');
  });

  it('seals on stream_end even if text is still open mid-sentence', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: 'Still writ' }));
    ingest(run, ev('stream_text', { text: 'ing…' }));
    ingest(run, ev('stream_end', { isError: false }));

    const lane = laneFor(run, 'main');
    assert.strictEqual(lane.openSay, null);
    assert.strictEqual(lane.blocks[0].sealed, true);
    assert.strictEqual(lane.blocks[0].text, 'Still writing…');
  });

  it('sealIdleSays seals an open say after SEAL_IDLE_MS of silence, and only that', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: LONG }));
    const lane = laneFor(run, 'main');
    const openBlock = lane.openSay;
    assert.strictEqual(openBlock.sealed, false);

    const tooSoon = openBlock.lastDeltaAt + (SEAL_IDLE_MS - 1);
    assert.deepStrictEqual(sealIdleSays(run, tooSoon), [], 'must not seal before the idle floor');
    assert.strictEqual(openBlock.sealed, false);

    const later = openBlock.lastDeltaAt + SEAL_IDLE_MS;
    const sealedNow = sealIdleSays(run, later);
    assert.strictEqual(sealedNow.length, 1);
    assert.strictEqual(sealedNow[0], openBlock);
    assert.strictEqual(openBlock.sealed, true);
    assert.strictEqual(lane.openSay, null);
  });
});

describe('interleaved lanes', () => {
  it('keeps two lanes\' open say text and tool state fully independent', () => {
    const run = createRun();
    const ev = emitter();

    ingest(run, ev('stream_text', { text: 'Delegating the audit. ', lane: 'main' }));
    ingest(run, ev('stream_text', { text: 'Looking at the auth module now, ', lane: 'tu_sub' }));
    ingest(run, ev('stream_text', { text: 'now waiting on the subagent.', lane: 'main' }));
    ingest(run, ev('stream_text', { text: 'will report back shortly.', lane: 'tu_sub' }));
    ingest(run, ev('stream_tool_start', {
      toolId: 'st1', toolName: 'Bash', toolInput: { command: 'npm test' }, lane: 'tu_sub',
    }));
    ingest(run, ev('stream_tool_start', {
      toolId: 'mt1', toolName: 'Read', toolInput: { file_path: '/a.js' }, lane: 'main',
    }));

    const main = laneFor(run, 'main');
    const sub = laneFor(run, 'tu_sub');

    // main's say text must be exactly the main-lane deltas, uncontaminated
    // by anything routed to tu_sub, and vice versa.
    assert.strictEqual(main.blocks[0].kind, 'say');
    assert.strictEqual(main.blocks[0].text, 'Delegating the audit. now waiting on the subagent.');
    assert.strictEqual(sub.blocks[0].kind, 'say');
    assert.strictEqual(sub.blocks[0].text, 'Looking at the auth module now, will report back shortly.');

    // each lane's tool call landed in its own lane, not the other's
    assert.strictEqual(main.toolCount, 1);
    assert.strictEqual(sub.toolCount, 1);
    assert.strictEqual(main.byToolId.has('mt1'), true);
    assert.strictEqual(main.byToolId.has('st1'), false);
    assert.strictEqual(sub.byToolId.has('st1'), true);
  });
});

describe('the seq fence (replay guard)', () => {
  it('drops a replayed event instead of double-applying it', () => {
    const run = createRun();
    const startEvent = { type: 'stream_tool_start', seq: 5, lane: 'main', toolId: 't1', toolName: 'Bash', toolInput: { command: 'ls' } };

    const first = ingest(run, startEvent);
    assert.notStrictEqual(first, null);
    assert.strictEqual(run.lastSeq, 5);
    assert.strictEqual(laneFor(run, 'main').toolCount, 1);

    // The exact bug the fence exists to prevent: without it this doubles
    // toolCount and re-creates the block, corrupting anything counting on it.
    const replayed = ingest(run, startEvent);
    assert.strictEqual(replayed, null, 'a duplicate seq must be dropped');
    assert.strictEqual(laneFor(run, 'main').toolCount, 1, 'toolCount must not double');
    assert.strictEqual(laneFor(run, 'main').blocks.length, 1);
  });

  it('drops any event with seq at or below what has already been applied', () => {
    const run = createRun();
    const ev = emitter(); // seq 1, 2, 3...
    ingest(run, ev('stream_text', { text: 'a' }));
    ingest(run, ev('stream_text', { text: 'b' }));
    assert.strictEqual(run.lastSeq, 2);

    // stale replay of seq=1, arriving after seq=2 already landed
    const stale = ingest(run, { type: 'stream_text', seq: 1, lane: 'main', text: 'STALE' });
    assert.strictEqual(stale, null);
    assert.strictEqual(laneFor(run, 'main').openSay.text, 'ab', 'stale text must not be appended');
  });

  it('does not throw on a malformed or unknown event', () => {
    const run = createRun();
    assert.strictEqual(ingest(run, null), null);
    assert.strictEqual(ingest(run, {}), null); // no numeric seq
    assert.strictEqual(ingest(run, { type: 'stream_something_new', seq: 1, lane: 'main' }), null);
  });
});

describe('Tier 1 — live structural demotion', () => {
  it('demotes a sealed say to role note the instant the next tool starts', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: LONG }));
    const lane = laneFor(run, 'main');
    const say = lane.openSay;
    assert.strictEqual(say.role, null, 'not demoted before any tool has run');

    ingest(run, ev('stream_tool_start', { toolId: 't1', toolName: 'Read', toolInput: { file_path: '/a.js' } }));
    assert.strictEqual(say.role, 'note', 'demoted live, without waiting for stream_end');
  });

  it('going idle alone does not demote — only a following tool call does', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: LONG }));
    const lane = laneFor(run, 'main');
    const say = lane.openSay;

    sealIdleSays(run, say.lastDeltaAt + SEAL_IDLE_MS);
    assert.strictEqual(say.sealed, true);
    assert.strictEqual(say.role, null, 'idle-sealed alone must not demote — it might be the verdict');

    // *now* a tool call arrives, proving this idle-sealed block was not the end
    ingest(run, ev('stream_tool_start', { toolId: 't1', toolName: 'Bash', toolInput: { command: 'ls' } }));
    assert.strictEqual(say.role, 'note', 'retroactively demoted once we learn more work followed');
  });
});

describe('Tier 2 — verdict promotion', () => {
  it('a trailing sign-off does not become the verdict', () => {
    const run = createRun();
    const ev = emitter();
    const answer = 'I found the root cause: the parser was missing a null check before the loop, which crashed on empty files. Added the guard and reran the suite.';
    assert.ok(isSubstantive(answer));
    assert.ok(!isSubstantive('Done.'));

    ingest(run, ev('stream_text', { text: answer }));
    const lane = laneFor(run, 'main');
    sealIdleSays(run, lane.openSay.lastDeltaAt + SEAL_IDLE_MS); // seal the answer, un-demoted
    ingest(run, ev('stream_text', { text: 'Done.' })); // opens a fresh say after the idle seal
    const result = ingest(run, ev('stream_end', { isError: false }));

    const verdictBlock = run.byId.get(result.verdictId);
    assert.strictEqual(verdictBlock.text, answer, 'the substantive answer is the verdict');
    assert.strictEqual(verdictBlock.role, 'verdict');

    const signoff = lane.blocks.find((b) => b.text === 'Done.');
    assert.strictEqual(signoff.role, 'note', 'the sign-off is demoted, never promoted');
    assert.deepStrictEqual(verdictBlock.signoffs, ['Done.'], 'its text is preserved on the verdict for the status line');
  });

  it('the last say IS the verdict directly when it is already substantive', () => {
    const run = createRun();
    const ev = emitter();
    const answer = 'Root cause confirmed and fixed.\nThe loop guard was the whole bug, and the full test suite is green now.';
    assert.ok(isSubstantive(answer), 'fixture must actually clear the substantive bar (multi-line)');
    ingest(run, ev('stream_text', { text: answer }));
    const result = ingest(run, ev('stream_end', { isError: false }));

    assert.strictEqual(run.byId.get(result.verdictId).text, answer);
    assert.deepStrictEqual(result.signoffIds, []);
  });

  it('falls back to the last say when every block reads as a sign-off', () => {
    // Previously this asserted verdictId === null. Promoting nothing leaves the
    // reader a page of uniformly grey text with no landing point, which is the
    // failure the whole verdict mechanism exists to prevent — reached from the
    // other direction. A turn whose blocks are all short still has an answer in
    // it, so the last one is promoted rather than none.
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_text', { text: 'OK.' }));
    const lane = laneFor(run, 'main');
    sealIdleSays(run, lane.openSay.lastDeltaAt + SEAL_IDLE_MS);
    ingest(run, ev('stream_text', { text: 'Done.' }));
    const result = ingest(run, ev('stream_end', { isError: false }));

    assert.ok(result.verdictId, 'something must be promoted');
    assert.strictEqual(run.byId.get(result.verdictId).text, 'Done.', 'the LAST say, not the first');
    assert.ok(!result.signoffIds.includes(result.verdictId), 'the promoted block is not also a sign-off');
  });

  it('isSubstantive rejects short single lines and accepts structure or length', () => {
    assert.strictEqual(isSubstantive('Pushed to main.'), false);
    assert.strictEqual(isSubstantive(''), false);
    assert.strictEqual(isSubstantive('   '), false);
    assert.strictEqual(isSubstantive('a'.repeat(61)), true, 'over 60 chars is substantive even on one line');
    assert.strictEqual(isSubstantive('a'.repeat(59)), false, 'under 60 on one line reads as a sign-off');
    // The regression this threshold exists for: a one-line answer carrying a real
    // finding is 101 chars and must never be demoted as a sign-off.
    assert.strictEqual(
      isSubstantive('Found it at public/app.js:112 — escapeAttr wraps escapeHtml and additionally encodes the double quote.'),
      true,
      'a one-line answer with content is not a sign-off');
    assert.strictEqual(isSubstantive('line one\nline two'), true, 'multi-line is substantive regardless of length');
    assert.strictEqual(isSubstantive('- a short bullet'), true, 'a list marker forces substantive');
    assert.strictEqual(isSubstantive('# heading'), true);
    assert.strictEqual(isSubstantive('```js\nx\n```'), true, 'a code fence forces substantive');
    assert.strictEqual(isSubstantive('| a | b |'), true, 'a table row forces substantive');
  });
});

describe('subagent lane open/close', () => {
  it('upgrades the Task tool_start row to kind:agent instead of duplicating it', () => {
    // Ordering guarantee: stream_tool_start for a Task always precedes its
    // stream_lane_open, and laneId === that same tool_use's toolId.
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_tool_start', {
      toolId: 'tu_07', toolName: 'Task', toolInput: { subagent_type: 'researcher', description: 'Audit auth' },
    }));
    ingest(run, ev('stream_lane_open', {
      laneId: 'tu_07', parentLane: 'main', agentType: 'researcher', label: 'Audit auth',
    }));

    const main = laneFor(run, 'main');
    assert.strictEqual(main.blocks.length, 1, 'must not create a second row for the same Task call');
    assert.strictEqual(main.blocks[0].kind, 'agent');
    assert.strictEqual(main.blocks[0].target, 'researcher');
    assert.strictEqual(main.blocks[0].caption, 'Audit auth');

    const sub = laneFor(run, 'tu_07');
    assert.strictEqual(sub.depth, 1);
    assert.strictEqual(sub.parentLane, 'main');
  });

  it('closes the agent card and marks it errored on a failed subagent', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_tool_start', { toolId: 'tu_09', toolName: 'Task', toolInput: { subagent_type: 'coder', description: 'Fix bug' } }));
    ingest(run, ev('stream_lane_open', { laneId: 'tu_09', parentLane: 'main', agentType: 'coder', label: 'Fix bug' }));
    ingest(run, ev('stream_lane_close', { laneId: 'tu_09', status: 'error', resultChars: 42 }));

    const main = laneFor(run, 'main');
    assert.strictEqual(main.blocks[0].state, 'err');
    assert.strictEqual(main.blocks[0].sealed, true);
    assert.strictEqual(main.blocks[0].output, '42 chars');
  });
});

describe('tool result counts', () => {
  it('tracks read/cmd counts and dedupes edits by resolved target path', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_tool_start', { toolId: 't1', toolName: 'Read', toolInput: { file_path: '/a.js' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't1', content: 'x', isError: false }));
    ingest(run, ev('stream_tool_start', { toolId: 't2', toolName: 'Edit', toolInput: { file_path: '/b.js' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't2', content: 'x', isError: false }));
    // same file edited twice — must dedupe to one entry in the Set
    ingest(run, ev('stream_tool_start', { toolId: 't3', toolName: 'Write', toolInput: { file_path: '/b.js' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't3', content: 'x', isError: false }));
    ingest(run, ev('stream_tool_start', { toolId: 't4', toolName: 'Bash', toolInput: { command: 'ls' } }));
    ingest(run, ev('stream_tool_result', { toolId: 't4', content: 'x', isError: true }));

    assert.strictEqual(run.counts.read, 1);
    assert.strictEqual(run.counts.cmd, 1);
    assert.strictEqual(run.counts.edit.size, 1);
    assert.ok(run.counts.edit.has('/b.js'));
    assert.strictEqual(run.counts.err, 1);
  });

  it('ignores a tool_result for a toolId that never started', () => {
    const run = createRun();
    const ev = emitter();
    const result = ingest(run, ev('stream_tool_result', { toolId: 'ghost', content: 'x', isError: false }));
    assert.strictEqual(result, null);
    assert.strictEqual(run.counts.read, 0);
  });
});

describe('stream_error / stream_fallback', () => {
  it('stream_error produces a note block and fails the run', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_error', { error: 'ECONNRESET' }));
    const lane = laneFor(run, 'main');
    assert.strictEqual(lane.blocks[0].kind, 'note');
    assert.strictEqual(lane.blocks[0].text, 'ECONNRESET');
    assert.strictEqual(run.status, 'fail');
  });

  it('stream_fallback produces a note block without touching run.status', () => {
    const run = createRun();
    const ev = emitter();
    ingest(run, ev('stream_fallback', { from: 'opus', to: 'claude-sonnet-5', reason: '429' }));
    const lane = laneFor(run, 'main');
    assert.strictEqual(lane.blocks[0].kind, 'note');
    assert.match(lane.blocks[0].text, /opus.*claude-sonnet-5.*429/);
    assert.strictEqual(run.status, 'live');
  });
});

describe('an empty run', () => {
  it('promoteVerdict on a run with no main lane at all returns a safe empty result', () => {
    const run = createRun();
    assert.strictEqual(run.lanes.size, 0);
    const result = promoteVerdict(run);
    assert.deepStrictEqual(result, { verdictId: null, signoffIds: [] });
  });

  it('a run that only ever sees stream_end produces no blocks and does not throw', () => {
    const run = createRun();
    const result = ingest(run, { type: 'stream_end', seq: 1, lane: 'main', isError: false });
    assert.strictEqual(run.status, 'ok');
    assert.deepStrictEqual(result, { verdictId: null, signoffIds: [] });
    assert.strictEqual(run.byId.size, 0);
  });
});
