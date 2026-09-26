# Wardogs moderation log bot

A Discord bot that watches the Warcon panel across six Wardogs servers and reports
moderation-relevant events into a staff channel — pinging the mod role when something
needs a human now, and posting quietly when it is only a record.

Design: `docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md`

## What it does

Four event kinds, polled from Warcon every `POLL_INTERVAL_MS` (K/D hourly), plus a
feed-health warning:

| Tier | Alert | Colour | Pings the mod role? |
| --- | --- | --- | --- |
| 1 | Watched player joins a server | blue | no |
| 2 | High K/D (K/D ≥ `KD_THRESHOLD` over `KD_RANGE`) | orange | no |
| 3 | **Sweat**: `SWEAT_PER_HOUR`+ kills an hour over `SWEAT_RANGE` | red | yes |
| 3 | **Surge**: last `SURGE_RANGE` at least `SURGE_RATIO`× their own usual rate on that server | red | yes |
| — | Team kill (with the killer's running count this match) | purple | no |
| — | Kick, ban, unban by an admin | grey | no |
| — | Feed quiet: a configured kill feed silent for `FEED_QUIET_MINUTES` with players on | brown | no |

Each tiered alert names its tier in a footer. A player who is both a sweat and surging gets
one alert, and one ping. Sweats and surges come from the scoreboard, like K/D, so they don't
need the kill feed. `PING_ON` chooses which tier-3 alerts ping: `sweat`, `surge`, or `none`
(the default is both).

Chat is out of scope: the game's feed carries no chat events at all, and Warcon's
`/v1` surface has no chat-read route, so there is no source to read.

## Why it exists

Warcon already detects all of this — it infers team kills, flags high K/D on the
leaderboard, tracks watched players, and mirrors kicks and bans to Discord webhooks.
What it cannot do is notify anyone: its webhook delivery hard-codes
`allowed_mentions: { parse: [] }`, so a team kill posts into a mod channel and no one
knows until they look. A bot posting with its own token can mention a role; a webhook
with mentions stripped cannot. This bot exists to close that one gap — Warcon still
owns detection and history, this bot owns noticing and shouting.

## The API key

Mint a **second** Warcon org API key, separate from the status fleet's, scoped to
`server.view` + `audit.read` only, and tick it against every server in the
organisation.

**Do not tick Raw RCON or Automation.** Raw RCON lets the holder call kick, kill, ban
and broadcast directly against a game server — this bot only reads. Automation is a
write capability: a key holding it can delete the `team_kill` trigger, or create one
that kicks players outright. Neither is needed for anything this bot does; excluding
both means a leaked modlog token cannot touch a game server or its triggers.

Without `audit.read`, kicks and bans silently read as zero rows rather than an error —
`npm run preflight` (below) exists partly to catch a key missing that capability
before it goes unnoticed.

## Setup

```bash
npm install
cp .env.example .env    # then fill in .env
npm test
npm run preflight       # verify credentials without touching Discord
npm run build
npm start
```

## Testing without panel access

`scripts/mock-warcon.mjs` serves the same endpoints the bot polls, so it can be
exercised end to end when the real panel is unreachable:

```bash
npm run mock                                              # terminal 1
WARCON_BASE_URL=http://127.0.0.1:8788 npm run preflight    # terminal 2
```

The override works without touching `.env`: `dotenv` does not overwrite a variable
that is already set in the environment.

## Deployment

The bot runs on the same VPS as the Warcon panel and the status fleet, as its own
compose project at `/home/debian/wardogs-modlog`, joined to the panel's
`warcon_default` Docker network. No ports are published — every call it makes is
outbound, to the panel over the Docker network and to Discord over the internet.

Inside the container, address the panel by its container name rather than
`127.0.0.1`:

```
WARCON_BASE_URL=http://warcon:3000
```

Because panel calls stay on the Docker network, **Cloudflare Access needs no changes
and no service token** — leave `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
empty on the VPS. `PANEL_PUBLIC_URL` is a separate setting: it is the origin a mod's
own browser opens to view an embed's link (e.g. `https://panel.example.com`), and must
never be swapped with `WARCON_BASE_URL` — the container address is unreachable from a
browser.

`.github/workflows/deploy.yml` runs typecheck and tests on push to `master`, then
SSHes in and runs `scripts/deploy.sh`, which resets the checkout to `origin/master`,
rebuilds the image, runs preflight (`node dist/preflight.js`) against the *new*
image, and only then replaces the running container with `docker compose up -d`. A bad token or an
unreachable panel aborts the deploy instead of taking the bot down.

Repository secrets required: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (private half of a
deploy keypair), and optionally `VPS_HOST_KEY` (pinned host key; without it the
workflow trusts `ssh-keyscan` on first contact).

## Configuration

Every value comes from the environment. `.env` is gitignored — never commit it.
**Any value containing `#` must be quoted**, or `dotenv` treats the rest of the line
as a comment and truncates it — `SERVER_LABELS` below is the value most likely to hit
this, since server labels are things like `EU#1` and `NA#3`.

| Variable | Meaning |
| --- | --- |
| `WARCON_BASE_URL` | Panel origin the bot calls; `http://warcon:3000` on the VPS |
| `PANEL_PUBLIC_URL` | Browser-facing panel origin, used to build embed links |
| `WARCON_TOKEN` | The modlog key: `server.view` + `audit.read` |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token; empty on the VPS |
| `DISCORD_TOKEN` | The modlog bot's token |
| `DISCORD_CHANNEL_ID` | The staff channel to post into |
| `DISCORD_MOD_ROLE_ID` | The role mentioned on escalation |
| `SERVER_IDS` | Comma-separated Warcon server ids to watch; required — the bot refuses to start empty |
| `SERVER_LABELS` | Comma-separated `serverId=Label` pairs; every alert is prefixed with its label (or the id's first 8 characters if unlisted) |
| `POLL_INTERVAL_MS` | How often each server is polled for kills, audit and watchlist (default `30000`) |
| `KD_POLL_INTERVAL_MS` | How often the K/D leaderboard is polled (default `3600000`) |
| `REQUEST_TIMEOUT_MS` | Per-request timeout to Warcon (default `10000`) |
| `STATE_PATH` | Where cursor/state JSON is written (default `/data/state.json`) |
| `PING_ON` | Tier-3 alerts that mention the mod role: `sweat`, `surge`, or `none` (default: both) |
| `KD_THRESHOLD` | K/D at or above which a player is flagged (default `4.0`) |
| `KD_MIN_MATCHES` | Minimum matches before a K/D flag counts (default `5`) |
| `KD_MIN_MINUTES` | Minimum playtime floor passed to the leaderboard query (default `60`) |
| `KD_RANGE` | Leaderboard lookback window (default `30d`) |
| `SWEAT_PER_HOUR` | Kills an hour that marks a sweat (default `15`) |
| `SWEAT_RANGE` | Period a sweat's rate is measured over: `7d`, `30d`, `90d` or `all` (default `30d`) |
| `SURGE_RANGE` | Recent period compared with a player's usual rate (default `7d`) |
| `SURGE_PER_HOUR` | Minimum recent kills an hour for a surge (default `10`) |
| `SURGE_RATIO` | How many times their usual rate counts as a surge (default `1.5`) |
| `SURGE_HISTORY_MINUTES` | Playtime on a server before a player can surge there (default `600`) |
| `RATE_MIN_MINUTES` | Playtime needed inside each range for sweats and surges (default `180`) |
| `KD_COOLDOWN_DAYS` | Days before the same player can be flagged again for K/D, sweat or surge (each tracked separately) (default `7`) |
| `FEED_QUIET_MINUTES` | Minutes a configured feed can go quiet, with players on, before a health warning posts (default `30`) |

## Adding a server

Bringing a new server (e.g. NA#3) under watch takes three steps — miss any one and
the server either stays silent or preflight fails:

1. Add its id to `SERVER_IDS`.
2. Add its `serverId=Label` pair to `SERVER_LABELS`.
3. Add the server to the modlog Warcon key's server scope. Skip this and preflight
   fails with a Warcon rejection for that server — the key can see the id in your
   config but has no access to it on the panel.

Once all three are done, its events carry its label the same way every other
server's do, for example an escalating team kill: `NA#3 · Team kill — Alpha (3)`.

A newly added server starts cold, as the first boot does. On its first clean cycle it
records its position and reports nothing from before, so its history never floods the
channel. It reports normally from the cycle after that. If Warcon is unreachable for
that server, it stays cold, across restarts, until one cycle succeeds.

## Known limitations

**Team kills are inferred, not reported.** The game's kill feed carries no factions
at all; Warcon compares the factions it last *observed* for killer and victim, from a
status poll running tens of seconds behind kills arriving every ~2s. A player who
switches sides shortly before a kill can be misclassified in either direction. This is
acceptable for a log and a ping — both prompt a human to look — but would not be
acceptable as input to anything automatic.

**The watched-player *reason* is not readable on this key.** `reason` is gated on a
staff-only capability and returns empty on `server.view`; reading it would require
adding a write capability (`players.notes`) for one string, which was not judged worth
it. The alert says *that* a player is watched, not *why*, and links to their dossier
where a signed-in mod can read the reason.
