// Quiet Hours bot for Slack.
//  - At the start of each quiet block: pauses notifications (DND) and sets a
//    "Quiet block" status for everyone who has connected the bot.
//  - During a block: messages from connected people are quietly held and
//    re-sent automatically, as them, the moment the block ends.
//  - Anything containing the urgent keyword (default "!urgent") goes through.
const { App, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const { TZ, currentBlock, startCrons } = require('./schedule');
const { decide, URGENT_KEYWORD } = require('./policy');
const store = require('./store');

const BOT_SCOPES = ['chat:write', 'im:write', 'users:read'];
const USER_SCOPES = [
  'chat:write',
  'dnd:write',
  'users.profile:write',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
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
        const block = currentBlock();
        if (block && installation.user?.token) {
          await quietUser(installation.user.id, installation.user.token, block);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('You’re connected ✅',
          'Quiet blocks will now pause your Slack notifications automatically, and anything you send during a block will be held and delivered when it ends. You can close this tab.'));
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
        res.end(page('Quiet Hours bot',
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

const fmt = (dt) => dt.setZone(TZ).toFormat('HH:mm');

// ---------------------------------------------------------------------------
// Block start: DND + status for every connected person
// ---------------------------------------------------------------------------
async function quietUser(userId, token, block) {
  const client = new WebClient(token);
  const minutes = Math.max(1, Math.ceil(block.end.diffNow('minutes').minutes));
  try {
    await client.dnd.setSnooze({ num_minutes: minutes });
    await client.users.profile.set({
      profile: {
        status_text: `Quiet block until ${fmt(block.end)}`,
        status_emoji: STATUS_EMOJI,
        status_expiration: Math.floor(block.end.toSeconds()),
      },
    });
    console.log(`Quietened ${userId} for ${minutes} min`);
  } catch (err) {
    console.error(`Could not quieten ${userId}:`, err.data?.error || err.message);
    if (['token_revoked', 'invalid_auth', 'account_inactive'].includes(err.data?.error)) {
      store.removeUser(userId);
    }
  }
}

async function startBlock() {
  const block = currentBlock();
  if (!block) return;
  const users = store.allUsers();
  console.log(`Quiet block started, ends ${fmt(block.end)}; ${users.length} connected user(s)`);
  await Promise.all(users.map((u) => quietUser(u.userId, u.token, block)));
}

for (const expr of startCrons()) {
  cron.schedule(expr, () => startBlock().catch(console.error), { timezone: TZ });
}

// ---------------------------------------------------------------------------
// During a block: hold messages, remind senders
// ---------------------------------------------------------------------------
const seen = new Map(); // `${channel}:${ts}` -> time seen (dedupe retries)
const toldThisBlock = new Map(); // userId -> block start ISO (one DM per block)

function firstTime(key) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

async function dmSender(userId, teamId, text, block) {
  const blockKey = block.start.toISO();
  if (toldThisBlock.get(userId) === blockKey) return;
  toldThisBlock.set(userId, blockKey);
  const botToken = store.getBotToken(teamId);
  if (!botToken) return;
  const bot = new WebClient(botToken);
  try {
    const { channel } = await bot.conversations.open({ users: userId });
    await bot.chat.postMessage({ channel: channel.id, text });
  } catch (err) {
    console.error('Could not DM sender:', err.data?.error || err.message);
  }
}

async function holdMessage(event, user, block) {
  const client = new WebClient(user.token);
  const postAt = Math.floor(block.end.toSeconds());
  const base = { channel: event.channel, post_at: postAt, text: event.text || ' ' };
  if (event.thread_ts) base.thread_ts = event.thread_ts;

  // 1. Schedule the copy first (keeping formatting if Slack accepts the blocks).
  let scheduled;
  try {
    scheduled = await client.chat.scheduleMessage(event.blocks ? { ...base, blocks: event.blocks } : base);
  } catch (err) {
    if (!event.blocks) throw err;
    scheduled = await client.chat.scheduleMessage(base);
  }

  // 2. Only then remove the original. If that fails, cancel the copy so nothing doubles up.
  try {
    await client.chat.delete({ channel: event.channel, ts: event.ts });
  } catch (err) {
    await client.chat
      .deleteScheduledMessage({ channel: event.channel, scheduled_message_id: scheduled.scheduled_message_id })
      .catch(() => {});
    throw err;
  }
}

app.event('message', async ({ event, body }) => {
  const teamId = body.team_id;
  if (!firstTime(`${event.channel}:${event.ts}`)) return;

  const sender = event.user ? store.getUser(event.user) : null;
  const decision = decide(event, { now: DateTime.now(), isAuthorisedSender: !!sender });
  if (decision.action === 'ignore' || decision.action === 'urgent') return;

  const { block } = decision;
  const until = fmt(block.end);

  if (decision.action === 'hold') {
    try {
      await holdMessage(event, sender, block);
      console.log(`Held message from ${event.user} in ${event.channel} until ${until}`);
      await dmSender(event.user, teamId,
        `:no_bell: It’s a quiet block until *${until}*. I’ve held your message and it’ll send automatically at ${until} — ` +
        `anything else you send before then will be held the same way.\n` +
        `If it really can’t wait, send it again with *${URGENT_KEYWORD}* in it.`, block);
      return;
    } catch (err) {
      console.error('Could not hold message:', err.data?.error || err.message);
      // fall through to a reminder
    }
  }

  await dmSender(event.user, teamId,
    `:no_bell: Heads up — it’s a quiet block until *${until}*, so people may not see your message until then. ` +
    (sender
      ? `(I couldn’t hold that one — messages with files or shared to a channel go straight through.)`
      :`<${publicUrl()}/slack/install|Connect your account> and the bot will hold messages for you automatically.`),
    block);
});

// Someone revoked access or the app was removed
app.event('tokens_revoked', async ({ event }) => {
  for (const id of event.tokens?.oauth || []) store.removeUser(id);
});

function publicUrl() {
  const d = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  return (d || '').replace(/\/$/, '');
}

(async () => {
  const port = Number(process.env.PORT) || 3000;
  await app.start(port);
  console.log(`Quiet Hours bot listening on ${port}; data in ${store.DATA_DIR}`);
  // If we (re)started mid-block, make sure everyone is quietened.
  await startBlock().catch(console.error);
})();
