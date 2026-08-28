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
`);

// In-memory weekly counters, flushed to DB and reset every cron tick.
// guildId -> { messages: number, activeSenders: Set<string>, newJoins: number }
const liveCounters = new Map();

function getCounter(guildId) {
  if (!liveCounters.has(guildId)) {
    liveCounters.set(guildId, { messages: 0, activeSenders: new Set(), newJoins: 0 });
  }
  return liveCounters.get(guildId);
}

function isoWeekStart(d = new Date()) {
  const date = new Date(d);
  const day = date.getUTCDay(); // 0 = Sunday
  date.setUTCDate(date.getUTCDate() - day);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function computeGDP({ messages, activeMembers, totalMembers, newJoins }) {
  // GDP = k * weekly_messages * (1 + new_joins / total_members)
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

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Tracking ${c.guilds.cache.size} guild(s): ${[...c.guilds.cache.values()].map(g => g.name).join(', ')}`);
  registerCommands(c.user.id);
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

// ---------- Weekly snapshot job ----------
// Runs every Sunday at 00:05 UTC. Adjust the cron string to taste.
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

// Pure computation of current live stats for one guild (no DB write).
function computeGuildStats(guild) {
  const guildId = guild.id;
  const counter = getCounter(guildId);
  const totalMembers = guild.memberCount;
  const activeMembers = counter.activeSenders.size;
  const messages = counter.messages;
  const newJoins = counter.newJoins;

  const moneyRow = db.prepare('SELECT amount FROM money_supply WHERE guild_id = ?').get(guildId);
  const moneySupply = moneyRow ? moneyRow.amount : null;

  const gdp = computeGDP({ messages, activeMembers, totalMembers, newJoins });

  return { totalMembers, activeMembers, messages, newJoins, moneySupply, gdp };
}

// Computes current stats for one guild and upserts today's-week snapshot row.
// Does NOT reset live counters — safe to call anytime (e.g. right after /setmoney),
// not just during the weekly cron reset.
function refreshSnapshotForGuild(guild) {
  const guildId = guild.id;
  const weekStart = isoWeekStart();
  const stats = computeGuildStats(guild);

  db.prepare(`
    INSERT OR REPLACE INTO weekly_snapshot
    (guild_id, week_start, total_members, active_members, messages, new_joins, money_supply, gdp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, weekStart, stats.totalMembers, stats.activeMembers, stats.messages, stats.newJoins, stats.moneySupply, stats.gdp);

  return stats;
}

// Records one day's GDP data point for one guild — independent of the weekly snapshot,
// used to build the day-by-day evolution chart. Does not reset counters either.
function recordDailyHistoryForGuild(guild) {
  const guildId = guild.id;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
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
    // reset counters for the new week (only done here, on the weekly cron — not on /setmoney refreshes)
    liveCounters.set(guild.id, { messages: 0, activeSenders: new Set(), newJoins: 0 });
  }
}

async function postReport(guild, stats) {
  const channel = guild.channels.cache.find(
    (ch) => ch.name === REPORT_CHANNEL_NAME && ch.isTextBased()
  );
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`📊 Weekly Economic Report — ${guild.name}`)
    .addFields(
      { name: 'Total Members', value: `${stats.totalMembers}`, inline: true },
      { name: 'Active Members (7d)', value: `${stats.activeMembers}`, inline: true },
      { name: 'New Joins (7d)', value: `${stats.newJoins}`, inline: true },
      { name: 'Weekly Messages', value: `${stats.messages}`, inline: true },
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
      const counter = getCounter(interaction.guild.id);
      const totalMembers = interaction.guild.memberCount;
      const activeMembers = counter.activeSenders.size;
      const messages = counter.messages;
      const newJoins = counter.newJoins;
      const gdp = computeGDP({ messages, activeMembers, totalMembers, newJoins });

      const embed = new EmbedBuilder()
        .setTitle(`📈 Live stats — ${interaction.guild.name} (week in progress)`)
        .addFields(
          { name: 'Total Members', value: `${totalMembers}`, inline: true },
          { name: 'Active Members (so far)', value: `${activeMembers}`, inline: true },
          { name: 'New Joins (so far)', value: `${newJoins}`, inline: true },
          { name: 'Messages (so far)', value: `${messages}`, inline: true },
          { name: 'Estimated GDP (so far)', value: `${gdp.toFixed(2)}`, inline: true },
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

// One row per guild, most recent week_start per guild_id.
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
