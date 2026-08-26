const { describe, it } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// Vector DB sync
//
// These cover the two failures that between them meant 22 chat sessions produced
// exactly one 384-character row in the shared AgentDB:
//
//   1. memories.source_path carries a UNIQUE index (idx_memories_source), and every
//      chat memory was written with the literal string 'ruflow-ui'. Each new
//      exchange collided with the last, INSERT OR REPLACE swallowed the collision,
//      and the sync reported success while overwriting the same single row.
//
//   2. Exchanges were paired by fixed even/odd position, which silently misaligns
//      every later pair the moment a session deviates from strict alternation.
//
// Both were invisible in the UI, which is why they need tests rather than a look.
// ---------------------------------------------------------------------------

/** Mirrors pairExchanges in server.js: pair each user with the NEXT assistant. */
function pairExchanges(messages) {
  const pairs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'user') continue;
    let j = i + 1;
    while (j < messages.length && messages[j]?.role !== 'assistant') j++;
    if (j < messages.length) pairs.push({ index: i, user: messages[i], assistant: messages[j] });
  }
  return pairs;
}

const sourcePathFor = (sessionId, index) => `ruflow-ui:${sessionId}:${index}`;

const u = (content) => ({ role: 'user', content });
const a = (content) => ({ role: 'assistant', content });

describe('vector sync — source_path uniqueness', () => {
  it('gives every exchange in a session its own source_path', () => {
    const paths = pairExchanges([u('q1'), a('a1'), u('q2'), a('a2'), u('q3'), a('a3')])
      .map(p => sourcePathFor('sess-A', p.index));
    assert.strictEqual(new Set(paths).size, 3, 'three exchanges must not collide');
  });

  it('does not collide across different sessions', () => {
    const all = [
      ...pairExchanges([u('q'), a('r')]).map(p => sourcePathFor('sess-A', p.index)),
      ...pairExchanges([u('q'), a('r')]).map(p => sourcePathFor('sess-B', p.index)),
    ];
    assert.strictEqual(new Set(all).size, 2, 'same position in two sessions must differ');
  });

  it('is stable across re-syncs so a grown session updates rather than duplicates', () => {
    const first = pairExchanges([u('q1'), a('a1'), u('q2'), a('a2')])
      .map(p => sourcePathFor('sess-A', p.index));
    const grown = pairExchanges([u('q1'), a('a1'), u('q2'), a('a2'), u('q3'), a('a3')])
      .map(p => sourcePathFor('sess-A', p.index));

    assert.deepStrictEqual(grown.slice(0, first.length), first,
      'existing exchanges keep their key, so the re-sync overwrites in place');
    assert.strictEqual(grown.length, 3);
  });

  it('rejects the old constant that caused the collision', () => {
    const paths = pairExchanges([u('q1'), a('a1'), u('q2'), a('a2')])
      .map(p => sourcePathFor('sess-A', p.index));
    assert.ok(!paths.includes('ruflow-ui'), 'a shared constant key silently overwrites');
  });
});

describe('vector sync — exchange pairing', () => {
  it('pairs a straightforward alternating conversation', () => {
    const pairs = pairExchanges([u('q1'), a('a1'), u('q2'), a('a2')]);
    assert.strictEqual(pairs.length, 2);
    assert.strictEqual(pairs[0].user.content, 'q1');
    assert.strictEqual(pairs[0].assistant.content, 'a1');
    assert.strictEqual(pairs[1].assistant.content, 'a2');
  });

  it('stays aligned when a user sends two messages in a row', () => {
    // Fixed even/odd pairing reads this as (q1,q2) and (a1,q3) — every pair wrong.
    const pairs = pairExchanges([u('q1'), u('q2'), a('a1'), u('q3'), a('a2')]);
    assert.strictEqual(pairs[0].assistant.content, 'a1');
    assert.strictEqual(pairs[1].assistant.content, 'a1');
    assert.strictEqual(pairs[2].user.content, 'q3');
    assert.strictEqual(pairs[2].assistant.content, 'a2',
      'the last exchange must still be paired correctly');
  });

  it('skips a trailing user message that has no reply yet', () => {
    const pairs = pairExchanges([u('q1'), a('a1'), u('q2')]);
    assert.strictEqual(pairs.length, 1, 'an in-flight turn is not indexed');
  });

  it('tolerates a system message in the middle', () => {
    const pairs = pairExchanges([u('q1'), { role: 'system', content: 's' }, a('a1')]);
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].assistant.content, 'a1');
  });

  it('returns nothing for an empty session', () => {
    assert.deepStrictEqual(pairExchanges([]), []);
  });
});
