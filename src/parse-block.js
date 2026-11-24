// Turns free-text like "5pm for an hour", "for 30 mins", "until 4.30",
// "tomorrow 9-11" or "Friday 10am for 2 hours" into a { start, end } block.
// All times are UK local time (Europe/London).
const { DateTime } = require('luxon');
const { TZ } = require('./schedule');

const MAX_HOURS = 12;
const MAX_DAYS_AHEAD = 14;
const DEFAULT_MINUTES = 60;
// What "rest of the day" / "end of day" means (UK time, HH:mm)
const END_OF_DAY = process.env.END_OF_DAY || '17:30';

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, 'forty-five': 45, fortyfive: 45, ninety: 90,
};
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const TIME = String.raw`(?:noon|midday|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)`;

function normalise(text) {
  return ` ${text} `
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/(\d{1,2})\.(\d{2})/g, '$1:$2') // 4.30 -> 4:30
    .replace(/\b(?:till|til|untill)\b/g, 'until')
    .replace(/\s*[–—]\s*/g, '-')
    .replace(/\s+/g, ' ');
}

/** "an hour and a half", "1h30", "90 mins", "1.5 hours", "half an hour" -> minutes */
function takeDuration(s) {
  const patterns = [
    [/\b(?:an?|one) hour and a half\b/, () => 90],
    [/\bhalf an? hour\b/, () => 30],
    [/\b(\d+)\s*h(?:ours?|rs?)?\s*(?:and\s*)?(\d+)\s*m(?:ins?|inutes?)?\b/, (m) => +m[1] * 60 + +m[2]],
    [/\b(\d+)h(\d{2})\b/, (m) => +m[1] * 60 + +m[2]],
    [/\b(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:-\s*)?(?:h|hr|hrs|hour|hours)\b/,
      (m) => Math.round(numberOf(m[1]) * 60)],
    [/\b(\d+|an?|one|five|ten|fifteen|twenty|thirty|forty-five|fortyfive|forty|ninety)\s*(?:-\s*)?(?:m|min|mins|minute|minutes)\b/,
      (m) => numberOf(m[1])],
  ];
  for (const [re, fn] of patterns) {
    const m = s.match(re);
    if (m) {
      const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\bfor\s*$/, '');
      return { minutes: fn(m), rest: rest.replace(/\bfor\b/g, ' ') };
    }
  }
  return { minutes: null, rest: s };
}

function numberOf(word) {
  if (/^\d/.test(word)) return parseFloat(word.replace(':', '.'));
  return WORD_NUMBERS[word] ?? NaN;
}

/** Day the block is on, plus whether the user named one explicitly. */
function takeDay(s, now) {
  if (/\btomorrow\b/.test(s)) return { day: now.plus({ days: 1 }).startOf('day'), explicit: true, rest: s.replace(/\btomorrow\b/, ' ') };
  if (/\b(?:today|tonight)\b/.test(s)) return { day: now.startOf('day'), explicit: true, rest: s.replace(/\b(?:today|tonight)\b/, ' ') };
  for (let i = 0; i < 7; i++) {
    const name = WEEKDAYS[i];
    const re = new RegExp(`\\b(?:(?:next|this|on)\\s+)?(?:${name}|${name.slice(0, 3)})\\b`);
    if (re.test(s)) {
      let diff = (i + 1 - now.weekday + 7) % 7;
      if (/\bnext\s/.test(s.match(re)[0]) && diff === 0) diff = 7;
      return { day: now.plus({ days: diff }).startOf('day'), explicit: true, rest: s.replace(re, ' ') };
    }
  }
  return { day: now.startOf('day'), explicit: false, rest: s };
}

/** "5", "5pm", "17:30", "noon" on `day`. Bare 1–7 are taken as afternoon. */
function timeOn(day, token, { afterHour } = {}) {
  const t = token.trim();
  if (t === 'noon' || t === 'midday') return day.set({ hour: 12, minute: 0 });
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = +m[1];
  const minute = m[2] ? +m[2] : 0;
  if (hour > 23 || minute > 59) return null;
  if (m[3] === 'pm' && hour < 12) hour += 12;
  else if (m[3] === 'am' && hour === 12) hour = 0;
  else if (!m[3] && hour >= 1 && hour <= 7) hour += 12; // "from 2 to 4" means afternoon
  if (!m[3] && afterHour != null && hour < afterHour && hour < 12) hour += 12; // "11-1" -> 11:00–13:00
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * Parse block text. Returns
 *   { ok: true, start, end, defaulted }   (luxon DateTimes in Europe/London)
 *   { ok: false, reason }
 */
function parseBlock(text, nowInput = DateTime.now()) {
  const now = nowInput.setZone(TZ).set({ second: 0, millisecond: 0 });
  let s = normalise(text);

  // "rest of the day", "end of day", "eod" -> until END_OF_DAY
  s = s.replace(/\b(?:for |until )?(?:the )?(?:rest of (?:the )?(?:day|afternoon)|end of (?:the )?day|eod)\b/, ` until ${END_OF_DAY} `);

  // "in 10 minutes" = start 10 minutes from now
  let offset = null;
  const inMatch = s.match(/\bin\s+((?:half an? hour)|(?:(?:\d+(?:\.\d+)?|an?|one|two|three|five|ten|fifteen|twenty|thirty|forty-five)\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)))\b/);
  if (inMatch) {
    offset = takeDuration(` ${inMatch[1]} `).minutes;
    s = s.replace(inMatch[0], ' ');
  }

  const dur = takeDuration(s);
  s = dur.rest;
  const dayInfo = takeDay(s, now);
  s = dayInfo.rest;
  const { day } = dayInfo;
  // Ignore filler words
  s = s.replace(/\b(?:block|me|please|pls|from|between|starting|start|at|in|the|morning|afternoon|evening|this|on|for|now|a)\b/g, ' ').replace(/\s+/g, ' ').trim();

  let start = null;
  let end = null;

  const range = s.match(new RegExp(`^(${TIME})\\s*(?:-|to|until|and)\\s*(${TIME})$`));
  const until = s.match(new RegExp(`^until\\s*(${TIME})$`));
  const single = s.match(new RegExp(`^(${TIME})$`));

  if (range) {
    start = timeOn(day, range[1]);
    end = start && timeOn(day, range[2], { afterHour: start.hour });
  } else if (until) {
    start = dayInfo.explicit && !day.hasSame(now, 'day') ? null : now;
    if (!start) return { ok: false, reason: 'Please say when it should start, e.g. `tomorrow 9am until 11am`.' };
    end = timeOn(day, until[1], { afterHour: now.hour });
  } else if (single) {
    start = timeOn(day, single[1]);
  } else if (s === '' && offset != null) {
    start = now.plus({ minutes: offset });
  } else if (s === '') {
    if (dur.minutes == null) {
      return { ok: false, reason: dayInfo.explicit ? 'Please add a time, e.g. `Thursday 10am for 2 hours`.' : null };
    }
    if (dayInfo.explicit && !day.hasSame(now, 'day')) {
      return { ok: false, reason: 'Please add a start time, e.g. `tomorrow 9am for 2 hours`.' };
    }
    start = now;
  } else {
    return { ok: false, reason: null };
  }

  if (!start || (range || until) && !end) return { ok: false, reason: null };

  let defaulted = false;
  if (!end) {
    const minutes = dur.minutes ?? DEFAULT_MINUTES;
    defaulted = dur.minutes == null;
    if (!(minutes > 0)) return { ok: false, reason: null };
    end = start.plus({ minutes });
  }

  // A start a few minutes ago just means "now".
  if (start < now && now.diff(start, 'minutes').minutes <= 10) start = now;
  if (start < now) {
    return { ok: false, reason: `${fmtTime(start)} has already passed today. Did you mean tomorrow? e.g. \`tomorrow ${text.trim()}\`` };
  }
  if (end <= start) return { ok: false, reason: 'The end time needs to be after the start time.' };
  if (end.diff(start, 'hours').hours > MAX_HOURS) return { ok: false, reason: `Blocks can be up to ${MAX_HOURS} hours long.` };
  if (start.diff(now, 'days').days > MAX_DAYS_AHEAD) return { ok: false, reason: `Blocks can be set up to ${MAX_DAYS_AHEAD} days ahead.` };

  return { ok: true, start, end, defaulted };
}

/** "3pm", "4.30pm" */
function fmtTime(dt) {
  const t = dt.setZone(TZ);
  const h = t.hour % 12 || 12;
  const m = t.minute ? `.${String(t.minute).padStart(2, '0')}` : '';
  return `${h}${m}${t.hour < 12 ? 'am' : 'pm'}`;
}

/** "today 5pm–6pm", "tomorrow 9am–11am", "Fri 28 Nov 10am–12pm" */
function fmtRange(start, end, now = DateTime.now()) {
  const s = start.setZone(TZ);
  const n = now.setZone(TZ);
  let day;
  if (s.hasSame(n, 'day')) day = 'today';
  else if (s.hasSame(n.plus({ days: 1 }), 'day')) day = 'tomorrow';
  else day = s.toFormat('ccc d LLL');
  return `${day} ${fmtTime(start)}–${fmtTime(end)}`;
}

module.exports = { parseBlock, fmtTime, fmtRange };
