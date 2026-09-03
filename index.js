// Mock-Gov GDP Tracker Bot
// Requires only: View Channels, Read Message History, Send Messages, Embed Links
// No Message Content intent needed, no Administrator, no Manage Server.

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const Database = require('better-sqlite3');
const cron = require('node-cron');
require('dotenv').config();

// ---------- CONFIG ----------
const K_CONSTANT = 1;          // productivity calibration constant, keep identical across all servers you compare
const REPORT_CHANNEL_NAME = 'gdp-report'; // bot will post weekly report here if the channel exists
const HISTORY_CHANNEL_NAME = 'gdp-history'; // bot will post the daily GDP evolution chart here if the channel exists
const HISTORY_DAYS_SHOWN = 30; // how many days of history the daily chart displays
const ROLLING_WINDOW_DAYS = 7; // GDP looks back over this many trailing days, sliding daily — no hard weekly reset
const MONEY_PERM_ROLE_NAME = 'IMB-Permission'; // only members with a role of this exact name can run /setmoney (create this role in any server — any role with this exact name grants access there)
const MONEY_PERM_BYPASS_USER_IDS = ['487293928715059233']; // these user IDs can always run /setmoney, in any server, regardless of roles
const IMB_EMPLOYEE_IDS = ['487293928715059233']; // global whitelist (by user ID, not role) for the bank ledger commands: /currency-add, /balance-add, /balance-remove, /bank-balance
// -----------------------------

// Railway automatically sets RAILWAY_VOLUME_MOUNT_PATH whenever a volume is
// genuinely attached to this service, whatever path you chose for it in the
// dashboard — so we use that instead of assuming a hardcoded path like /data.
// If this variable is missing, no volume is attached to THIS service at all,
// and anything written to disk will be wiped on every restart/redeploy.
const fs = require('fs');
const volumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const usingPersistentVolume = !!volumeMountPath && fs.existsSync(volumeMountPath);
const dbPath = usingPersistentVolume ? `${volumeMountPath}/gdp.db` : 'gdp.db';
console.log(`[startup] RAILWAY_VOLUME_MOUNT_PATH=${volumeMountPath || '(not set)'}`);
console.log(`[startup] database path: ${dbPath} (persistent volume ${usingPersistentVolume ? 'FOUND — data will survive restarts' : 'NOT FOUND — data will be LOST on every restart/redeploy!'})`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS weekly_snapshot (
  guild_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  total_members INTEGER,
  active_members INTEGER,
  messages INTEGER,
  new_joins INTEGER,
  money_supply INTEGER,
  gdp REAL,
  PRIMARY KEY (guild_id, week_start)
);

CREATE TABLE IF NOT EXISTS money_supply (
  guild_id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  history_channel_id TEXT
);

CREATE TABLE IF NOT EXISTS currencies (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS user_balances (
  user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, currency)
);

CREATE TABLE IF NOT EXISTS bank_reserve (
  currency TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_history (
  guild_id TEXT NOT NULL,
  date TEXT NOT NULL,
  gdp REAL,
  total_members INTEGER,
  active_members INTEGER,
  messages INTEGER,
  new_joins INTEGER,
  money_supply INTEGER,
  PRIMARY KEY (guild_id, date)
);

CREATE TABLE IF NOT EXISTS daily_activity (
  guild_id TEXT NOT NULL,
  date TEXT NOT NULL,
  messages INTEGER,
  new_joins INTEGER,
  PRIMARY KEY (guild_id, date)
);

CREATE TABLE IF NOT EXISTS live_counter_snapshot (
  guild_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  messages INTEGER NOT NULL,
  new_joins INTEGER NOT NULL,
  active_senders TEXT NOT NULL
);
`);

// Diagnostic: log how much pre-existing data was found in the database at startup.
// If this shows all zeros right after a restart where you expect history, that
// confirms the database itself reset — almost always a persistent volume problem,
// not a bug in the tracking logic.
{
  const counts = {
    weekly_snapshot: db.prepare('SELECT COUNT(*) AS c FROM weekly_snapshot').get().c,
    daily_history: db.prepare('SELECT COUNT(*) AS c FROM daily_history').get().c,
    daily_activity: db.prepare('SELECT COUNT(*) AS c FROM daily_activity').get().c,
    money_supply: db.prepare('SELECT COUNT(*) AS c FROM money_supply').get().c,
    guild_settings: db.prepare('SELECT COUNT(*) AS c FROM guild_settings').get().c,
    currencies: db.prepare('SELECT COUNT(*) AS c FROM currencies').get().c,
    user_balances: db.prepare('SELECT COUNT(*) AS c FROM user_balances').get().c,
  };
  console.log('[startup] existing row counts:', JSON.stringify(counts));
}

// In-memory counters for the day currently in progress (since the last midnight-UTC
// rollover). Finalized into daily_activity at rollover, then reset to zero.
// Persisted to live_counter_snapshot on every change so a restart doesn't lose
// today's partial data — restored from there on startup.
// guildId -> { messages: number, activeSenders: Set<string>, newJoins: number }
const liveCounters = new Map();

// Saves the current in-progress-day counters for one guild to disk. Cheap
// (local SQLite write) — called after every message/join so a restart never
// loses more than the single event that was mid-flight.
function persistLiveCounter(guildId) {
  const counter = getCounter(guildId);
  db.prepare(`
    INSERT OR REPLACE INTO live_counter_snapshot (guild_id, date, messages, new_joins, active_senders)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, todayUTC(), counter.messages, counter.newJoins, JSON.stringify([...counter.activeSenders]));
}

// Restores today's counters from disk on startup. A saved row from a previous
// day is intentionally ignored (left at zero) since midnightRollover() already
// finalized that day — restoring it would double-count it.
function restoreLiveCounters() {
  const today = todayUTC();
  const rows = db.prepare('SELECT * FROM live_counter_snapshot').all();
  let restoredCount = 0;
  for (const row of rows) {
    if (row.date !== today) continue;
    liveCounters.set(row.guild_id, {
      messages: row.messages,
      newJoins: row.new_joins,
      activeSenders: new Set(JSON.parse(row.active_senders)),
    });
    restoredCount++;
  }
  console.log(`[startup] restored today's in-progress counters for ${restoredCount} guild(s)`);
}

function getCounter(guildId) {
  if (!liveCounters.has(guildId)) {
    liveCounters.set(guildId, { messages: 0, activeSenders: new Set(), newJoins: 0 });
  }
  return liveCounters.get(guildId);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// True if this interaction's member is allowed to run IMB-Permission-gated
// commands: either they hold the configured role in this server, or their
// user ID is in the bypass list (trusted across every server).
function hasImbPerm(interaction) {
  const isBypassed = MONEY_PERM_BYPASS_USER_IDS.includes(interaction.user.id);
  const hasPermRole = interaction.member.roles.cache.some((r) => r.name === MONEY_PERM_ROLE_NAME);
  return isBypassed || hasPermRole;
}

// True if this user is on the bank employee whitelist — a global user-ID list,
// not a per-server role, since bank ledger commands aren't scoped to one server.
function isImbEmployee(interaction) {
  return IMB_EMPLOYEE_IDS.includes(interaction.user.id);
}

function daysAgoUTC(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Sums messages/joins over the last ROLLING_WINDOW_DAYS days: the finalized days
// stored in daily_activity, plus today's still-in-progress live counters. This is
// what makes GDP a smooth sliding 7-day window instead of a hard weekly reset.
function getRollingTotals(guildId) {
  const windowStart = daysAgoUTC(ROLLING_WINDOW_DAYS - 1); // include today = window of N days total
  const rows = db.prepare(`
    SELECT messages, new_joins FROM daily_activity
    WHERE guild_id = ? AND date >= ? AND date < ?
  `).all(guildId, windowStart, todayUTC());

  const finalizedMessages = rows.reduce((sum, r) => sum + r.messages, 0);
  const finalizedJoins = rows.reduce((sum, r) => sum + r.new_joins, 0);

  const live = getCounter(guildId);

  return {
    messages: finalizedMessages + live.messages,
    newJoins: finalizedJoins + live.newJoins,
  };
}

function computeGDP({ messages, activeMembers, totalMembers, newJoins }) {
  // GDP = k * rolling_7day_messages * (1 + rolling_7day_new_joins / total_members)
  const growthModifier = 1 + (totalMembers > 0 ? newJoins / totalMembers : 0);
  return K_CONSTANT * messages * growthModifier;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers, // privileged intent: must be enabled in Dev Portal (see README)
    // NOTE: MessageContent intent intentionally NOT requested — we don't read text, only that a message occurred
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Tracking ${c.guilds.cache.size} guild(s): ${[...c.guilds.cache.values()].map(g => g.name).join(', ')}`);
  registerCommands(c.user.id);

  // Restore today's in-progress counters before anything else touches them —
  // otherwise the catch-up logic below would compute stats from empty counters.
  restoreLiveCounters();

  // Self-healing catch-up: if today's daily-history data point is missing for any
  // guild (e.g. because the container restarted right at the scheduled cron time
  // and the tick was skipped), record it now instead of waiting until tomorrow.
  try {
    const today = new Date().toISOString().slice(0, 10);
    let ranCatchUp = false;
    for (const [, guild] of c.guilds.cache) {
      const existing = db.prepare(
        'SELECT 1 FROM daily_history WHERE guild_id = ? AND date = ?'
      ).get(guild.id, today);
      if (!existing) {
        console.log(`[startup-catchup] missing today's history for ${guild.name}, recording now`);
        ranCatchUp = true;
      }
    }
    if (ranCatchUp) {
      await recordDailyHistoryAndPostChart();
    }
  } catch (err) {
    console.error('[startup-catchup] failed:', err);
  }

  // Same self-healing idea for the rolling snapshot: if today's row is missing
  // for any guild, refresh it now rather than waiting for the next scheduled post.
  try {
    const today = todayUTC();
    for (const [, guild] of c.guilds.cache) {
      const existing = db.prepare(
        'SELECT 1 FROM weekly_snapshot WHERE guild_id = ? AND week_start = ?'
      ).get(guild.id, today);
      if (!existing) {
        console.log(`[startup-catchup] missing today's snapshot for ${guild.name}, recording now`);
        refreshSnapshotForGuild(guild);
      }
    }
  } catch (err) {
    console.error('[startup-catchup] snapshot check failed:', err);
  }

  // Diagnostic only (not recoverable): if yesterday's daily_activity row is missing,
  // that day's message/join counts were lost — most likely a restart wiped the live
  // in-memory counters before midnightRollover() could finalize them. The rolling
  // GDP sum simply treats a missing day as 0, so this degrades gracefully, but it's
  // worth knowing about if GDP looks lower than expected.
  try {
    const yesterday = daysAgoUTC(1);
    for (const [, guild] of c.guilds.cache) {
      const existing = db.prepare(
        'SELECT 1 FROM daily_activity WHERE guild_id = ? AND date = ?'
      ).get(guild.id, yesterday);
      if (!existing) {
        console.log(`[startup-catchup] note: no finalized activity for ${guild.name} on ${yesterday} — likely lost to a restart, counted as 0 in the rolling window`);
      }
    }
  } catch (err) {
    console.error('[startup-catchup] daily_activity check failed:', err);
  }
});

// Count a message without reading its content
client.on(Events.MessageCreate, (message) => {
  if (!message.guild || message.author.bot) return;
  const counter = getCounter(message.guild.id);
  counter.messages += 1;
  counter.activeSenders.add(message.author.id);
  persistLiveCounter(message.guild.id);
});

// Count new joins
client.on(Events.GuildMemberAdd, (member) => {
  const counter = getCounter(member.guild.id);
  counter.newJoins += 1;
  persistLiveCounter(member.guild.id);
});

// ---------- Retroactive backfill ----------
// Fires automatically the moment the bot joins a new server, so historical
// activity from before the bot was added isn't lost. Also triggerable manually
// via /backfill for servers the bot was already in before this feature existed.
const backfillInProgress = new Set();

client.on(Events.GuildCreate, (guild) => {
  console.log(`[backfill] joined new guild ${guild.name} — starting automatic backfill`);
  backfillGuildActivity(guild).catch((err) => console.error(`[backfill] failed for ${guild.name}:`, err));
});

async function backfillGuildActivity(guild) {
  if (backfillInProgress.has(guild.id)) {
    console.log(`[backfill] already running for ${guild.name}, skipping duplicate request`);
    return { alreadyRunning: true };
  }
  backfillInProgress.add(guild.id);

  try {
    const cutoffTime = Date.now() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const today = todayUTC();

    const perDayMessages = new Map(); // date -> count
    const perDayActiveSenders = new Map(); // date -> Set<userId>
    const perDayJoins = new Map(); // date -> count

    // --- Backfill joins from the member list (needs Server Members Intent, already enabled) ---
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      if (!member.joinedTimestamp || member.joinedTimestamp < cutoffTime) continue;
      const date = new Date(member.joinedTimestamp).toISOString().slice(0, 10);
      perDayJoins.set(date, (perDayJoins.get(date) || 0) + 1);
    }

    // --- Backfill messages by paginating each readable text channel's history ---
    const channels = guild.channels.cache.filter(
      (ch) => ch.isTextBased() && !ch.isThread() && ch.viewable
    );

    for (const channel of channels.values()) {
      let lastId;
      let reachedCutoff = false;

      while (!reachedCutoff) {
        let batch;
        try {
          batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        } catch (err) {
          console.error(`[backfill] could not read #${channel.name} in ${guild.name}:`, err.message);
          break;
        }
        if (batch.size === 0) break;

        for (const msg of batch.values()) {
          if (msg.createdTimestamp < cutoffTime) {
            reachedCutoff = true;
            break;
          }
          if (msg.author.bot) continue;
          const date = new Date(msg.createdTimestamp).toISOString().slice(0, 10);
          perDayMessages.set(date, (perDayMessages.get(date) || 0) + 1);
          if (date === today) {
            if (!perDayActiveSenders.has(date)) perDayActiveSenders.set(date, new Set());
            perDayActiveSenders.get(date).add(msg.author.id);
          }
        }

        lastId = batch.last()?.id;
        if (batch.size < 100) break;
      }
      console.log(`[backfill] scanned #${channel.name} in ${guild.name}`);
    }

    // --- Write finalized (pre-today) days directly into daily_activity ---
    const allDates = new Set([...perDayMessages.keys(), ...perDayJoins.keys()]);
    for (const date of allDates) {
      if (date === today) continue; // today is handled via the live counter, not daily_activity
      db.prepare(`
        INSERT OR REPLACE INTO daily_activity (guild_id, date, messages, new_joins)
        VALUES (?, ?, ?, ?)
      `).run(guild.id, date, perDayMessages.get(date) || 0, perDayJoins.get(date) || 0);
    }

    // --- Merge today's portion into the live in-memory counter (overwrite, since this
    // is a fresh authoritative scan of everything that's happened today so far) ---
    liveCounters.set(guild.id, {
      messages: perDayMessages.get(today) || 0,
      activeSenders: perDayActiveSenders.get(today) || new Set(),
      newJoins: perDayJoins.get(today) || 0,
    });
    persistLiveCounter(guild.id);

    // --- Retroactively populate the evolution chart for the backfilled days too ---
    const sortedDates = [...allDates].sort();
    for (const date of sortedDates) {
      // Rolling sum over the trailing window ending at `date`. For past days, their
      // own daily_activity row was just written above, so this sum already includes
      // it. For today, no daily_activity row exists yet — add its live count separately.
      const rows = db.prepare(`
        SELECT messages, new_joins FROM daily_activity
        WHERE guild_id = ? AND date > ? AND date <= ?
      `).all(guild.id, dateNDaysBefore(date, ROLLING_WINDOW_DAYS - 1), date);

      let rollingMessages = rows.reduce((s, r) => s + r.messages, 0);
      let rollingJoins = rows.reduce((s, r) => s + r.new_joins, 0);
      if (date === today) {
        rollingMessages += perDayMessages.get(date) || 0;
        rollingJoins += perDayJoins.get(date) || 0;
      }

      const totalMembers = guild.memberCount; // best available — historical member count isn't known
      const gdp = computeGDP({ messages: rollingMessages, activeMembers: 0, totalMembers, newJoins: rollingJoins });

      db.prepare(`
        INSERT OR REPLACE INTO daily_history
        (guild_id, date, gdp, total_members, active_members, messages, new_joins, money_supply)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(guild.id, date, gdp, totalMembers, null, rollingMessages, rollingJoins, null);
    }

    refreshSnapshotForGuild(guild);

    const totalMessagesFound = [...perDayMessages.values()].reduce((s, v) => s + v, 0);
    console.log(`[backfill] done for ${guild.name}: ${totalMessagesFound} messages, ${allDates.size} day(s) across ${channels.size} channel(s)`);
    return { messagesFound: totalMessagesFound, daysFound: allDates.size, channelsScanned: channels.size };
  } finally {
    backfillInProgress.delete(guild.id);
  }
}

// Returns the ISO date string `n` days before the given ISO date string.
function dateNDaysBefore(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------- Midnight rollover (daily, not weekly) ----------
// Runs every day at 00:00 UTC. Finalizes the day that just ended into daily_activity,
// then resets live counters so a new day starts collecting from zero. This — plus the
// rolling 7-day sum in getRollingTotals — is what makes GDP slide smoothly day to day
// instead of resetting hard once a week.
cron.schedule('0 0 * * *', async () => {
  console.log(`[midnight-rollover] cron fired at ${new Date().toISOString()}`);
  try {
    await midnightRollover();
  } catch (err) {
    console.error('[midnight-rollover] failed:', err);
  }
}, { timezone: 'UTC' });

async function midnightRollover() {
  const finishedDay = daysAgoUTC(1); // the calendar day that just ended, UTC
  for (const [, guild] of client.guilds.cache) {
    const counter = getCounter(guild.id);
    db.prepare(`
      INSERT OR REPLACE INTO daily_activity (guild_id, date, messages, new_joins)
      VALUES (?, ?, ?, ?)
    `).run(guild.id, finishedDay, counter.messages, counter.newJoins);

    liveCounters.set(guild.id, { messages: 0, activeSenders: new Set(), newJoins: 0 });
    persistLiveCounter(guild.id);
  }
  console.log(`[midnight-rollover] finalized ${finishedDay} for ${client.guilds.cache.size} guild(s)`);
}

// ---------- Weekly summary report (posting cadence only — no reset anymore) ----------
// Runs every Sunday at 00:05 UTC. Just posts the current rolling snapshot to
// #gdp-report as a periodic digest — the underlying data is never reset here.
cron.schedule('5 0 * * 0', async () => {
  console.log(`[weekly-snapshot] cron fired at ${new Date().toISOString()}`);
  try {
    await snapshotAllGuilds();
  } catch (err) {
    console.error('[weekly-snapshot] job failed:', err);
  }
}, { timezone: 'UTC' });

// ---------- Daily history + chart job ----------
// Runs every day at 00:10 UTC. Records one data point per guild, then posts an
// updated GDP-evolution line chart to that guild's configured channel (set via
// /set-gdp-history), falling back to any channel named HISTORY_CHANNEL_NAME.
cron.schedule('10 0 * * *', async () => {
  console.log(`[daily-history] cron fired at ${new Date().toISOString()}`);
  try {
    await recordDailyHistoryAndPostChart();
  } catch (err) {
    console.error('[daily-history] job failed:', err);
  }
}, { timezone: 'UTC' });

// Resolves which channel to post the daily chart in for a guild: the explicitly
// configured channel (via /set-gdp-history) if it still exists and is postable,
// otherwise falls back to name-matching HISTORY_CHANNEL_NAME for servers that
// haven't set one explicitly yet.
function getHistoryChannelForGuild(guild) {
  const row = db.prepare('SELECT history_channel_id FROM guild_settings WHERE guild_id = ?').get(guild.id);
  if (row && row.history_channel_id) {
    const configured = guild.channels.cache.get(row.history_channel_id);
    if (configured && configured.isTextBased()) return configured;
  }
  return guild.channels.cache.find((ch) => ch.name === HISTORY_CHANNEL_NAME && ch.isTextBased()) || null;
}

async function recordDailyHistoryAndPostChart() {
  for (const [, guild] of client.guilds.cache) {
    recordDailyHistoryForGuild(guild);
  }
  console.log(`[daily-history] recorded data for ${client.guilds.cache.size} guild(s)`);

  let attachment;
  try {
    attachment = await buildHistoryChartAttachment();
  } catch (err) {
    console.error('[daily-history] chart render failed:', err);
    return;
  }
  if (!attachment) {
    console.log('[daily-history] no chart built — no history rows yet');
    return;
  }

  for (const [, guild] of client.guilds.cache) {
    const channel = getHistoryChannelForGuild(guild);
    if (!channel) continue;

    const embed = new EmbedBuilder()
      .setTitle('📉 GDP Evolution — Last ' + HISTORY_DAYS_SHOWN + ' Days')
      .setImage(`attachment://${attachment.name}`)
      .setColor(0xe67e22)
      .setTimestamp();

    channel.send({ embeds: [embed], files: [attachment] })
      .then(() => console.log(`[daily-history] posted chart in ${guild.name}#${channel.name}`))
      .catch((err) => console.error(`[daily-history] failed to post in ${guild.name}#${channel.name}:`, err));
  }
}

// Pulls the last HISTORY_DAYS_SHOWN days of history for every guild and builds
// a multi-line QuickChart URL (one line per server).
// Posts the chart config to QuickChart's render API and returns the raw PNG bytes.
// Using a POST + Buffer instead of a GET URL avoids Discord's 2048-char embed image
// URL limit entirely — the config can grow as large as it needs to (more servers,
// more days) without ever hitting that ceiling.
async function renderChartPng(config, width, height) {
  const response = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chart: config, width, height, backgroundColor: 'white', format: 'png' }),
  });
  if (!response.ok) {
    throw new Error(`QuickChart render failed: ${response.status} ${await response.text()}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function buildHistoryChartAttachment() {
  const rows = db.prepare(`
    SELECT * FROM daily_history
    WHERE date >= date('now', '-${HISTORY_DAYS_SHOWN} days')
    ORDER BY date ASC
  `).all();

  if (rows.length === 0) return null;

  // Collect the sorted set of unique dates (shared x-axis) and unique guilds (one line each).
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const guildIds = [...new Set(rows.map((r) => r.guild_id))];

  const colors = ['#9b59b6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c', '#1abc9c', '#f1c40f', '#34495e'];

  const datasets = guildIds.map((guildId, i) => {
    const guild = client.guilds.cache.get(guildId);
    const name = guild ? truncate(guild.name, 18) : guildId;
    const byDate = new Map(rows.filter((r) => r.guild_id === guildId).map((r) => [r.date, r.gdp]));
    return {
      label: name,
      data: dates.map((d) => (byDate.has(d) ? Number(byDate.get(d).toFixed(2)) : null)),
      borderColor: colors[i % colors.length],
      backgroundColor: colors[i % colors.length],
      fill: false,
      spanGaps: true,
    };
  });

  const config = {
    type: 'line',
    data: { labels: dates, datasets },
    options: {
      title: { display: true, text: 'Mock-Gov GDP Evolution' },
      scales: {
        xAxes: [{ ticks: { autoSkip: true, maxTicksLimit: 10 } }],
      },
    },
  };

  const buffer = await renderChartPng(config, 700, 400);
  return new AttachmentBuilder(buffer, { name: 'gdp-history.png' });
}

// Pure computation of current stats for one guild (no DB write).
// messages/newJoins used for GDP are a ROLLING 7-day sum (finalized days + today's
// live partial) — active members is today's live count only (not part of the GDP formula).
function computeGuildStats(guild) {
  const guildId = guild.id;
  const totalMembers = guild.memberCount;
  const activeMembers = getCounter(guildId).activeSenders.size;

  const { messages, newJoins } = getRollingTotals(guildId);

  const moneyRow = db.prepare('SELECT amount FROM money_supply WHERE guild_id = ?').get(guildId);
  const moneySupply = moneyRow ? moneyRow.amount : null;

  const gdp = computeGDP({ messages, activeMembers, totalMembers, newJoins });

  return { totalMembers, activeMembers, messages, newJoins, moneySupply, gdp };
}

// Computes current rolling stats for one guild and upserts today's snapshot row.
// Safe to call anytime (e.g. right after /setmoney) — there's no weekly reset anymore,
// just a continuously-updated rolling snapshot keyed by today's date.
function refreshSnapshotForGuild(guild) {
  const guildId = guild.id;
  const asOfDate = todayUTC();
  const stats = computeGuildStats(guild);

  db.prepare(`
    INSERT OR REPLACE INTO weekly_snapshot
    (guild_id, week_start, total_members, active_members, messages, new_joins, money_supply, gdp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, asOfDate, stats.totalMembers, stats.activeMembers, stats.messages, stats.newJoins, stats.moneySupply, stats.gdp);

  return stats;
}

// Records one day's GDP data point for one guild — independent of the weekly snapshot,
// used to build the day-by-day evolution chart. Does not reset counters either.
function recordDailyHistoryForGuild(guild) {
  const guildId = guild.id;
  const today = todayUTC();
  const stats = computeGuildStats(guild);

  db.prepare(`
    INSERT OR REPLACE INTO daily_history
    (guild_id, date, gdp, total_members, active_members, messages, new_joins, money_supply)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, today, stats.gdp, stats.totalMembers, stats.activeMembers, stats.messages, stats.newJoins, stats.moneySupply);

  return stats;
}

async function snapshotAllGuilds() {
  for (const [, guild] of client.guilds.cache) {
    const stats = refreshSnapshotForGuild(guild);
    await postReport(guild, stats);
    // No counter reset here anymore — the rolling window slides daily via
    // midnightRollover(), not via a weekly reset.
  }
}

async function postReport(guild, stats) {
  const channel = guild.channels.cache.find(
    (ch) => ch.name === REPORT_CHANNEL_NAME && ch.isTextBased()
  );
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`📊 Economic Report — ${guild.name}`)
    .addFields(
      { name: 'Total Members', value: `${stats.totalMembers}`, inline: true },
      { name: 'Active Members (today)', value: `${stats.activeMembers}`, inline: true },
      { name: `New Joins (${ROLLING_WINDOW_DAYS}d rolling)`, value: `${stats.newJoins}`, inline: true },
      { name: `Messages (${ROLLING_WINDOW_DAYS}d rolling)`, value: `${stats.messages}`, inline: true },
      { name: 'Money Supply', value: stats.moneySupply != null ? `${stats.moneySupply}` : 'not set (use /setmoney)', inline: true },
      { name: 'Estimated GDP', value: `${stats.gdp.toFixed(2)}`, inline: true },
    )
    .setColor(0x2ecc71)
    .setTimestamp();

  channel.send({ embeds: [embed] }).catch(() => {});
}

// ---------- Slash commands ----------
async function registerCommands(clientId) {
  const commands = [
    new SlashCommandBuilder()
      .setName('gdp')
      .setDescription('Show current rolling stats and estimated GDP for a server')
      .addStringOption((opt) =>
        opt.setName('target_guild')
          .setDescription('Which server to check — leave blank for the server you\'re in right now')
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName('globalstats')
      .setDescription('Show latest weekly snapshot for every server this bot tracks (usable from any server)'),
    new SlashCommandBuilder()
      .setName('gdphistory')
      .setDescription('Show the GDP evolution chart across tracked servers right now'),
    new SlashCommandBuilder()
      .setName('backfill')
      .setDescription(`Scan the last ${ROLLING_WINDOW_DAYS} days of this server's history to retroactively fill in activity data`),
    new SlashCommandBuilder()
      .setName('setmoney')
      .setDescription('Manually set this server\'s total money supply (from your economy bot)')
      .addIntegerOption((opt) =>
        opt.setName('amount').setDescription('Total money supply').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('exchangerate')
      .setDescription('Estimate an exchange rate between two tracked servers')
      .addStringOption((opt) =>
        opt.setName('target_guild')
          .setDescription('The first server (start typing to pick from a list)')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName('source_guild')
          .setDescription('The second server — leave blank to use the server you\'re in right now')
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName('server-link')
      .setDescription('Get the invite link for the IMB server'),
    new SlashCommandBuilder()
      .setName('set-gdp-history')
      .setDescription(truncate(`Set this channel as the daily GDP update channel (requires ${MONEY_PERM_ROLE_NAME} role)`, 100)),
    new SlashCommandBuilder()
      .setName('currency-add')
      .setDescription('Add a new currency to the bank\'s ledger (bank employees only)')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Currency name (e.g. Kramer, Daphne)').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('currency-list')
      .setDescription('List every currency the bank tracks'),
    new SlashCommandBuilder()
      .setName('balance')
      .setDescription('Check a wallet balance across every currency')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Whose balance to check — leave blank for your own').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('balance-add')
      .setDescription('Add money to someone\'s balance (bank employees only)')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Who receives the money').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('currency').setDescription('Which currency').setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption((opt) =>
        opt.setName('amount').setDescription('How much to add').setRequired(true).setMinValue(1)
      ),
    new SlashCommandBuilder()
      .setName('balance-remove')
      .setDescription('Remove money from someone\'s balance (bank employees only)')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Whose balance to deduct from').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('currency').setDescription('Which currency').setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption((opt) =>
        opt.setName('amount').setDescription('How much to remove').setRequired(true).setMinValue(1)
      ),
    new SlashCommandBuilder()
      .setName('bank-balance')
      .setDescription('View or adjust the bank\'s own reserve (bank employees only, private)')
      .addStringOption((opt) =>
        opt.setName('action')
          .setDescription('What to do — leave blank to just view the reserve')
          .setRequired(false)
          .addChoices(
            { name: 'display', value: 'display' },
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
          )
      )
      .addStringOption((opt) =>
        opt.setName('currency').setDescription('Which currency (required for add/remove)').setRequired(false).setAutocomplete(true)
      )
      .addIntegerOption((opt) =>
        opt.setName('amount').setDescription('Amount (required for add/remove)').setRequired(false).setMinValue(1)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'exchangerate') {
      const focusedOption = interaction.options.getFocused(true); // { name, value }
      const focusedText = focusedOption.value.toLowerCase();

      // Whatever's already typed/picked in the OTHER field, so we can avoid suggesting
      // the same server for both sides of the comparison.
      const otherFieldName = focusedOption.name === 'target_guild' ? 'source_guild' : 'target_guild';
      const otherValue = interaction.options.getString(otherFieldName);

      const choices = [...client.guilds.cache.values()]
        .filter((g) => g.id !== otherValue)
        .filter((g) => g.name.toLowerCase().includes(focusedText))
        .slice(0, 25) // Discord's max autocomplete results
        .map((g) => ({ name: g.name, value: g.id }));

      try {
        await interaction.respond(choices);
      } catch (err) {
        console.error('[autocomplete] failed to respond:', err);
      }
    }

    if (interaction.commandName === 'gdp') {
      const focusedText = interaction.options.getFocused().toLowerCase();
      const choices = [...client.guilds.cache.values()]
        .filter((g) => g.name.toLowerCase().includes(focusedText))
        .slice(0, 25)
        .map((g) => ({ name: g.name, value: g.id }));

      try {
        await interaction.respond(choices);
      } catch (err) {
        console.error('[autocomplete] failed to respond:', err);
      }
    }

    if (['balance-add', 'balance-remove', 'bank-balance'].includes(interaction.commandName)) {
      const focusedText = interaction.options.getFocused().toLowerCase();
      const rows = db.prepare('SELECT name FROM currencies WHERE name LIKE ? ORDER BY name').all(`%${focusedText}%`);
      const choices = rows.slice(0, 25).map((r) => ({ name: r.name, value: r.name }));

      try {
        await interaction.respond(choices);
      } catch (err) {
        console.error('[autocomplete] failed to respond:', err);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: 'This command only works inside a server, not in a DM — try it in a text channel of a server I\'m in.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === 'gdp') {
      const targetId = interaction.options.getString('target_guild');
      const guild = targetId ? client.guilds.cache.get(targetId) : interaction.guild;

      if (!guild) {
        await interaction.reply('I\'m not tracking a server with that ID — pick one from the autocomplete list.');
        return;
      }

      const stats = computeGuildStats(guild);

      const embed = new EmbedBuilder()
        .setTitle(`📈 Live stats — ${guild.name}`)
        .addFields(
          { name: 'Total Members', value: `${stats.totalMembers}`, inline: true },
          { name: 'Active Members (today)', value: `${stats.activeMembers}`, inline: true },
          { name: `New Joins (${ROLLING_WINDOW_DAYS}d rolling)`, value: `${stats.newJoins}`, inline: true },
          { name: `Messages (${ROLLING_WINDOW_DAYS}d rolling)`, value: `${stats.messages}`, inline: true },
          { name: 'Estimated GDP', value: `${stats.gdp.toFixed(2)}`, inline: true },
        )
        .setColor(0x3498db);

      await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'globalstats') {
      const rows = latestSnapshotAllGuilds();
      if (rows.length === 0) {
        await interaction.reply('No weekly snapshots recorded yet — wait for the next Sunday snapshot, or check /gdp for live in-progress numbers per server.');
        return;
      }

      const namedRows = rows.map((row) => {
        const guild = client.guilds.cache.get(row.guild_id);
        return { ...row, name: guild ? guild.name : row.guild_id };
      });

      const leaderboard = buildLeaderboard(namedRows);
      const attachment = await buildGdpChartAttachment(namedRows);

      const embed = new EmbedBuilder()
        .setTitle('🌐 Global Mock-Gov Economic Overview')
        .setDescription(leaderboard)
        .setImage(`attachment://${attachment.name}`)
        .setColor(0x9b59b6)
        .setFooter({ text: `${namedRows.length} server(s) tracked • ranked by estimated GDP` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], files: [attachment] });
    }

    if (interaction.commandName === 'gdphistory') {
      // Ensure today's data point exists for every tracked server (not just this one)
      // so the chart is complete even before the nightly cron has run yet today.
      for (const [, guild] of client.guilds.cache) {
        recordDailyHistoryForGuild(guild);
      }

      const attachment = await buildHistoryChartAttachment();
      if (!attachment) {
        await interaction.reply('No GDP history recorded yet — check back after the next daily update, or once a few days have passed.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`📉 GDP Evolution — Last ${HISTORY_DAYS_SHOWN} Days`)
        .setImage(`attachment://${attachment.name}`)
        .setColor(0xe67e22)
        .setTimestamp();

      await interaction.reply({ embeds: [embed], files: [attachment] });
    }

    if (interaction.commandName === 'backfill') {
      // Backfilling can take longer than Discord's 3-second reply window (it pages
      // through message history), so defer immediately and edit the reply once done.
      await interaction.deferReply();

      const result = await backfillGuildActivity(interaction.guild);

      if (result.alreadyRunning) {
        await interaction.editReply('A backfill is already running for this server — please wait for it to finish.');
        return;
      }

      await interaction.editReply(
        `Backfill complete: found **${result.messagesFound}** messages across **${result.daysFound}** day(s) ` +
        `in **${result.channelsScanned}** channel(s). GDP history and current stats have been updated.`
      );
    }

    if (interaction.commandName === 'server-link') {
      await interaction.reply('https://discord.gg/4zYzJrG7n3');
    }

    if (interaction.commandName === 'set-gdp-history') {
      if (!hasImbPerm(interaction)) {
        await interaction.reply({
          content: `You need the **${MONEY_PERM_ROLE_NAME}** role in this server to set the GDP update channel.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      db.prepare(`
        INSERT INTO guild_settings (guild_id, history_channel_id)
        VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET history_channel_id = excluded.history_channel_id
      `).run(interaction.guild.id, interaction.channel.id);

      await interaction.reply(`This channel is now set as the default daily GDP update channel for **${interaction.guild.name}**.`);
    }

    if (interaction.commandName === 'currency-add') {
      if (!isImbEmployee(interaction)) {
        await interaction.reply({ content: 'Only bank employees can add currencies.', flags: MessageFlags.Ephemeral });
        return;
      }

      const name = interaction.options.getString('name').trim();
      const existing = db.prepare('SELECT name FROM currencies WHERE LOWER(name) = LOWER(?)').get(name);
      if (existing) {
        await interaction.reply({ content: `**${existing.name}** already exists as a currency.`, flags: MessageFlags.Ephemeral });
        return;
      }

      db.prepare('INSERT INTO currencies (name) VALUES (?)').run(name);
      await interaction.reply(`**${name}** has been added as a currency.`);
    }

    if (interaction.commandName === 'currency-list') {
      const rows = db.prepare('SELECT name FROM currencies ORDER BY name').all();
      if (rows.length === 0) {
        await interaction.reply('No currencies have been added yet.');
        return;
      }
      await interaction.reply(`**Currencies:** ${rows.map((r) => r.name).join(', ')}`);
    }

    if (interaction.commandName === 'balance') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const rows = db.prepare('SELECT currency, amount FROM user_balances WHERE user_id = ? AND amount != 0 ORDER BY currency').all(targetUser.id);

      if (rows.length === 0) {
        await interaction.reply(`**${targetUser.username}** doesn't hold any currency yet.`);
        return;
      }

      const lines = rows.map((r) => `${r.currency}: **${r.amount.toLocaleString()}**`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`💰 ${targetUser.username}'s Balance`)
        .setDescription(lines)
        .setColor(0xf1c40f);

      await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'balance-add') {
      if (!isImbEmployee(interaction)) {
        await interaction.reply({ content: 'Only bank employees can adjust balances.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const currency = interaction.options.getString('currency');
      const amount = interaction.options.getInteger('amount');

      const currencyExists = db.prepare('SELECT 1 FROM currencies WHERE name = ?').get(currency);
      if (!currencyExists) {
        await interaction.reply({ content: `**${currency}** isn't a known currency — add it first with /currency-add.`, flags: MessageFlags.Ephemeral });
        return;
      }

      db.prepare(`
        INSERT INTO user_balances (user_id, currency, amount)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, currency) DO UPDATE SET amount = amount + excluded.amount
      `).run(targetUser.id, currency, amount);

      const newBalance = db.prepare('SELECT amount FROM user_balances WHERE user_id = ? AND currency = ?').get(targetUser.id, currency).amount;
      await interaction.reply(`Added **${amount.toLocaleString()} ${currency}** to **${targetUser.username}**. New balance: **${newBalance.toLocaleString()} ${currency}**.`);
    }

    if (interaction.commandName === 'balance-remove') {
      if (!isImbEmployee(interaction)) {
        await interaction.reply({ content: 'Only bank employees can adjust balances.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const currency = interaction.options.getString('currency');
      const amount = interaction.options.getInteger('amount');

      const currencyExists = db.prepare('SELECT 1 FROM currencies WHERE name = ?').get(currency);
      if (!currencyExists) {
        await interaction.reply({ content: `**${currency}** isn't a known currency — add it first with /currency-add.`, flags: MessageFlags.Ephemeral });
        return;
      }

      const row = db.prepare('SELECT amount FROM user_balances WHERE user_id = ? AND currency = ?').get(targetUser.id, currency);
      const currentBalance = row ? row.amount : 0;
      if (amount > currentBalance) {
        await interaction.reply({
          content: `**${targetUser.username}** only has **${currentBalance.toLocaleString()} ${currency}** — can't remove ${amount.toLocaleString()}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      db.prepare(`
        UPDATE user_balances SET amount = amount - ? WHERE user_id = ? AND currency = ?
      `).run(amount, targetUser.id, currency);

      const newBalance = db.prepare('SELECT amount FROM user_balances WHERE user_id = ? AND currency = ?').get(targetUser.id, currency).amount;
      await interaction.reply(`Removed **${amount.toLocaleString()} ${currency}** from **${targetUser.username}**. New balance: **${newBalance.toLocaleString()} ${currency}**.`);
    }

    if (interaction.commandName === 'bank-balance') {
      if (!isImbEmployee(interaction)) {
        await interaction.reply({ content: 'Only bank employees can access the reserve.', flags: MessageFlags.Ephemeral });
        return;
      }

      const action = interaction.options.getString('action') || 'display';
      const currency = interaction.options.getString('currency');
      const amount = interaction.options.getInteger('amount');

      if (action === 'display') {
        const rows = currency
          ? db.prepare('SELECT currency, amount FROM bank_reserve WHERE currency = ?').all(currency)
          : db.prepare('SELECT currency, amount FROM bank_reserve ORDER BY currency').all();

        if (rows.length === 0) {
          await interaction.reply({ content: 'The reserve is empty (or that currency has no reserve entry yet).', flags: MessageFlags.Ephemeral });
          return;
        }

        const lines = rows.map((r) => `${r.currency}: **${r.amount.toLocaleString()}**`).join('\n');
        await interaction.reply({ content: `🏦 **Bank Reserve**\n${lines}`, flags: MessageFlags.Ephemeral });
        return;
      }

      // add / remove both require currency + amount
      if (!currency || amount == null) {
        await interaction.reply({ content: 'Both `currency` and `amount` are required for add/remove.', flags: MessageFlags.Ephemeral });
        return;
      }

      const currencyExists = db.prepare('SELECT 1 FROM currencies WHERE name = ?').get(currency);
      if (!currencyExists) {
        await interaction.reply({ content: `**${currency}** isn't a known currency — add it first with /currency-add.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'add') {
        db.prepare(`
          INSERT INTO bank_reserve (currency, amount)
          VALUES (?, ?)
          ON CONFLICT(currency) DO UPDATE SET amount = amount + excluded.amount
        `).run(currency, amount);
      } else if (action === 'remove') {
        const row = db.prepare('SELECT amount FROM bank_reserve WHERE currency = ?').get(currency);
        const currentReserve = row ? row.amount : 0;
        if (amount > currentReserve) {
          await interaction.reply({
            content: `The reserve only has **${currentReserve.toLocaleString()} ${currency}** — can't remove ${amount.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        db.prepare(`
          UPDATE bank_reserve SET amount = amount - ? WHERE currency = ?
        `).run(amount, currency);
      }

      const newReserve = db.prepare('SELECT amount FROM bank_reserve WHERE currency = ?').get(currency).amount;
      await interaction.reply({
        content: `Reserve ${action === 'add' ? 'increased by' : 'decreased by'} **${amount.toLocaleString()} ${currency}**. New reserve: **${newReserve.toLocaleString()} ${currency}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === 'setmoney') {
      if (!hasImbPerm(interaction)) {
        await interaction.reply({
          content: `You need the **${MONEY_PERM_ROLE_NAME}** role in this server to set the money supply.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const amount = interaction.options.getInteger('amount');
      db.prepare(`
        INSERT INTO money_supply (guild_id, amount, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(guild_id) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
      `).run(interaction.guild.id, amount);

      // Immediately refresh this server's snapshot so /globalstats and /exchangerate
      // reflect the new money supply right away, instead of waiting for Sunday's cron.
      refreshSnapshotForGuild(interaction.guild);

      await interaction.reply(`Money supply for this server set to **${amount}**. Global stats updated immediately.`);
    }

    if (interaction.commandName === 'exchangerate') {
      const targetId = interaction.options.getString('target_guild');
      const sourceId = interaction.options.getString('source_guild') || interaction.guild.id;

      if (sourceId === targetId) {
        await interaction.reply('Pick two different servers to compare — both fields point to the same one right now.');
        return;
      }

      const a = latestSnapshot(sourceId);
      const b = latestSnapshot(targetId);

      if (!a || !b) {
        await interaction.reply('Missing a snapshot for one of the two servers — try /gdp or /setmoney in that server first to generate one.');
        return;
      }
      if (!a.money_supply || !b.money_supply) {
        await interaction.reply('Both servers need a money supply set via /setmoney before an exchange rate can be computed.');
        return;
      }

      const valuePerUnitA = a.gdp / a.money_supply;
      const valuePerUnitB = b.gdp / b.money_supply;
      const rate = valuePerUnitA / valuePerUnitB; // 1 unit of A currency = `rate` units of B currency

      const sourceGuild = client.guilds.cache.get(sourceId);
      const targetGuild = client.guilds.cache.get(targetId);
      const sourceName = sourceGuild ? sourceGuild.name : sourceId;
      const targetName = targetGuild ? targetGuild.name : targetId;

      await interaction.reply(
        `Estimated exchange rate: **1 currency unit in ${sourceName} ≈ ${rate.toFixed(4)} currency units in ${targetName}** ` +
        `(based on last snapshot: GDP ${a.gdp.toFixed(1)} vs ${b.gdp.toFixed(1)}, money supply ${a.money_supply} vs ${b.money_supply}).`
      );
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    const errorMsg = 'Something went wrong running that command — check the bot logs for details.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
      }
    } catch (_) {
      // If even the error reply fails, just log it — don't let it crash the process.
      console.error('Failed to send error reply to Discord.');
    }
  }
});

// Safety net: never let an unexpected error crash the whole bot process.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// Builds a ranked, medal-styled leaderboard string for the embed description —
// reads more naturally than a monospace table and doesn't need name truncation
// or column-width juggling for long/emoji-heavy server names.
function buildLeaderboard(namedRows) {
  const medals = ['🥇', '🥈', '🥉'];
  const fmt = (n) => (n == null ? '—' : n.toLocaleString());

  return namedRows.map((r, i) => {
    const rank = medals[i] || `**#${i + 1}**`;
    return (
      `${rank} **${r.name}**\n` +
      `> GDP: **${fmt(Math.round(r.gdp))}** • Members: ${fmt(r.total_members)} • ` +
      `Active today: ${fmt(r.active_members)} • Joins (${ROLLING_WINDOW_DAYS}d): ${fmt(r.new_joins)} • ` +
      `Messages (${ROLLING_WINDOW_DAYS}d): ${fmt(r.messages)} • Money: ${fmt(r.money_supply)}`
    );
  }).join('\n\n');
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Renders a bar chart of GDP per server as a PNG attachment (POST-based, no URL length limit).
async function buildGdpChartAttachment(namedRows) {
  const config = {
    type: 'bar',
    data: {
      labels: namedRows.map((r) => truncate(r.name, 14)),
      datasets: [{
        label: 'Estimated GDP',
        data: namedRows.map((r) => Number(r.gdp.toFixed(2))),
        backgroundColor: '#9b59b6',
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      title: { display: true, text: 'Mock-Gov GDP Comparison' },
    },
  };
  const buffer = await renderChartPng(config, 600, 350);
  return new AttachmentBuilder(buffer, { name: 'gdp-comparison.png' });
}

function latestSnapshot(guildId) {
  return db.prepare(`
    SELECT * FROM weekly_snapshot WHERE guild_id = ? ORDER BY week_start DESC LIMIT 1
  `).get(guildId);
}

// One row per guild, most recent snapshot date per guild_id.
function latestSnapshotAllGuilds() {
  return db.prepare(`
    SELECT ws.* FROM weekly_snapshot ws
    INNER JOIN (
      SELECT guild_id, MAX(week_start) AS max_week
      FROM weekly_snapshot
      GROUP BY guild_id
    ) latest ON ws.guild_id = latest.guild_id AND ws.week_start = latest.max_week
    ORDER BY ws.gdp DESC
  `).all();
}

client.login(process.env.DISCORD_TOKEN);
