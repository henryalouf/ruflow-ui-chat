const { describe, it } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// Turn text accumulation
//
// A turn that uses tools is several assistant messages, not one. With
// --include-partial-messages the CLI emits both token-level stream_event deltas
// AND a complete `assistant` message per message, so the accumulator has to
// merge two sources without dropping or duplicating anything.
//
// This mirrors the logic in server.js processStreamEvent. It is a pure function
// here so the failure mode below can be asserted directly.
//
// The bug it exists to prevent: `accumulatedText = fullText` assigned instead of
// appending, so each new assistant message overwrote the previous one. Nothing
// looked wrong in the browser — every token had already been delivered by the
// delta path — but accumulatedText is what gets written to the session file,
// passed to autoExtractMemory and synced to the vector DB. A 14-tool turn
// persisted as just its closing paragraph, and the loss was silent.
// ---------------------------------------------------------------------------

function createAccumulator() {
  let accumulatedText = '';
  let currentMessageText = '';
  const sent = [];

  return {
    /** stream_event → text_delta */
    delta(text) {
      accumulatedText += text;
      currentMessageText += text;
      sent.push(text);
    },
    /** a complete `assistant` event carrying one or more content blocks */
    assistantMessage(blocks) {
      for (const block of blocks) {
        if (block.type !== 'text') continue;
        const fullText = block.text || '';
        if (!fullText) continue;

        if (currentMessageText && fullText.startsWith(currentMessageText)) {
          const remainder = fullText.slice(currentMessageText.length);
          if (remainder) {
            accumulatedText += remainder;
            sent.push(remainder);
          }
          currentMessageText = fullText;
        } else {
          accumulatedText += fullText;
          sent.push(fullText);
          currentMessageText += fullText;
        }
      }
      currentMessageText = '';
    },
    get text() { return accumulatedText; },
    get sentToClient() { return sent.join(''); },
  };
}

describe('turn text accumulation', () => {
  it('keeps text from every assistant message in a tool-using turn', () => {
    const acc = createAccumulator();

    // Message 1: narration, then a tool call.
    for (const t of ['Let me ', 'search ', 'for that.']) acc.delta(t);
    acc.assistantMessage([{ type: 'text', text: 'Let me search for that.' }]);

    // (tool_use / tool_result happen here — no text)

    // Message 2: the conclusion, after the tool came back.
    for (const t of ['Found ', 'it.']) acc.delta(t);
    acc.assistantMessage([{ type: 'text', text: 'Found it.' }]);

    assert.strictEqual(acc.text, 'Let me search for that.Found it.',
      'text from the first message must survive the second');
  });

  it('does not re-send text the deltas already delivered', () => {
    const acc = createAccumulator();
    for (const t of ['Hello ', 'world']) acc.delta(t);
    acc.assistantMessage([{ type: 'text', text: 'Hello world' }]);

    assert.strictEqual(acc.sentToClient, 'Hello world', 'no duplication');
    assert.strictEqual(acc.text, 'Hello world');
  });

  it('still captures text when no deltas arrived (partial messages disabled)', () => {
    const acc = createAccumulator();
    acc.assistantMessage([{ type: 'text', text: 'First.' }]);
    acc.assistantMessage([{ type: 'text', text: 'Second.' }]);

    assert.strictEqual(acc.text, 'First.Second.');
    assert.strictEqual(acc.sentToClient, 'First.Second.');
  });

  it('handles a message split across several text blocks', () => {
    const acc = createAccumulator();
    for (const t of ['Part one. ']) acc.delta(t);
    acc.assistantMessage([
      { type: 'text', text: 'Part one. ' },
      { type: 'text', text: 'Part two.' },
    ]);

    assert.strictEqual(acc.text, 'Part one. Part two.');
    assert.strictEqual(acc.sentToClient, 'Part one. Part two.');
  });

  it('survives a long turn with many tool calls', () => {
    const acc = createAccumulator();
    const expected = [];

    for (let i = 0; i < 14; i++) {
      const line = `Step ${i}. `;
      acc.delta(line);
      acc.assistantMessage([{ type: 'text', text: line }]);
      expected.push(line);
    }
    acc.delta('Done.');
    acc.assistantMessage([{ type: 'text', text: 'Done.' }]);
    expected.push('Done.');

    assert.strictEqual(acc.text, expected.join(''),
      'a 14-tool turn must persist every step, not only the closing line');
  });

  it('ignores non-text blocks', () => {
    const acc = createAccumulator();
    acc.delta('Reading. ');
    acc.assistantMessage([
      { type: 'text', text: 'Reading. ' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    ]);
    assert.strictEqual(acc.text, 'Reading. ');
  });
});
