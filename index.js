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
// -----------------------------

// Uses /data/gdp.db if a persistent volume is mounted there (e.g. on Railway),
// otherwise falls back to a local gdp.db file for local/dev use.
const fs = require('fs');
const dbPath = fs.existsSync('/data') ? '/data/gdp.db' : 'gdp.db';
const db = new Database('/data/gdp.db');
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
  await snapshotAllGuilds();
}, { timezone: 'UTC' });

async function snapshotAllGuilds() {
  const weekStart = isoWeekStart();
  for (const [guildId, guild] of client.guilds.cache) {
    const counter = getCounter(guildId);
    const totalMembers = guild.memberCount;
    const activeMembers = counter.activeSenders.size;
    const messages = counter.messages;
    const newJoins = counter.newJoins;

    const moneyRow = db.prepare('SELECT amount FROM money_supply WHERE guild_id = ?').get(guildId);
    const moneySupply = moneyRow ? moneyRow.amount : null;

    const gdp = computeGDP({ messages, activeMembers, totalMembers, newJoins });

    db.prepare(`
      INSERT OR REPLACE INTO weekly_snapshot
      (guild_id, week_start, total_members, active_members, messages, new_joins, money_supply, gdp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, weekStart, totalMembers, activeMembers, messages, newJoins, moneySupply, gdp);

    await postReport(guild, { totalMembers, activeMembers, messages, newJoins, moneySupply, gdp });

    // reset counters for the new week
    liveCounters.set(guildId, { messages: 0, activeSenders: new Set(), newJoins: 0 });
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

    const embed = new EmbedBuilder()
      .setTitle('🌐 Global Mock-Gov Economic Overview')
      .setDescription('Latest weekly snapshot per tracked server, ranked by estimated GDP.')
      .setColor(0x9b59b6)
      .setTimestamp();

    for (const row of rows) {
      const guild = client.guilds.cache.get(row.guild_id);
      const name = guild ? guild.name : row.guild_id;
      embed.addFields({
        name: `${name} (week of ${row.week_start})`,
        value:
          `GDP: **${row.gdp.toFixed(2)}** | Members: ${row.total_members} | Active: ${row.active_members} | ` +
          `Joins: ${row.new_joins} | Messages: ${row.messages} | Money: ${row.money_supply ?? 'not set'}`,
      });
    }

    await interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'setmoney') {
    const amount = interaction.options.getInteger('amount');
    db.prepare(`
      INSERT INTO money_supply (guild_id, amount, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(guild_id) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
    `).run(interaction.guild.id, amount);
    await interaction.reply(`Money supply for this server set to **${amount}**.`);
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
});

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
