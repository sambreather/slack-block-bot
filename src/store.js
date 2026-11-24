// Tiny JSON-file store for Slack installations (one bot token for the
// workspace + one user token per person who has clicked "Allow").
// Lives on a Railway volume (DATA_DIR) so it survives redeploys.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'installations.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { teams: {}, users: {} };
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/** Bolt InstallationStore implementation. */
const installationStore = {
  async storeInstallation(installation) {
    const db = load();
    const teamId = installation.team?.id;
    if (!teamId) throw new Error('Org-wide installs are not supported');
    if (installation.bot) db.teams[teamId] = installation; // keep latest bot token
    if (installation.user?.token) {
      db.users[installation.user.id] = {
        teamId,
        userId: installation.user.id,
        token: installation.user.token,
        scopes: installation.user.scopes || [],
        installedAt: new Date().toISOString(),
      };
    }
    save(db);
  },

  async fetchInstallation(query) {
    const db = load();
    const team = db.teams[query.teamId];
    if (!team) throw new Error(`No installation for team ${query.teamId}`);
    const result = { ...team };
    const user = query.userId && db.users[query.userId];
    result.user = user
      ? { id: user.userId, token: user.token, scopes: team.user?.scopes }
      : { id: query.userId, token: undefined, scopes: undefined };
    return result;
  },

  async deleteInstallation(query) {
    const db = load();
    if (query.userId) delete db.users[query.userId];
    else delete db.teams[query.teamId];
    save(db);
  },
};

function allUsers() {
  return Object.values(load().users);
}

function getUser(userId) {
  return load().users[userId] || null;
}

function getBotToken(teamId) {
  const db = load();
  const team = teamId ? db.teams[teamId] : Object.values(db.teams)[0];
  return team?.bot?.token || null;
}

function removeUser(userId) {
  const db = load();
  delete db.users[userId];
  save(db);
}

// ---------------------------------------------------------------------------
// Personal blocks: { [userId]: [{ id, start, end, started, held: [...] }] }
// start/end are ISO strings.
// ---------------------------------------------------------------------------
function personalAll() {
  return load().personal || {};
}

function addPersonalBlock(userId, start, end) {
  const db = load();
  db.personal = db.personal || {};
  const block = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, start, end, started: false, held: [] };
  (db.personal[userId] = db.personal[userId] || []).push(block);
  db.personal[userId].sort((a, b) => a.start.localeCompare(b.start));
  save(db);
  return block;
}

function updatePersonalBlock(userId, id, fn) {
  const db = load();
  const b = (db.personal?.[userId] || []).find((x) => x.id === id);
  if (!b) return null;
  fn(b);
  save(db);
  return b;
}

/** Remove a user's current and upcoming personal blocks; returns what was removed. */
function cancelPersonalBlocks(userId) {
  const db = load();
  const removed = db.personal?.[userId] || [];
  if (db.personal) delete db.personal[userId];
  save(db);
  return removed;
}

/** Drop blocks that ended more than an hour ago. */
function prunePersonalBlocks(nowIso) {
  const db = load();
  if (!db.personal) return;
  const cutoff = new Date(Date.parse(nowIso) - 60 * 60 * 1000).toISOString();
  let changed = false;
  for (const [userId, blocks] of Object.entries(db.personal)) {
    const keep = blocks.filter((b) => b.end > cutoff);
    if (keep.length !== blocks.length) changed = true;
    if (keep.length) db.personal[userId] = keep;
    else delete db.personal[userId];
  }
  if (changed) save(db);
}

module.exports = {
  installationStore, allUsers, getUser, getBotToken, removeUser, DATA_DIR,
  personalAll, addPersonalBlock, updatePersonalBlock, cancelPersonalBlocks, prunePersonalBlocks,
};
