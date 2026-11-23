// Quiet-block schedule and time helpers. All times are UK local time
// (Europe/London), so BST/GMT changes are handled automatically.
const { DateTime } = require('luxon');

const TZ = 'Europe/London';

// weekday: 1 = Monday ... 7 = Sunday (ISO). Times are "HH:mm".
const BLOCKS = [
  { weekday: 1, start: '14:00', end: '15:00' }, // Monday
  { weekday: 3, start: '14:00', end: '16:30' }, // Wednesday
  { weekday: 5, start: '14:00', end: '15:00' }, // Friday
];

function at(day, hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * If `now` falls inside a quiet block, returns { start, end } as luxon
 * DateTimes in Europe/London; otherwise null.
 */
function currentBlock(now = DateTime.now()) {
  const local = now.setZone(TZ);
  for (const b of BLOCKS) {
    if (local.weekday !== b.weekday) continue;
    const start = at(local, b.start);
    const end = at(local, b.end);
    if (local >= start && local < end) return { start, end };
  }
  return null;
}

/** Cron expressions (for node-cron, evaluated in Europe/London) for each block start. */
function startCrons() {
  return BLOCKS.map((b) => {
    const [h, m] = b.start.split(':').map(Number);
    return `${m} ${h} * * ${b.weekday % 7}`; // cron uses 0 = Sunday
  });
}

module.exports = { TZ, BLOCKS, currentBlock, startCrons };
