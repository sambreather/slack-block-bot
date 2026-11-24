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
const ALLOWED_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast']);

/** A brand-new message written by a person (not an edit, deletion, join, bot post…). */
function isNewHumanMessage(event) {
  if (!event || event.type !== 'message') return false;
  if (event.bot_id || event.subtype === 'bot_message') return false;
  if (!ALLOWED_SUBTYPES.has(event.subtype)) return false;
  return !!event.user;
}

/** Messages we can hold and re-send: plain text, no files, not a "also send to channel" reply. */
function canHold(event) {
  const hasFiles = event.subtype === 'file_share' || (event.files && event.files.length > 0);
  return !hasFiles && event.subtype !== 'thread_broadcast';
}

function isUrgent(event) {
  return (event.text || '').toLowerCase().includes(URGENT_KEYWORD);
}

function decide(event, { now, isAuthorisedSender }) {
  if (!isNewHumanMessage(event)) return { action: 'ignore' };

  const block = currentBlock(now);
  if (!block) return { action: 'ignore' };

  if (isUrgent(event)) return { action: 'urgent', block };

  if (isAuthorisedSender && canHold(event)) {
    return { action: 'hold', block };
  }
  return { action: 'nudge', block };
}

module.exports = { decide, isNewHumanMessage, canHold, isUrgent, URGENT_KEYWORD };
