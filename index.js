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
// -----------------------------

// Uses /data/gdp.db if a persistent volume is mounted there (e.g. on Railway),
// otherwise falls back to a local gdp.db file for local/dev use.
const fs = require('fs');
const dbPath = fs.existsSync('/data') ? '/data/gdp.db' : 'gdp.db';
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
`);

// In-memory counters for the day currently in progress (since the last midnight-UTC
// rollover). Finalized into daily_activity at rollover, then reset to zero.
// guildId -> { messages: number, activeSenders: Set<string>, newJoins: number }
const liveCounters = new Map();

function getCounter(guildId) {
  if (!liveCounters.has(guildId)) {
    liveCounters.set(guildId, { messages: 0, activeSenders: new Set(), newJoins: 0 });
  }
  return liveCounters.get(guildId);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
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
});

// Count new joins
client.on(Events.GuildMemberAdd, (member) => {
  const counter = getCounter(member.guild.id);
  counter.newJoins += 1;
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
// updated GDP-evolution line chart to any channel named HISTORY_CHANNEL_NAME.
cron.schedule('10 0 * * *', async () => {
  console.log(`[daily-history] cron fired at ${new Date().toISOString()}`);
  try {
    await recordDailyHistoryAndPostChart();
  } catch (err) {
    console.error('[daily-history] job failed:', err);
  }
}, { timezone: 'UTC' });

async function recordDailyHistoryAndPostChart() {
  for (const [, guild] of client.guilds.cache) {
    recordDailyHistoryForGuild(guild);
  }
  console.log(`[daily-history] recorded data for ${client.guilds.cache.size} guild(s)`);

  const chartUrl = buildHistoryChartUrl();
  if (!chartUrl) {
    console.log('[daily-history] no chart built — no history rows yet');
    return;
  }

  for (const [, guild] of client.guilds.cache) {
    const channel = guild.channels.cache.find(
      (ch) => ch.name === HISTORY_CHANNEL_NAME && ch.isTextBased()
    );
    if (!channel) continue;

    const embed = new EmbedBuilder()
      .setTitle('📉 GDP Evolution — Last ' + HISTORY_DAYS_SHOWN + ' Days')
      .setImage(chartUrl)
      .setColor(0xe67e22)
      .setTimestamp();

    channel.send({ embeds: [embed] })
      .then(() => console.log(`[daily-history] posted chart in ${guild.name}#${channel.name}`))
      .catch((err) => console.error(`[daily-history] failed to post in ${guild.name}#${channel.name}:`, err));
  }
}

// Pulls the last HISTORY_DAYS_SHOWN days of history for every guild and builds
// a multi-line QuickChart URL (one line per server).
function buildHistoryChartUrl() {
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

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&width=700&height=400&backgroundColor=white`;
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
      .setDescription('Show current live-week stats and estimated GDP for this server'),
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
      .setDescription('Estimate an exchange rate between this server and another tracked server')
      .addStringOption((opt) =>
        opt.setName('target_guild_id').setDescription('The other server\'s ID').setRequired(true)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: 'This command only works inside a server, not in a DM — try it in a text channel of a server I\'m in.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'gdp') {
      const stats = computeGuildStats(interaction.guild);

      const embed = new EmbedBuilder()
        .setTitle(`📈 Live stats — ${interaction.guild.name}`)
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

      const table = buildComparisonTable(namedRows);
      const chartUrl = buildGdpChartUrl(namedRows);

      const embed = new EmbedBuilder()
        .setTitle('🌐 Global Mock-Gov Economic Overview')
        .setDescription('Latest weekly snapshot per tracked server, ranked by estimated GDP.\n' + table)
        .setImage(chartUrl)
        .setColor(0x9b59b6)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'gdphistory') {
      // Ensure today's data point exists for every tracked server (not just this one)
      // so the chart is complete even before the nightly cron has run yet today.
      for (const [, guild] of client.guilds.cache) {
        recordDailyHistoryForGuild(guild);
      }

      const chartUrl = buildHistoryChartUrl();
      if (!chartUrl) {
        await interaction.reply('No GDP history recorded yet — check back after the next daily update, or once a few days have passed.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`📉 GDP Evolution — Last ${HISTORY_DAYS_SHOWN} Days`)
        .setImage(chartUrl)
        .setColor(0xe67e22)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
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

    if (interaction.commandName === 'setmoney') {
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
      const targetId = interaction.options.getString('target_guild_id');
      const a = latestSnapshot(interaction.guild.id);
      const b = latestSnapshot(targetId);

      if (!a || !b) {
        await interaction.reply('Missing a weekly snapshot for one of the two servers — wait for the next weekly report, or use /gdp then try again after the next Sunday snapshot.');
        return;
      }
      if (!a.money_supply || !b.money_supply) {
        await interaction.reply('Both servers need a money supply set via /setmoney before an exchange rate can be computed.');
        return;
      }

      const valuePerUnitA = a.gdp / a.money_supply;
      const valuePerUnitB = b.gdp / b.money_supply;
      const rate = valuePerUnitA / valuePerUnitB; // 1 unit of A currency = `rate` units of B currency

      await interaction.reply(
        `Estimated exchange rate: **1 currency unit here ≈ ${rate.toFixed(4)} currency units** in the target server ` +
        `(based on last snapshot: GDP ${a.gdp.toFixed(1)} vs ${b.gdp.toFixed(1)}, money supply ${a.money_supply} vs ${b.money_supply}).`
      );
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    const errorMsg = 'Something went wrong running that command — check the bot logs for details.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: errorMsg, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMsg, ephemeral: true });
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

// Builds a monospaced, aligned comparison table (Discord renders ```...``` as fixed-width).
function buildComparisonTable(namedRows) {
  const cols = ['Server', 'GDP', 'Members', 'Active', 'Joins', 'Messages', 'Money'];
  const data = namedRows.map((r) => [
    truncate(r.name, 16),
    r.gdp.toFixed(1),
    `${r.total_members}`,
    `${r.active_members}`,
    `${r.new_joins}`,
    `${r.messages}`,
    r.money_supply != null ? `${r.money_supply}` : '—',
  ]);

  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((row) => row[i].length)));
  const pad = (s, w) => s + ' '.repeat(w - s.length);

  const header = cols.map((c, i) => pad(c, widths[i])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-|-');
  const lines = data.map((row) => row.map((v, i) => pad(v, widths[i])).join(' | '));

  return '```\n' + [header, separator, ...lines].join('\n') + '\n```';
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Builds a QuickChart.io URL for a bar chart of GDP per server — no local rendering needed.
function buildGdpChartUrl(namedRows) {
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
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&width=600&height=350&backgroundColor=white`;
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
