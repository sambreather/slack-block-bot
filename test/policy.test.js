const test = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const { currentBlock, startCrons } = require('../src/schedule');
const { decide } = require('../src/policy');

const london = (iso) => DateTime.fromISO(iso, { zone: 'Europe/London' });

test('Monday 14:00–15:00 (GMT, winter)', () => {
  assert.ok(!currentBlock(london('2026-11-23T13:59')));
  const b = currentBlock(london('2026-11-23T14:00'));
  assert.equal(b.end.toFormat('HH:mm'), '15:00');
  assert.ok(currentBlock(london('2026-11-23T14:59')));
  assert.ok(!currentBlock(london('2026-11-23T15:00')));
});

test('Wednesday runs to 15:30', () => {
  assert.equal(currentBlock(london('2026-11-25T15:29')).end.toFormat('HH:mm'), '15:30');
  assert.ok(!currentBlock(london('2026-11-25T15:30')));
});

test('Friday block, and no block Tue/Thu/weekend', () => {
  assert.ok(currentBlock(london('2026-11-27T14:30')));
  for (const d of ['2026-11-24', '2026-11-26', '2026-11-28', '2026-11-29']) {
    assert.ok(!currentBlock(london(`${d}T14:30`)), d);
  }
});

test('British Summer Time is respected (UTC input)', () => {
  // 1 June 2026 is a Monday; 13:30 UTC = 14:30 BST -> in block
  assert.ok(currentBlock(DateTime.fromISO('2026-06-01T13:30Z')));
  // 14:30 UTC = 15:30 BST -> out
  assert.ok(!currentBlock(DateTime.fromISO('2026-06-01T14:30Z')));
});

test('cron expressions', () => {
  assert.deepEqual(startCrons(), ['0 14 * * 1', '0 14 * * 3', '0 14 * * 5']);
});

const inBlock = london('2026-11-23T14:10');
const outBlock = london('2026-11-23T15:10');
const msg = (extra = {}) => ({ type: 'message', user: 'U1', channel: 'D1', ts: '1.1', text: 'hey', ...extra });

test('message decisions', () => {
  const ctx = (now, isAuthorisedSender = true) => ({ now, isAuthorisedSender });
  assert.equal(decide(msg(), ctx(outBlock)).action, 'ignore');
  assert.equal(decide(msg(), ctx(inBlock)).action, 'hold');
  assert.equal(decide(msg(), ctx(inBlock, false)).action, 'nudge');
  assert.equal(decide(msg({ text: 'server down !URGENT' }), ctx(inBlock)).action, 'urgent');
  assert.equal(decide(msg({ subtype: 'file_share' }), ctx(inBlock)).action, 'nudge');
  assert.equal(decide(msg({ subtype: 'message_changed' }), ctx(inBlock)).action, 'ignore');
  assert.equal(decide(msg({ subtype: 'message_deleted' }), ctx(inBlock)).action, 'ignore');
  assert.equal(decide(msg({ bot_id: 'B1' }), ctx(inBlock)).action, 'ignore');
  assert.equal(decide(msg({ thread_ts: '0.9' }), ctx(inBlock)).action, 'hold');
});
