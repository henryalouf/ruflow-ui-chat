/*
 * Replaying history for chats the CLI has never seen.
 *
 * The bug this guards against shipped and was caught in use: imported chats
 * displayed their full history in the UI while the model was spawned with none
 * of it, so asking "what were we working on" answered from nothing. The same
 * hole applied after edit/regenerate, which null the CLI session on purpose.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildHistoryPrompt, messageText } = require('../lib/conversation-history');

const u = (t) => ({ role: 'user', content: t });
const a = (t) => ({ role: 'assistant', content: t });

describe('buildHistoryPrompt', () => {
  it('returns null when there is nothing to replay', () => {
    assert.equal(buildHistoryPrompt([]), null);
    assert.equal(buildHistoryPrompt(null), null);
    assert.equal(buildHistoryPrompt(undefined), null);
    // Paired positive: a real conversation must NOT return null.
    assert.ok(buildHistoryPrompt([u('hello'), a('hi')]), 'a real history must produce a prompt');
  });

  it('renders both speakers in order', () => {
    const out = buildHistoryPrompt([u('what is the offering'), a('six services'), u('pick one')]);
    assert.match(out, /User: what is the offering/);
    assert.match(out, /Assistant: six services/);
    assert.ok(out.indexOf('what is the offering') < out.indexOf('six services'),
      'order must be preserved');
    assert.ok(out.indexOf('six services') < out.indexOf('pick one'));
  });

  it('keeps the END of a long conversation, not the beginning', () => {
    // The next reply depends on recent turns; dropping those to keep the
    // opening is exactly backwards, so assert the direction explicitly.
    const msgs = [];
    for (let i = 0; i < 60; i++) msgs.push(u('OLD-MESSAGE-' + i + ' ' + 'x'.repeat(500)));
    msgs.push(u('THE-MOST-RECENT-THING'));
    const out = buildHistoryPrompt(msgs, { budget: 3000 });

    assert.match(out, /THE-MOST-RECENT-THING/, 'the newest turn must survive');
    assert.ok(!out.includes('OLD-MESSAGE-0'), 'the oldest turn must be the one dropped');
    assert.match(out, /older message\(s\) omitted/, 'truncation must be disclosed, not silent');
    assert.ok(out.length < 3000 + 600, `budget should be respected (got ${out.length})`);
  });

  it('includes a single oversized message truncated rather than dropping it', () => {
    const out = buildHistoryPrompt([u('Y'.repeat(9000))], { budget: 2000 });
    assert.ok(out, 'must not return null');
    assert.match(out, /YYY/, 'the content must still appear');
    assert.match(out, /truncated/, 'the truncation must be marked');
  });

  it('skips turns with no prose instead of emitting empty speakers', () => {
    const out = buildHistoryPrompt([u('real question'), { role: 'assistant', content: '' }, a('real answer')]);
    assert.ok(!/Assistant: \n/.test(out), 'no empty Assistant line');
    assert.match(out, /real question/);
    assert.match(out, /real answer/);
  });

  it('recovers text from blocks[] when content is empty', () => {
    // Streamed turns store prose in blocks[], not content.
    const msg = { role: 'assistant', content: '', blocks: [
      { k: 'act', toolId: 't1' },
      { k: 'say', text: 'the answer lives in a block' },
    ]};
    assert.equal(messageText(msg), 'the answer lives in a block');
    assert.match(buildHistoryPrompt([u('q'), msg]), /the answer lives in a block/);
  });

  it('labels the block so the model treats it as its own memory', () => {
    const out = buildHistoryPrompt([u('hi'), a('hello')]);
    assert.match(out, /EARLIER CONVERSATION/);
    assert.match(out, /END EARLIER CONVERSATION/);
    assert.match(out, /your own memory/i);
  });
});
