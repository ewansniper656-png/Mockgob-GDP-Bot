# Mock-Gov GDP Tracker Bot

Tracks weekly message activity, active members, and new joins per server —
without needing Administrator or Message Content permissions — and computes
a comparable "GDP" estimate plus a rough inter-server exchange rate.

## 1. Create the bot application

1. Go to https://discord.com/developers/applications → **New Application**.
2. Under **Bot**, click **Add Bot**.
3. Under **Bot → Privileged Gateway Intents**, enable **Server Members Intent**.
   (This is the only privileged intent this bot needs. You do NOT need to
   enable Message Content Intent — the bot never reads message text.)
4. Copy the bot token (Bot → Reset Token) — you'll need it in step 3.

## 2. Generate the invite link

Go to **OAuth2 → URL Generator**:
- Scopes: `bot`, `applications.commands`
- Bot Permissions: only check
  - `View Channels`
  - `Read Message History`
  - `Send Messages`
  - `Embed Links`

Copy the generated URL and send it to each server owner. This is a
low-friction ask — no Administrator, no Manage Server/Roles, no reading
message content.

## 3. Configure and install

```bash
cd mockgov-gdp-bot
npm install
cp .env.example .env
# edit .env and paste your bot token after DISCORD_TOKEN=
```

## 4. Run it

```bash
npm start
```

Leave this running continuously (a small VPS, a Raspberry Pi, or a free-tier
host like Railway/Fly.io all work fine — it's a lightweight process).

## 5. Using it

- In any server the bot has joined, create a text channel named
  **`gdp-report`** — the bot posts its automatic weekly report there every
  Sunday at 00:05 UTC.
- Slash commands (available in any server the bot is in):
  - `/gdp` — live stats for the current week so far (current server only)
  - `/globalstats` — shows the latest weekly snapshot for **every** server
    the bot tracks, ranked by GDP. Works from any server the bot is in —
    e.g. run it in your main server to see all other tracked servers'
    numbers, since all data is stored in one shared database regardless
    of which server the command is typed in.
  - `/setmoney amount:<n>` — manually enter that server's current bot-economy
    money supply (there's no universal way to read balances from third-party
    economy bots like UnbelievaBoat, so this stays a manual, once-a-week
    input — everything else is automatic)
  - `/exchangerate target_guild_id:<id>` — estimate a currency exchange rate
    between the current server and another tracked server, based on their
    last weekly snapshot

## How the numbers are calculated

```
GDP = k * weekly_messages * (1 + new_joins / total_members)
```
`k` is a constant (default 1) — keep it identical across every server you
track so comparisons stay meaningful; changing it just rescales all GDPs
uniformly.

Exchange rate between two servers A and B (only computable once both have
a money supply set via `/setmoney`):
```
value_per_unit = GDP / money_supply
rate (A→B) = value_per_unit(A) / value_per_unit(B)
```

## Data storage

Everything is stored locally in `gdp.db` (SQLite, via better-sqlite3) —
no external services, no data leaves your machine. Delete the file to
reset all history.

## Notes / limitations

- "Active members" = unique users who sent at least one message that week.
  Message content is never read or stored — only that a message occurred
  and who sent it.
- Money supply must be entered manually per server since Discord bots
  can't read another bot's economy database.
- The weekly cron resets counters every Sunday 00:05 UTC — edit the cron
  string in `index.js` (`cron.schedule('5 0 * * 0', ...)`) if you want a
  different day/time.
- Basic anti-gaming: bot messages are ignored. If you want to guard against
  spam farming further, consider adding a per-user per-minute message cap
  in the counter logic.
