// Pure decision logic for an incoming Slack message, kept separate so it
// can be unit-tested without Slack.
const { currentBlock } = require('./schedule');

const URGENT_KEYWORD = (process.env.URGENT_KEYWORD || '!urgent').toLowerCase();

/**
 * Decide what to do with a message event.
 * Returns one of:
 *   { action: 'ignore' }                 – not our business
 *   { action: 'urgent', block }          – sent during a block but flagged urgent
 *   { action: 'hold', block }            – hold it and re-send when the block ends
 *   { action: 'nudge', block }           – can't hold it (sender not set up / has files), just remind
 */
function decide(event, { now, isAuthorisedSender }) {
  if (!event || event.type !== 'message') return { action: 'ignore' };
  if (event.bot_id || event.subtype === 'bot_message') return { action: 'ignore' };

  // Edits, deletions, joins, etc. Only brand-new human messages matter.
  const allowedSubtypes = new Set([undefined, 'file_share', 'thread_broadcast']);
  if (!allowedSubtypes.has(event.subtype)) return { action: 'ignore' };
  if (!event.user) return { action: 'ignore' };

  const block = currentBlock(now);
  if (!block) return { action: 'ignore' };

  const text = (event.text || '').toLowerCase();
  if (text.includes(URGENT_KEYWORD)) return { action: 'urgent', block };

  const hasFiles = event.subtype === 'file_share' || (event.files && event.files.length > 0);
  if (isAuthorisedSender && !hasFiles && event.subtype !== 'thread_broadcast') {
    return { action: 'hold', block };
  }
  return { action: 'nudge', block };
}

module.exports = { decide, URGENT_KEYWORD };
