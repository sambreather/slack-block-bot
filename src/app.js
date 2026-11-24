// Block Bot for Slack.
//
// Team blocks (see schedule.js):
//  - At the start of each block: pauses notifications (DND) and sets a
//    "Block until 3pm" status for everyone who has connected the bot.
//  - During a block: messages from connected people are held and re-sent
//    automatically, as them, the moment the block ends.
//
// Personal blocks (/block command):
//  - Anyone can block their own time, e.g. "/block 5pm for an hour".
//  - DND + status for them; DMs sent to them are held until their block ends;
//    people who @mention them get a heads-up.
//
// Anything containing the urgent keyword (default "!urgent") goes straight through.
const { App, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const { TZ, currentBlock, startCrons } = require('./schedule');
const { decide, isNewHumanMessage, canHold, isUrgent } = require('./policy');
const { parseBlock, fmtTime, fmtRange } = require('./parse-block');
const store = require('./store');

const BOT_SCOPES = ['chat:write', 'im:write', 'users:read', 'commands'];
const USER_SCOPES = [
  'chat:write',
  'dnd:write',
  'users.profile:write',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'im:read',
];

const STATUS_EMOJI = process.env.STATUS_EMOJI || ':no_bell:';

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.STATE_SECRET,
  scopes: BOT_SCOPES,
  installationStore: store.installationStore,
  logLevel: LogLevel.INFO,
  installerOptions: {
    userScopes: USER_SCOPES,
    directInstall: true,
    callbackOptions: {
      success: async (installation, _opts, _req, res) => {
        // If someone connects mid-block, quiet them straight away.
        if (installation.user?.token) {
          const end = effectiveEnd(installation.user.id);
          if (end) await quietUser(installation.user.id, installation.user.token);
        }
        logRoster().catch(console.error);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('You’re connected ✅',
          'Block times will now pause your Slack notifications automatically, and anything you send during a block will be held and delivered when it ends. You can close this tab.'));
      },
      failure: async (error, _opts, _req, res) => {
        console.error('Install failed', error);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Something went wrong', 'The connection didn’t complete. Please try the link again.'));
      },
    },
  },
  customRoutes: [
    {
      path: '/',
      method: ['GET'],
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Block Bot',
          'Running. <a href="/slack/install">Connect your Slack account</a>.'));
      },
    },
    {
      path: '/healthz',
      method: ['GET'],
      handler: (_req, res) => { res.writeHead(200); res.end('ok'); },
    },
  ],
});

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 20px;line-height:1.5">
<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;
}

const fmt = fmtTime; // "3pm", "4.30pm"

// Editable wording (set these as Railway variables to change them).
// {time} = when the block ends, {name} = the person who is blocked.
const STATUS_TEXT = process.env.STATUS_TEXT || 'Block until {time}';
const HOLD_MESSAGE = process.env.HOLD_MESSAGE || 'It’s block time, your message will be delivered at {time}. To bypass the block add !urgent to your message.';
const NUDGE_MESSAGE = process.env.NUDGE_MESSAGE || 'It’s block time until {time}, so people may not see your message until then. To bypass the block add !urgent to your message.';
const PERSONAL_HOLD_MESSAGE = process.env.PERSONAL_HOLD_MESSAGE || '{name} is in a block until {time}, your message will be delivered then. To bypass the block add !urgent to your message.';
const PERSONAL_NUDGE_MESSAGE = process.env.PERSONAL_NUDGE_MESSAGE || '{name} is in a block until {time}, so they may not see your message until then.';
const fill = (template, end, name = '') => template.replaceAll('{time}', fmt(end)).replaceAll('{name}', name);

const connectLink = () => `<${publicUrl()}/slack/install|Connect your account>`;

// ---------------------------------------------------------------------------
// Who is blocked, and until when
// ---------------------------------------------------------------------------
const toDT = (iso) => DateTime.fromISO(iso, { zone: TZ });

/** Active personal blocks right now: [{ userId, block, end }] */
function activePersonal(now = DateTime.now()) {
  const out = [];
  for (const [userId, blocks] of Object.entries(store.personalAll())) {
    for (const block of blocks) {
      const start = toDT(block.start);
      const end = toDT(block.end);
      if (start <= now && now < end) out.push({ userId, block, end });
    }
  }
  return out;
}

/** The latest moment this person should stay quiet until (team or personal), or null. */
function effectiveEnd(userId, now = DateTime.now()) {
  let end = currentBlock(now)?.end || null;
  for (const a of activePersonal(now)) {
    if (a.userId === userId && (!end || a.end > end)) end = a.end;
  }
  return end;
}

// ---------------------------------------------------------------------------
// DND + status
// ---------------------------------------------------------------------------
async function quietUser(userId, token) {
  const end = effectiveEnd(userId);
  if (!end) return;
  const client = new WebClient(token);
  const minutes = Math.max(1, Math.ceil(end.diffNow('minutes').minutes));
  try {
    await client.dnd.setSnooze({ num_minutes: minutes });
    await client.users.profile.set({
      profile: {
        status_text: fill(STATUS_TEXT, end),
        status_emoji: STATUS_EMOJI,
        status_expiration: Math.floor(end.toSeconds()),
      },
    });
    console.log(`Quietened ${userId} until ${fmt(end)}`);
  } catch (err) {
    console.error(`Could not quieten ${userId}:`, err.data?.error || err.message);
    if (['token_revoked', 'invalid_auth', 'account_inactive'].includes(err.data?.error)) {
      store.removeUser(userId);
    }
  }
}

async function unquietUser(userId, token) {
  const client = new WebClient(token);
  try {
    await client.dnd.endSnooze();
  } catch (err) {
    if (err.data?.error !== 'snooze_not_active') console.error(`endSnooze ${userId}:`, err.data?.error || err.message);
  }
  await client.users.profile.set({ profile: { status_text: '', status_emoji: '', status_expiration: 0 } })
    .catch((err) => console.error(`clear status ${userId}:`, err.data?.error || err.message));
}

async function startTeamBlock() {
  const block = currentBlock();
  if (!block) return;
  const users = store.allUsers();
  console.log(`Team block started, ends ${fmt(block.end)}; ${users.length} connected user(s)`);
  await Promise.all(users.map((u) => quietUser(u.userId, u.token)));
}

for (const expr of startCrons()) {
  cron.schedule(expr, () => startTeamBlock().catch(console.error), { timezone: TZ });
}

// Personal blocks: start any that are due (checked every 20 seconds).
let ticking = false;
async function tickPersonal() {
  if (ticking) return;
  ticking = true;
  try {
    const now = DateTime.now();
    store.prunePersonalBlocks(now.toUTC().toISO());
    for (const { userId, block } of activePersonal(now)) {
      if (block.started) continue;
      store.updatePersonalBlock(userId, block.id, (b) => { b.started = true; });
      const user = store.getUser(userId);
      if (!user) continue;
      console.log(`Personal block started for ${userId}, ends ${fmt(toDT(block.end))}`);
      dmChannels.delete(userId); // refresh their DM list
      await quietUser(userId, user.token);
    }
  } catch (err) {
    console.error('Personal block tick failed:', err);
  } finally {
    ticking = false;
  }
}
setInterval(tickPersonal, 20 * 1000);

// ---------------------------------------------------------------------------
// Finding out whether a DM is "to" someone in a personal block
// ---------------------------------------------------------------------------
const dmChannels = new Map(); // userId -> { ids: Set, at: ms }

async function dmChannelsOf(userId) {
  const cached = dmChannels.get(userId);
  if (cached && Date.now() - cached.at < 2 * 60 * 1000) return cached.ids;
  const ids = new Set();
  const user = store.getUser(userId);
  if (user && (user.scopes || []).includes('im:read')) {
    try {
      let cursor;
      do {
        const res = await new WebClient(user.token).conversations.list({ types: 'im', limit: 1000, cursor });
        for (const c of res.channels || []) ids.add(c.id);
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
    } catch (err) {
      console.error(`Could not list DMs for ${userId}:`, err.data?.error || err.message);
    }
  }
  dmChannels.set(userId, { ids, at: Date.now() });
  return ids;
}

async function isDmWith(userId, event, body) {
  // Fast path: Slack told us this event came via that person's connection.
  const authUsers = (body.authorizations || []).map((a) => a.user_id);
  if (authUsers.includes(userId)) return true;
  const ids = await dmChannelsOf(userId);
  return ids.has(event.channel);
}

const nameCache = new Map();
async function nameOf(userId, teamId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  let name = 'They';
  const botToken = store.getBotToken(teamId);
  if (botToken) {
    try {
      const { user } = await new WebClient(botToken).users.info({ user: userId });
      name = user.real_name || user.profile?.display_name || user.name || name;
    } catch { /* keep default */ }
  }
  nameCache.set(userId, name);
  return name;
}

// ---------------------------------------------------------------------------
// Holding messages and telling people
// ---------------------------------------------------------------------------
const seen = new Map(); // `${channel}:${ts}` -> time seen (dedupe retries)
const told = new Map(); // key -> time (one note per person per block)

function firstTime(key) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

async function dmOnce(userId, teamId, text, onceKey) {
  const now = Date.now();
  for (const [k, t] of told) if (now - t > 24 * 60 * 60 * 1000) told.delete(k);
  if (told.has(onceKey)) return;
  told.set(onceKey, now);
  await dmUser(userId, teamId, text);
}

async function dmUser(userId, teamId, text) {
  const botToken = store.getBotToken(teamId);
  if (!botToken) return;
  const bot = new WebClient(botToken);
  try {
    const { channel } = await bot.conversations.open({ users: userId });
    await bot.chat.postMessage({ channel: channel.id, text });
  } catch (err) {
    console.error('Could not DM user:', err.data?.error || err.message);
  }
}

/** Schedule a copy of the message for `until`, then delete the original. Returns the held record. */
async function holdMessage(event, sender, until) {
  const client = new WebClient(sender.token);
  const postAt = Math.floor(until.toSeconds());
  const base = { channel: event.channel, post_at: postAt, text: event.text || ' ' };
  if (event.thread_ts) base.thread_ts = event.thread_ts;

  let scheduled;
  try {
    scheduled = await client.chat.scheduleMessage(event.blocks ? { ...base, blocks: event.blocks } : base);
  } catch (err) {
    if (!event.blocks) throw err;
    scheduled = await client.chat.scheduleMessage(base);
  }

  try {
    await client.chat.delete({ channel: event.channel, ts: event.ts });
  } catch (err) {
    await client.chat
      .deleteScheduledMessage({ channel: event.channel, scheduled_message_id: scheduled.scheduled_message_id })
      .catch(() => {});
    throw err;
  }
  return {
    senderId: sender.userId,
    channel: event.channel,
    scheduledId: scheduled.scheduled_message_id,
    text: event.text || ' ',
    blocks: event.blocks || null,
    threadTs: event.thread_ts || null,
  };
}

/** Deliver a held message earlier: now, or at `until` if given. */
async function releaseHeld(held, until = null) {
  const sender = store.getUser(held.senderId);
  if (!sender) return;
  const client = new WebClient(sender.token);
  try {
    await client.chat.deleteScheduledMessage({ channel: held.channel, scheduled_message_id: held.scheduledId });
  } catch (err) {
    // Already sent or gone: nothing to do.
    console.error('Could not unschedule held message:', err.data?.error || err.message);
    return;
  }
  const msg = { channel: held.channel, text: held.text };
  if (held.threadTs) msg.thread_ts = held.threadTs;
  if (held.blocks) msg.blocks = held.blocks;
  const send = (m) => (until
    ? client.chat.scheduleMessage({ ...m, post_at: Math.floor(until.toSeconds()) })
    : client.chat.postMessage(m));
  await send(msg).catch(() => send({ ...msg, blocks: undefined }))
    .catch((err) => console.error('Could not release held message:', err.data?.error || err.message));
}

app.event('message', async ({ event, body }) => {
  const teamId = body.team_id;
  if (!firstTime(`${event.channel}:${event.ts}`)) return;
  if (!isNewHumanMessage(event)) return;

  const now = DateTime.now();
  const sender = store.getUser(event.user);
  const team = decide(event, { now, isAuthorisedSender: !!sender });
  if (team.action === 'urgent') return;

  // Is this a DM to, or a mention of, someone in a personal block?
  let dmTarget = null;
  let mentionTargets = [];
  if (!isUrgent(event)) {
    const active = activePersonal(now).filter((a) => a.userId !== event.user);
    if (active.length) {
      if (event.channel_type === 'im') {
        for (const a of active) {
          if (await isDmWith(a.userId, event, body)) { dmTarget = a; break; }
        }
      } else {
        const mentioned = new Set([...(event.text || '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]));
        mentionTargets = active.filter((a) => mentioned.has(a.userId));
      }
    }
  }

  // --- Team block in progress -------------------------------------------------
  if (team.action === 'hold' || team.action === 'nudge') {
    let until = team.block.end;
    if (dmTarget && dmTarget.end > until) until = dmTarget.end;
    if (team.action === 'hold') {
      try {
        const held = await holdMessage(event, sender, until);
        if (dmTarget && until === dmTarget.end) {
          store.updatePersonalBlock(dmTarget.userId, dmTarget.block.id, (b) => b.held.push(held));
        }
        console.log(`Held message from ${event.user} in ${event.channel} until ${fmt(until)}`);
        await dmOnce(event.user, teamId, fill(HOLD_MESSAGE, until), `team:${event.user}:${team.block.start.toISO()}`);
        return;
      } catch (err) {
        console.error('Could not hold message:', err.data?.error || err.message);
      }
    }
    await dmOnce(event.user, teamId,
      fill(NUDGE_MESSAGE, team.block.end) + (sender ? '' : `\n${connectLink()} and your messages will be held automatically.`),
      `team:${event.user}:${team.block.start.toISO()}`);
    return;
  }

  // --- No team block: personal blocks only -----------------------------------
  if (dmTarget) {
    const name = await nameOf(dmTarget.userId, teamId);
    const onceKey = `dm:${event.user}:${dmTarget.block.id}`;
    if (sender && canHold(event)) {
      try {
        const held = await holdMessage(event, sender, dmTarget.end);
        store.updatePersonalBlock(dmTarget.userId, dmTarget.block.id, (b) => b.held.push(held));
        console.log(`Held DM from ${event.user} to ${dmTarget.userId} until ${fmt(dmTarget.end)}`);
        await dmOnce(event.user, teamId, fill(PERSONAL_HOLD_MESSAGE, dmTarget.end, name), onceKey);
        return;
      } catch (err) {
        console.error('Could not hold DM:', err.data?.error || err.message);
      }
    }
    await dmOnce(event.user, teamId,
      fill(PERSONAL_NUDGE_MESSAGE, dmTarget.end, name) + (sender ? '' : `\n${connectLink()} and Block Bot can hold messages like this for you.`),
      onceKey);
    return;
  }

  for (const t of mentionTargets) {
    const name = await nameOf(t.userId, teamId);
    await dmOnce(event.user, teamId, fill(PERSONAL_NUDGE_MESSAGE, t.end, name), `mention:${event.user}:${t.block.id}`);
  }
});

// ---------------------------------------------------------------------------
// /block command
// ---------------------------------------------------------------------------
const EXAMPLES = [
  '`/block for 30 minutes`',
  '`/block 5pm for an hour`',
  '`/block from 2 till 4`',
  '`/block until 4.30`',
  '`/block tomorrow 9am for 2 hours`',
  '`/block Friday 10-12`',
  '`/block rest of the day`',
];

function helpText() {
  return [
    '*Block Bot: personal blocks*',
    'Block out your own time. Your notifications pause, your status updates, and DMs sent to you are held until your block ends.',
    '',
    `Try: ${EXAMPLES.join(' · ')}`,
    '`/block list` shows your blocks · `/block cancel` cancels them',
  ].join('\n');
}

function listText(userId) {
  const now = DateTime.now();
  const blocks = (store.personalAll()[userId] || []).filter((b) => toDT(b.end) > now);
  if (!blocks.length) return 'You have no personal blocks set.';
  return '*Your blocks:*\n' + blocks
    .map((b) => `• ${fmtRange(toDT(b.start), toDT(b.end), now)}${toDT(b.start) <= now ? ' _(now)_' : ''}`)
    .join('\n');
}

app.command('/block', async ({ command, ack }) => {
  const userId = command.user_id;
  const text = (command.text || '').trim();
  const lower = text.toLowerCase();
  const user = store.getUser(userId);
  const reply = (t) => ack({ response_type: 'ephemeral', text: t });

  if (!user) {
    return reply(`To use \`/block\`, first ${connectLink().replace('Connect', 'connect')} to Block Bot (takes 10 seconds), then try again.`);
  }
  if (!text || /^(help|\?)$/.test(lower)) return reply(`${helpText()}\n\n${listText(userId)}`);
  if (/^(list|status|show|mine)$/.test(lower)) return reply(listText(userId));

  if (/^(cancel|stop|end|clear|remove|delete|off|unblock)\b/.test(lower)) {
    const now = DateTime.now();
    const removed = store.cancelPersonalBlocks(userId).filter((b) => toDT(b.end) > now);
    if (!removed.length) return reply('You have no personal blocks to cancel.');
    await reply(`✅ Cancelled ${removed.length === 1 ? 'your block' : `${removed.length} blocks`}: ` +
      removed.map((b) => fmtRange(toDT(b.start), toDT(b.end), now)).join(', ') + '.');

    // Release anything held for them, and lift DND/status if nothing else applies.
    const teamBlock = currentBlock(now);
    for (const b of removed) {
      for (const held of b.held || []) await releaseHeld(held, teamBlock ? teamBlock.end : null);
    }
    if (removed.some((b) => b.started)) {
      if (effectiveEnd(userId)) await quietUser(userId, user.token); // a team block still applies
      else await unquietUser(userId, user.token);
    }
    return;
  }

  const parsed = parseBlock(text);
  if (!parsed.ok) {
    return reply(`${parsed.reason || 'Sorry, I didn’t understand that.'}\n\nTry: ${EXAMPLES.join(' · ')}`);
  }

  store.addPersonalBlock(userId, parsed.start.toUTC().toISO(), parsed.end.toUTC().toISO());
  const startsNow = parsed.start <= DateTime.now().plus({ minutes: 1 });
  const lines = [
    `✅ Blocked *${fmtRange(parsed.start, parsed.end)}*. ` +
      (startsNow ? 'Your notifications are paused' : 'Your notifications will pause') +
      ' and DMs sent to you will be held until then.',
  ];
  if (parsed.defaulted) lines.push('_You didn’t say how long, so I’ve set 1 hour._');
  if (!(user.scopes || []).includes('im:read')) {
    lines.push(`_To make sure every DM to you is held, please ${connectLink().replace('Connect your account', 'reconnect your account')} once._`);
  }
  lines.push('Type `/block cancel` to undo.');
  await reply(lines.join('\n'));
  if (startsNow) await tickPersonal();
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------
app.event('tokens_revoked', async ({ event }) => {
  for (const id of event.tokens?.oauth || []) store.removeUser(id);
});

async function logRoster() {
  const users = store.allUsers();
  const botToken = store.getBotToken();
  const names = await Promise.all(users.map(async (u) => {
    if (!botToken) return u.userId;
    try {
      const { user } = await new WebClient(botToken).users.info({ user: u.userId });
      return user.real_name || user.profile?.display_name || user.name || u.userId;
    } catch {
      return u.userId;
    }
  }));
  names.sort((a, b) => a.localeCompare(b));
  console.log(`Connected people (${names.length}): ${names.join(', ') || 'none'}`);
}

function publicUrl() {
  const d = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  return (d || '').replace(/\/$/, '');
}

(async () => {
  const port = Number(process.env.PORT) || 3000;
  await app.start(port);
  console.log(`Block Bot listening on ${port}; data in ${store.DATA_DIR}`);
  await logRoster().catch(console.error);
  // If we (re)started mid-block, make sure everyone is quietened.
  await startTeamBlock().catch(console.error);
  await tickPersonal();
})();
