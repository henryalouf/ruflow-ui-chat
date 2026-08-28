/* ---------------------------------------------------------------------------
 * Replaying a conversation the CLI has never seen.
 *
 * The only channel for prior turns is `claude --resume <cliSessionId>`. That
 * works for chats this app started, and fails silently for every chat where the
 * id is absent:
 *
 *   - imported chats (claude.ai history) have no CLI session at all;
 *   - handleEditMessage and handleRegenerate deliberately null it to branch.
 *
 * In both cases the UI keeps rendering the full history while the model is
 * spawned with none of it, so it answers as if the conversation just began.
 * That is the worst failure shape available: the interface says "remembered"
 * and the model behaves "forgotten", and nothing errors.
 *
 * This renders the stored messages into a transcript that can be injected into
 * the system prompt for exactly those turns. Once the CLI returns a session id,
 * --resume takes over and this stops being used.
 * ------------------------------------------------------------------------- */

const DEFAULT_BUDGET = 24000;

/** Pull readable text out of a stored message, whatever shape it was saved in. */
function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string' && m.content.trim()) return m.content.trim();
  // Older/streamed turns keep their prose in blocks[] instead of content.
  const blocks = m.blocks || m.toolBlocks || [];
  const parts = [];
  for (const b of blocks) {
    if (!b) continue;
    if (typeof b === 'string') { parts.push(b); continue; }
    if (b.k === 'say' && b.text) parts.push(b.text);
    else if (b.type === 'text' && b.text) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/**
 * @param {Array} messages stored session messages, oldest first
 * @param {{budget?:number, livePrompt?:string}} opts
 *   budget — character budget for the transcript.
 *   livePrompt — the message about to be sent. A trailing user turn identical
 *   to it is dropped, because it is about to arrive as the live prompt and
 *   would otherwise reach the model twice.
 * @returns {string|null} null when there is nothing worth replaying
 */
function buildHistoryPrompt(messages, { budget = DEFAULT_BUDGET, livePrompt } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  let list = messages;
  /*
   * Regenerate pops only the assistant reply and re-sends the user turn that is
   * still sitting in messages[], so on any chat without a CLI session — every
   * imported one — the same ask appeared once in the replayed transcript and
   * once as the live prompt.
   */
  if (livePrompt && typeof livePrompt === 'string') {
    const last = list[list.length - 1];
    if (last && last.role === 'user' && messageText(last) === livePrompt.trim()) {
      list = list.slice(0, -1);
      if (list.length === 0) return null;
    }
  }

  const rendered = [];
  for (const m of list) {
    const text = messageText(m);
    if (!text) continue;                       // tool-only turns carry no prose
    const who = m.role === 'assistant' ? 'Assistant' : 'User';
    rendered.push(`${who}: ${text}`);
  }
  if (rendered.length === 0) return null;

  /*
   * Keep the END of the conversation, not the start. When a history is too long
   * to fit, the recent turns are the ones the next reply depends on; dropping
   * them to preserve the opening is exactly backwards.
   */
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const entry = rendered[i];
    if (used + entry.length > budget && kept.length > 0) {
      dropped = i + 1;
      break;
    }
    // A single oversized message still gets included, truncated, rather than
    // silently vanishing.
    const piece = entry.length > budget ? entry.slice(0, budget) + '\n[…truncated]' : entry;
    kept.unshift(piece);
    used += piece.length;
  }

  const header = dropped > 0
    ? `--- EARLIER CONVERSATION (this chat's history; ${dropped} older message(s) omitted for length) ---`
    : "--- EARLIER CONVERSATION (this chat's history) ---";

  return [
    header,
    'This is what was already said in this conversation. Treat it as your own memory of it.',
    '',
    kept.join('\n\n'),
    '--- END EARLIER CONVERSATION ---',
  ].join('\n');
}

module.exports = { buildHistoryPrompt, messageText };
