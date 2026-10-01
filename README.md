# Wardogs moderation log bot

A Discord bot that watches the Warcon panel across six Wardogs servers and reports
moderation-relevant events into a staff channel — pinging the mod role when something
needs a human now, and posting quietly when it is only a record.

Design: `docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md`, amended by
`docs/superpowers/specs/2026-09-27-live-alerts-design.md` (which wins where they disagree).

## What it does

Every player alert means **this person is on a server now**. Nothing posts because a list
was refreshed. Four sources are polled from Warcon every `POLL_INTERVAL_MS` (the known-player
lists refresh hourly), plus a feed-health warning:

| Tier | Alert | When | Colour | Pings the mod role? |
| --- | --- | --- | --- | --- |
| 1 | **Watched player joined** | on connect, every time | blue | no |
| 2 | **Known sweat / high K/D / Steam veteran joined**, with their 30-day kills/hour and playtime, K/D, kills/deaths and matches, or Steam hours | on connect, at most once per `JOIN_ALERT_HOURS` per player | orange | no |
| 3 | **Hot right now**: `LIVE_PER_HOUR`+ kills an hour this match, over at least `LIVE_MIN_MINUTES` and `LIVE_MIN_KILLS` | during a match, once per player per match | red | yes, unless `PING_ON=none` |
| — | Team kill (with the killer's running count this match) | | purple | no |
| — | Kick, ban, unban by an admin | | grey | no |
| — | Feed quiet: a configured kill feed silent for `FEED_QUIET_MINUTES` with players on | | brown | no |

Each tiered alert names its tier in a footer. A player who joins carrying more than one tag
gets **one** alert listing every tag, at the highest tier they reach: `Joined — Alpha` with
tags `watched · sweat` is tier 2.

**Known players.** Every `KD_POLL_INTERVAL_MS` (hourly) the bot refreshes two lists per server
and keeps them in its state without posting them: **sweats** (`SWEAT_PER_HOUR`+ kills an hour
over `SWEAT_RANGE` with `RATE_MIN_MINUTES` played, seeding time left out, matching the panel's
own figure) and **high K/Ds** (`KD_THRESHOLD`+ over `KD_RANGE`, with `KD_MIN_MATCHES` and
`KD_MIN_MINUTES`; zero deaths is not infinite). A join is tagged from these lists and the
watchlist. The sweat and high-K/D tags post at most once per `JOIN_ALERT_HOURS` per player
(across all servers); the watched tag alerts on every connect.

**Steam veterans.** With `STEAM_API_KEY` set, each arrival's Steam library is read (once a day
per player at most) and they are tagged **Steam veteran** at `STEAM_TOTAL_HOURS`+ hours across
all games, overlay tools left out (`STEAM_IGNORE_APP_IDS`), or `STEAM_GAME_HOURS`+ in any one
competitive game (`STEAM_COMPETITIVE_APP_IDS`: CS2, Siege, Rust, Dota 2, PUBG, Apex, Squad and
others). A private game list, or a Steam error, just leaves the tag off. It shares the sweat
tags' `JOIN_ALERT_HOURS` limit.

**Hot right now.** Each cycle the bot reads every player's kills in the current match from the
server summary and counts the kills they gain from when it starts watching them, timed by the
wall clock (Warcon reports no match clock). Kills already on the board when it first looks (a
fresh boot, a new server, a gap of over 10 minutes) are not counted, and a player who appears
later counts from zero, timed from the poll before they appeared, so a rate is never
overstated. A new map, or most of the roster going down on the scoreboard, starts a new match.

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

**Do not tick Raw RCON or Automation.** Raw RCON lets the holder send any console
command straight to a game server — this bot never needs it. Automation is a
write capability: a key holding it can delete the `team_kill` trigger, or create one
that kicks players outright. Neither is needed for anything this bot does; excluding
both means a leaked modlog token cannot touch a game server or its triggers.

Without `audit.read`, kicks and bans silently read as zero rows rather than an error —
`npm run preflight` (below) exists partly to catch a key missing that capability
before it goes unnoticed.

**For the Kick and Watch buttons**, also tick on the same servers:

- **Kick, kill, move** (`players.moderate`) for Kick. The capability also covers kill and
  change-team, which this bot never calls.
- **Notes & watchlist** (`players.notes`) for Watch. It also lets the bot read *why* a player
  is watched, so watched-player join alerts show the reason instead of pointing at the
  dossier.

Without them the bot still posts every alert, and pressing a button just replies that the
key isn't allowed. These are the key's only write capabilities, and neither can touch a
game server's config, bans or triggers.

## The Kick and Watch buttons

Alerts about one player carry a red **Kick** button and a blue **Watch** button: joins,
hot players, and team kills (they act on the killer). A join by someone already on the
watchlist is a heads-up and carries no buttons, as do kicks, bans and feed warnings.

- **Who can press them:** only members holding `DISCORD_MOD_ROLE_ID`, the same role the
  alerts ping. Anyone else gets a private "only @role can use these buttons" reply.
- **Confirming:** pressing either opens a confirmation, shown only to the presser, with an
  optional reason. Nothing happens until **Submit**, so a misclick is harmless.
- **Kick:** the player sees the typed reason, or "Kicked by a moderator". The mod's name is
  not sent to the game.
- **Watch:** the player goes on the organisation's watchlist, so they're watched on every
  server. Warcon credits every watchlist entry to the API key, so the stored reason
  records the mod: `aimbot suspicion — added via Discord by ModMan`. It **never overwrites**
  an existing watch: if the player is already on the watchlist, the mod is told why and
  nothing changes.
- **Afterwards:** the pressed button becomes a disabled **Kicked by <mod>** /
  **Watched by <mod>** label (the other button still works), and a line in the channel
  records who did what, on which server, and why. Warcon's audit trail shows the kick as
  made by the modlog API key, so the admin log may post it too.

The buttons need a live connection to Discord. The bot now holds one (Guilds intent only,
no privileged intents), which is also why it shows as online. If that connection can't be
made, alerts still post and only the buttons and `/lookup` stop working; the log says so.

## `/lookup`

`/lookup player:<SteamID64 or Steam profile link>` posts everything staff want to know about
one player into the channel it's run in. Only `DISCORD_MOD_ROLE_ID` can run it; anyone else,
or a malformed player, gets a reply only they see. In-game names aren't searched: a bare word
is refused rather than guessed at. `/id/<name>` links need `STEAM_API_KEY` to resolve.

| Shows | From |
| --- | --- |
| Name, and up to ten other names seen on our servers | Warcon dossier |
| Online now (and where), first and last seen | Warcon dossier |
| Hours on our servers, total and per server | Warcon dossier (seeding included) |
| Lifetime K/D and kills/hour | Dossier for the K/D; the all-time board export for the rate, seeding left out as the panel does |
| 30-day K/D, kills/hour, hours and matches | The org's 30-day board export |
| Team kills given and received | The dossier's kill-feed record; reads "No kill feed yet" until a feed runs |
| Watch status and reason, bans on our servers, staff notes | Warcon dossier (reason and notes need **Notes & watchlist** on the key) |
| Risk score and why; Steam account age, VAC and game bans | Warcon dossier |
| Total Steam hours, most-played game, hours in Wardogs | Steam's `GetOwnedGames`, when `STEAM_API_KEY` is set; "hidden" for a private profile. Tools that run beside a game (crosshair overlays, Lossless Scaling, Wallpaper Engine, OBS…) are left out of the total and the top game, and the hours left out are named |

The command registers itself in every Discord server the bot is in each time it connects, so it
appears at once. If the log says `couldn't register /lookup`, re-invite the bot with the
`applications.commands` scope.

The reply carries **Watch** (unless they're already watched) and **Kick** (only while they're
on a server), working exactly as on alerts.

Warcon has no per-player board, so the bot downloads the organisation's board export (every
player, one CSV per range) at most once an hour, on the first lookup that needs it, and keeps
it in memory. The export needs only `server.view`. It stops at ten thousand players, least
played last, so on a busy organisation someone who played very little reads as "Under 1.5 h
played" (the least anyone in the export played) rather than "No play". A lookup whose export or Steam read fails
still posts, with that part marked unavailable; only a dossier failure stops it.

**Steam key:** create one at <https://steamcommunity.com/dev/apikey> (any domain name will do)
and set `STEAM_API_KEY`. It only reads public profile data.

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
| `POLL_INTERVAL_MS` | How often each server is polled for kills, audit, joins and the live check (default `30000`) |
| `KD_POLL_INTERVAL_MS` | How often the known sweat and high-K/D lists are refreshed (default `3600000`) |
| `REQUEST_TIMEOUT_MS` | Per-request timeout to Warcon (default `10000`) |
| `STATE_PATH` | Where cursor/state JSON is written (default `/data/state.json`) |
| `PING_ON` | `live` (the default, when unset or blank): the hot-right-now alert mentions the mod role. `none`: nothing does. Any other value fails at startup |
| `KD_THRESHOLD` | K/D at or above which a player is a known high K/D (default `4.0`) |
| `KD_MIN_MATCHES` | Minimum matches before a high K/D counts (default `5`) |
| `KD_MIN_MINUTES` | Minimum playtime floor passed to the leaderboard query (default `60`) |
| `KD_RANGE` | Leaderboard lookback window: `7d`, `30d`, `90d` or `all` (default `30d`) |
| `SWEAT_PER_HOUR` | Kills an hour that marks a known sweat (default `15`) |
| `SWEAT_RANGE` | Period a sweat's rate is measured over: `7d`, `30d`, `90d` or `all` (default `30d`) |
| `RATE_MIN_MINUTES` | Playtime needed inside `SWEAT_RANGE` to count as a sweat (default `180`) |
| `JOIN_ALERT_HOURS` | Hours before a player's sweat / high-K/D / Steam veteran tags can post on a join again (default `24`) |
| `LIVE_PER_HOUR` | Kills an hour this match that makes a player hot (default `20`) |
| `LIVE_MIN_MINUTES` | Minutes the bot must have seen them in the match first (default `20`) |
| `LIVE_MIN_KILLS` | Kills this match needed as well (default `8`) |
| `FEED_QUIET_MINUTES` | Minutes a configured feed can go quiet, with players on, before a health warning posts (default `30`) |
| `STEAM_API_KEY` | Optional. `/lookup`'s Steam playtime and `/id/` links; without it those read "not configured" |
| `WARDOGS_APP_ID` | Wardogs' Steam app id, for `/lookup`'s Wardogs hours (default `1867240`) |
| `STEAM_IGNORE_APP_IDS` | Steam app ids left out of `/lookup`'s total and top game, and the Steam veteran total. Unset or blank: the built-in list of overlay tools (`DEFAULT_IGNORED_APP_IDS` in `src/steam.ts`). Set: exactly these. `none`: nothing is left out |
| `STEAM_TOTAL_HOURS` | Hours across all Steam games that tag a join Steam veteran (default `10000`; `0` turns it off) |
| `STEAM_GAME_HOURS` | Hours in one competitive game that tag a join Steam veteran (default `1000`; `0` turns it off) |
| `STEAM_COMPETITIVE_APP_IDS` | The competitive games for `STEAM_GAME_HOURS`. Unset or blank: the built-in list (`DEFAULT_COMPETITIVE_APP_IDS` in `src/steam.ts`). Set: exactly these. `none`: no game counts |

## Upgrading to live alerts

- The hourly sweat, high-K/D and surge posts are gone. Their settings — `KD_COOLDOWN_DAYS`,
  `SURGE_RANGE`, `SURGE_PER_HOUR`, `SURGE_RATIO` and `SURGE_HISTORY_MINUTES` — can be deleted
  from `.env`; a leftover value is ignored.
- `PING_ON` now takes `live` or `none`. Production's `PING_ON=none` can stay while the new
  alerts settle; remove it to get tier-3 pings. An old value such as `sweat,surge` fails at
  startup (and so fails the deploy's preflight) with a message saying only the live alert pings.
- The state file upgrades itself: the old cooldowns and dossier cache are dropped, and warm
  servers stay warm, so players already on a server are not reported as joining.
- The known lists load on the bot's first cycle after it starts (and are retried every cycle
  until they load). Until then, joins carry only the watched tag.
- Preflight now reports a `live data` line per server: `live check active`, or `no match
  clock` for a server that is empty or doesn't report one. Neither fails a deploy.

## Adding a server

Bringing a new server (e.g. NA#3) under watch takes three steps — miss any one and
the server either stays silent or preflight fails:

1. Add its id to `SERVER_IDS`.
2. Add its `serverId=Label` pair to `SERVER_LABELS`.
3. Add the server to the modlog Warcon key's server scope. Skip this and preflight
   fails with a Warcon rejection for that server — the key can see the id in your
   config but has no access to it on the panel.

Once all three are done, its events carry its label the same way every other
server's do, for example a hot player: `NA#3 · Hot right now — Alpha`.

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
