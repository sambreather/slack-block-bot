# Block Bot — Slack bot

Enforces the team's no-communication blocks (UK time):

| Day       | Block         |
|-----------|---------------|
| Monday    | 14:00 – 15:00 |
| Wednesday | 14:00 – 15:30 |
| Friday    | 14:00 – 15:00 |

**What it does for everyone who has connected their account**

- At the start of a block, turns on Do Not Disturb and sets the status
  *Block until 3pm* (both clear themselves when the block ends).
- If you send a message during a block, the bot removes it and re-sends it
  automatically, as you, the moment the block ends. The first time per block
  you get a private note: *It’s block time, your message will be delivered at 3pm. To bypass the block add !urgent to your message.*
- Include `!urgent` in a message and it goes straight through.
- Messages with files, or thread replies also sent to the channel, can't be
  held, so they go through and you get a reminder instead.
- People who haven't connected yet just get a reminder DM with a link to connect.

**Personal blocks (`/block`)**

Anyone connected can block their own time from any chat's message box:
`/block for 30 minutes`, `/block 5pm for an hour`, `/block from 2 till 4`,
`/block until 4.30`, `/block tomorrow 9am for 2 hours`, `/block Friday 10-12`,
`/block rest of the day`. Also `/block list` and `/block cancel`.

During a personal block: DND + status for that person; DMs sent to them by
connected people are held until the block ends (sender gets a note); people
who @mention them in a channel get a heads-up. Cancelling a block delivers
anything held straight away. "Rest of the day" means until `END_OF_DAY`
(default 17:30).

To change the blocks, edit `BLOCKS` in `src/schedule.js` and push.

## Setup

1. **Create the Slack app.** Go to https://api.slack.com/apps → *Create New App* →
   *From a manifest* → pick the workspace → paste `slack-manifest.yml`, with
   `slack-block-bot-production.up.railway.app` replaced by the Railway domain. If the workspace needs admin
   approval for apps, a Slack admin has to do or approve this step.
2. **Copy the secrets to Railway.** From *Basic Information* in the Slack app,
   copy the Client ID, Client Secret and Signing Secret into the Railway service
   variables `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`.
3. **Verify the events URL.** Back in Slack → *Event Subscriptions*, click
   *Retry* next to the Request URL until it shows *Verified*.
4. **Everyone connects.** Each person opens `https://slack-block-bot-production.up.railway.app/slack/install`
   and clicks *Allow*. It takes about 10 seconds.

## Environment variables

| Variable               | Purpose                                           |
|------------------------|---------------------------------------------------|
| `SLACK_CLIENT_ID`      | From the Slack app                                |
| `SLACK_CLIENT_SECRET`  | From the Slack app                                |
| `SLACK_SIGNING_SECRET` | From the Slack app                                |
| `STATE_SECRET`         | Any long random string                            |
| `DATA_DIR`             | Where tokens are stored (`/data` on a volume)     |
| `URGENT_KEYWORD`       | Optional, default `!urgent`                       |
| `STATUS_TEXT`          | Optional, default `Block until {time}`            |
| `NUDGE_MESSAGE`        | Optional, reminder when a message can't be held   |
| `PERSONAL_HOLD_MESSAGE` | Optional, note when a DM to a blocked person is held (`{name}`, `{time}`) |
| `PERSONAL_NUDGE_MESSAGE` | Optional, heads-up when a blocked person is messaged/mentioned |
| `END_OF_DAY`           | Optional, what "rest of the day" means, default `17:30` |
| `ALLOW_DMS`            | Pairs whose DMs to each other skip team blocks, e.g. `U06QZTKT7+U0B5PTTGRFH, U111+U222` |
| `HOLD_MESSAGE`         | Optional, default `It’s block time, your message will be delivered at {time}. To bypass the block add !urgent to your message.` |

`{time}` is replaced with the block's end time, e.g. `3pm` or `4.30pm`.

## Development

```
npm install
npm test
```

## Who's connected

Each time the bot starts, and whenever someone new connects, it writes a line
to the Railway deploy log: `Connected people (N): …`.
