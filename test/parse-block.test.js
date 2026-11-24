const test = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const { parseBlock, fmtRange } = require('../src/parse-block');

// Tuesday 24 Nov 2026, 1:07pm UK time
const NOW = DateTime.fromISO('2026-11-24T13:07', { zone: 'Europe/London' });

function range(text, now = NOW) {
  const r = parseBlock(text, now);
  if (!r.ok) return `ERR ${r.reason ?? ''}`.trim();
  return fmtRange(r.start, r.end, now);
}

const cases = [
  // durations from now
  ['for 30 minutes', 'today 1.07pm–1.37pm'],
  ['30 mins', 'today 1.07pm–1.37pm'],
  ['half an hour', 'today 1.07pm–1.37pm'],
  ['1h', 'today 1.07pm–2.07pm'],
  ['an hour', 'today 1.07pm–2.07pm'],
  ['for an hour and a half', 'today 1.07pm–2.37pm'],
  ['1.5 hours', 'today 1.07pm–2.37pm'],
  ['1h30', 'today 1.07pm–2.37pm'],
  ['2 hours', 'today 1.07pm–3.07pm'],
  ['block me for 45 minutes please', 'today 1.07pm–1.52pm'],
  // start time + duration
  ['5pm 1h', 'today 5pm–6pm'],
  ['today at 5pm for 1 hour', 'today 5pm–6pm'],
  ['5pm for an hour', 'today 5pm–6pm'],
  ['at 3 for 30 mins', 'today 3pm–3.30pm'],
  ['4.30pm for 1 hour', 'today 4.30pm–5.30pm'],
  // ranges
  ['5pm-6pm', 'today 5pm–6pm'],
  ['from 5 till 6', 'today 5pm–6pm'],
  ['from 2:30 to 4', 'today 2.30pm–4pm'],
  ['between 3 and 4', 'today 3pm–4pm'],
  ['3–4.30', 'today 3pm–4.30pm'],
  // until
  ['until 4.30', 'today 1.07pm–4.30pm'],
  ['till 4:30pm', 'today 1.07pm–4.30pm'],
  ['until 3', 'today 1.07pm–3pm'],
  // other days
  ['tomorrow 9am 2h', 'tomorrow 9am–11am'],
  ['tomorrow morning 9-11', 'tomorrow 9am–11am'],
  ['tomorrow 11-1', 'tomorrow 11am–1pm'],
  ['Friday 10am for 2 hours', 'Fri 27 Nov 10am–12pm'],
  ['fri 2-4', 'Fri 27 Nov 2pm–4pm'],
  ['next tuesday 10-11', 'Tue 1 Dec 10am–11am'],
  ['tomorrow at noon for 30 mins', 'tomorrow 12pm–12.30pm'],
  // offsets and end of day
  ['in 10 minutes', 'today 1.17pm–2.17pm'],
  ['in 30 mins for 2 hours', 'today 1.37pm–3.37pm'],
  ['for the rest of the day', 'today 1.07pm–5.30pm'],
  ['until end of day', 'today 1.07pm–5.30pm'],
  ['for 1h 15m', 'today 1.07pm–2.22pm'],
  ['15:00-16:00', 'today 3pm–4pm'],
  ['17:00 for 20 mins', 'today 5pm–5.20pm'],
  // start only -> default 1 hour
  ['5pm', 'today 5pm–6pm'],
  ['at 1pm', 'today 1.07pm–2pm'], // just started: treated as now
];

for (const [input, expected] of cases) {
  test(`"${input}"`, () => assert.equal(range(input), expected));
}

test('defaulted flag when no length given', () => {
  assert.equal(parseBlock('5pm', NOW).defaulted, true);
  assert.equal(parseBlock('5pm 1h', NOW).defaulted, false);
});

test('errors', () => {
  assert.match(range('9am for 1 hour'), /already passed/);
  assert.match(range('tomorrow for 2 hours'), /start time/);
  assert.match(range('5pm-4pm'), /after the start/);
  assert.match(range('for 14 hours'), /up to 12 hours/);
  assert.match(range('thursday'), /add a time/);
  assert.equal(range('after lunch'), 'ERR');
  assert.equal(range('banana'), 'ERR');
});
