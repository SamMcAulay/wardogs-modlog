# Wardogs moderation log bot

A separate Discord bot, apart from the six status bots, that watches the Warcon
panel and reports moderation-relevant events into a staff channel — pinging a mod
role when something needs a human now, and posting quietly when it is only a record.

Status: design approved 2026-09-24.

## 1. Why this exists

Warcon already detects most of what we want. It ingests the game's kill feed, infers
team kills, counts them per session, and can whisper or kick on a threshold. It
mirrors bans, kicks, trigger actions and watched-player joins to Discord webhooks.

What it cannot do is **notify anyone**. `postDiscord` hard-codes
`allowed_mentions: { parse: [] }` (`src/lib/server/webhook-delivery.ts:405`), and it
is the single send path for every webhook message. Warcon will post a team kill into
a mod channel and no one will know until they look.

This bot exists to close that gap. A Discord bot posting with its own token can
mention a role; a webhook with mentions stripped cannot. Everything else here follows
from that one asymmetry, which is why the design stays deliberately thin: Warcon
owns detection and history, this bot owns noticing and shouting.

## 2. Scope

Four event kinds, agreed 2026-09-24:

| Event | Pings the mod role? |
| --- | --- |
| Team kill, at the 3rd by one player in a session | yes |
| High K/D flag | yes |
| Watched player joins a server | yes |
| Kick, ban, unban by an admin | no — a record, not an alarm |

### 2.1 Out of scope: chat logging

Chat profanity flagging was requested and **cannot be built**. The game's
`WDServerFeed` emits only `killed` events — `parseKill` returns null for anything
else (`src/lib/server/feed-core.ts:73`) — and WDRCON's `/v1` surface has no
chat-read route at all. The `chat.send` capability is outbound only: broadcast and
whisper. Player chat is not exposed by the game, so there is no source to read and no
workaround at the panel layer.

The nearest achievable thing is Warcon's existing `name_filter` trigger, which does
profanity matching on player *names* with leetspeak and look-alike folding
(`src/lib/server/name-filter.ts`). It is not part of this design, but it is the right
answer if the underlying concern is offensive text reaching other players.

## 3. Deployment shape

A **separate repository** (`wardogs-modlog`), its own container, on the same VPS and
the same `warcon_default` Docker network as the status fleet.

Not a seventh client inside the WDstats process, and not a second service in that repo.
The shared surface is roughly forty lines of auth-header plumbing, while the costs of
coupling are real: this bot will churn as thresholds are tuned, and the status fleet —
stable, stateless, and the thing players actually see — should not be redeployed for
it. Separate repositories also keep the two API keys in separate processes, which is
the point of minting two (§4).

Panel calls stay on the Docker network (`WARCON_BASE_URL=http://warcon:3000`), so
Cloudflare Access needs no changes and no service token, exactly as for the status
fleet.

## 4. Credentials

### 4.1 Warcon API key: `server.view` + `audit.read`, and nothing else

A **second** org API key, separate from the status fleet's. Label it distinctly
("Modlog bot"), tick Audit trail on the key itself, and scope it to every server in
the organisation including ones added later — a server added next month should start
being logged without anyone remembering to update a key.

Three of the four event sources need only `server.view`, which the status key already
has. Kicks and bans need `audit.read`:

```ts
// src/lib/server/access.ts:553 — auditVisibility
if (user.apiKey) {
  const covered = user.apiKey.capabilities.includes('audit.read')
    ? (await accessibleServers(env, user)).map((s) => s.id)
    : [];
```

Without `audit.read` the key sees an empty server list and `/api/audit` returns zero
rows rather than an error. A missing capability therefore presents as "no kicks have
happened", not as a failure — the preflight check in §10 exists partly to catch this.

**Two capabilities are deliberately excluded**, both of which were ticked in the first
draft of this key:

- **Raw RCON** (`rcon.raw`) — "call any `/v1` route on the game server directly":
  kick, kill, ban, broadcast, `PUT /v1/config`. This bot only reads. Excluding it
  means a leaked modlog token cannot touch a game server.
- **Automation** (`automation.manage`) — despite sitting beside the read-only-sounding
  `/outbox`, it gates `POST /triggers`, `PATCH /triggers/{id}` and
  `DELETE /triggers/{id}`. A key holding it can delete the `team_kill` trigger or
  create one that kicks players. The only read it buys is `/outbox`, which none of the
  four events need.

Excluding Automation has one design consequence, recorded here because it looks like
an omission otherwise: Warcon's `kill_rate` trigger — a sharper cheat signal than
career K/D — writes its flags to `/outbox`. It is unreachable on this key by choice.
If kill-rate flagging is wanted later, that is a deliberate decision to widen the key,
and should be weighed then rather than assumed now.

### 4.2 Discord

One bot token. The bot needs **Send Messages** in the staff channel, and either
**Mention Everyone** or the mod role set mentionable. No gateway intents are required:
intents govern what a bot *receives*, and this bot only posts over REST.

## 5. Data sources

Polled per server every `POLL_INTERVAL_MS` (default 30s), except the K/D board which
is hourly.

**Polling, not the SSE stream.** `GET /api/live/events` pushes observations and would
be a better fit on latency alone, but holding it open marks those servers *watched*,
which moves them to Warcon's fastest observation tier and puts real extra load on the
game servers. It also caps streams at five minutes by design, so it needs reconnect
handling. None of these four events is latency-critical — a ban surfacing thirty
seconds later is fine. This is a reversible decision; revisit if team-kill pings feel
sluggish.

### 5.1 Team kills — `GET /api/servers/{id}/kills?kind=teamKill`

Returns `{ ok, configured, feedAt, kills: KillView[], total }`, newest first.
`KillView` carries `eventId` (a stable UUID), `ts`, `eventTime` (match clock),
`killer: { steamId, name, faction } | null`, `victim`, `cause`, `distanceM`,
`headshot`, `suicide`, `teamKill`, `tags`.

Paging runs **backwards** — `before` is an ISO timestamp, refined by `beforeTime` for
rows sharing a receipt time. There is no "everything after X" parameter. Tailing
therefore means: fetch the newest page (`limit=200`), walk back until an `eventId` we
have already seen, and stop. This is why state keeps a set of recent event ids rather
than a timestamp alone (§7) — a batch flushes every ~2s and several kills can share a
`ts`, so a timestamp cursor alone would drop or duplicate rows.

`configured` and `feedAt` come back on every call for free, which §8.4 uses to notice
a feed that has gone quiet.

### 5.2 Kicks and bans — `GET /api/audit?category=rcon&server={id}`

Returns `{ entries: AuditRow[], nextBefore }`. Actions of interest: `rcon.kick`,
`rcon.ban`, `rcon.unban`. Rows carry `serverId`, `actorId`, `actorName`, `category`,
`action`, `target`, `outcome`.

`before` is a **monotonic row id**, filtered as `lt(auditLog.id, before)`
(`src/lib/server/audit.ts:177`). Unlike kills, this gives a clean high-water mark:
store the greatest id seen and stop walking back when `id <= lastSeenAuditId`. No id
set needed.

Filter `outcome` to `ok` — a denied or errored kick attempt is not a moderation event
worth reporting, and reporting failures would make the log misleading.

### 5.3 Watched players — `GET /api/servers/{id}/summary` + `players/marks`

`summary` already returns `players[]` with `steamId` and `name`. Pass those ids to
`GET /api/servers/{id}/players/marks?ids=…&names=…` (up to 200 per call), which
returns watchlist, first-visit and risk marks. Report a watched player the first time
they appear in a server's player list after being absent.

Names travel alongside ids because Warcon judges "resembles a banned player" against
the current name.

Each mark is `PlayerMark { steamId, watched, reason, firstVisit, risk }`. **The
`watched` flag comes back on `server.view`, but `reason` does not** — it is gated on
staff capability and returns `''` otherwise (`src/lib/server/players.ts:220`):

```ts
watched: !!l?.watched,
reason: staff ? (l?.watched?.reason ?? '') : '',
```

Reading the reason would mean adding `players.notes` to the key, which is a **write**
capability — the same route (`PUT /players/{steamId}/watch`) uses it to put players on
the watchlist. That is not worth it for one string. The embed therefore says *that* a
player is watched, not *why*, and links to their dossier at
`{PANEL_PUBLIC_URL}/server/{serverId}/players/{steamId}` where a signed-in mod can read
the reason. Same principle as the team-kill link in §8.1: carry the means to check
rather than widen the key.

### 5.4 High K/D — `GET /api/servers/{id}/leaderboard`

Query: `?scope=server&range=30d&sort=kd&dir=desc&minMinutes=60`. Returns
`BoardView { query, rows: BoardRow[], total, pageSize, maxPage?, hasFeed }`.

**`BoardRow` has `matches`, not `sessions`.** The original requirement was "4.0+ K/D
over 5 or more sessions", and sessions are not on the board — they appear only on the
player dossier (`/players/{steamId}/career`), which would mean an extra call per
candidate.

This spec deliberately uses `matches >= 5` instead, for two reasons. Fetching career
data per candidate turns one call into one-plus-N. More importantly a Warcon session
is "one stay on a server, from joining to leaving", so five reconnects in a single
evening is five sessions — it measures connection stability, not how much someone has
played. Matches measure playing. Combined with the board's own `minMinutes` floor,
this is a better reading of the intent than the literal wording.

Flag condition: `kd >= 4.0 && matches >= 5`, where `kd = deaths ? kills / deaths : 0`.
A player with kills and zero deaths is **not** flagged as infinite — an unflagged
divide-by-zero would make every fresh account with one lucky kill an alert.

`hasFeed` tells us whether feed-derived columns exist at all on these servers; kills
and deaths come from the scoreboard regardless, so K/D works either way.

## 6. Architecture

```
per server, every 30s (K/D hourly)
  ├─ GET /kills?kind=teamKill&limit=200      → team kill events
  ├─ GET /audit?category=rcon&server=…       → kick / ban events
  ├─ GET /summary → players[] ─┐
  │                            └─ GET /players/marks  → watched-join events
  └─ GET /leaderboard?sort=kd  (hourly)      → high K/D events
                    │
                    ▼
            dedupe against state
                    ▼
            escalation (pure)          3rd team kill? K/D cooldown elapsed?
                    ▼
            Discord sink               embed; role mention only on escalation
                    ▼
            persist state              atomic write
```

| File | Responsibility | Depends on |
| --- | --- | --- |
| `src/config.ts` | env parsing and validation | — |
| `src/warcon.ts` | authenticated client, timeout, Cloudflare/auth error classes | config |
| `src/sources/kills.ts` | `poll(client, state) → { events, cursor }` | warcon |
| `src/sources/audit.ts` | same shape, high-water id | warcon |
| `src/sources/watchlist.ts` | same shape, presence diff | warcon |
| `src/sources/kd.ts` | same shape, hourly | warcon |
| `src/events.ts` | the discriminated union every source yields | — |
| `src/escalate.ts` | pure: team-kill counting, thresholds, cooldowns | events |
| `src/state.ts` | load, mutate, atomic save | — |
| `src/discord.ts` | embeds and the single mention decision | events |
| `src/index.ts` | the loop, shutdown, error containment | all |

Each source is a pure-ish function of `(client, state)` returning events and a new
cursor. None of them touch Discord or the disk, so each is testable against fixtures
alone. `escalate.ts` is fully pure and carries the rules most likely to be tuned,
which is precisely why it is isolated from I/O.

## 7. State

A single JSON file on a Docker volume, written atomically (write to a temp file in the
same directory, then `rename`), loaded once at boot and saved after each poll cycle.

```ts
interface State {
  version: 1;
  servers: Record<string, {
    seenKillIds: string[];      // ring buffer, newest first, capped at 500
    lastAuditId: number;        // high-water mark
    presentSteamIds: string[];  // last seen player list, for join detection
    lastFeedAt: string | null;  // for the quiet-feed check
    lastEventTime: number;      // newest match-clock value seen, for match boundaries
    teamKills: Record<string, number>;  // steamId → count in the current match
    warm: boolean;              // has completed one clean cycle; false = cold (below)
  }>;
  kdAlerted: Record<string, number>;  // steamId → epoch ms of last K/D alert
  startedAt: number;
}
```

Not SQLite. The state is a handful of cursors and a bounded id ring — kilobytes, not
megabytes — and Warcon already holds the history and answers every aggregate question
we ask. SQLite earns its place when we need to query our own data, which we do not.
`state.ts` is a contained module if that ever changes.

`seenKillIds` is capped at 500 per server. A batch flushes every ~2s with one to ten
events, so 500 covers far more than one poll interval of team kills specifically
(which are a small fraction of all kills). Entries fall off the end oldest-first.

**Cold start records position and posts nothing.** With no state file, the bot reads
each source, stores the cursors, writes state, and reports nothing on that first
cycle. A bot that floods the staff channel with a month of backfill on first boot is
one that gets muted within the hour. The same applies per server when a new server id
first appears.

Cold start is tracked **per server and persisted** as `warm`, which is false for a
server id with no entry, and for an entry from a state file written before the field
existed. A server that is not warm reads its sources and records their cursors but
posts nothing. It turns warm after a cycle in which its kills, audit and watchlist
sources all succeeded (the K/D board has no cursor and does not count). So a first
boot during a Warcon outage stays cold across restarts, and its backlog is never
reported as new.

## 8. Rules

`PING_ON` (added 2026-09-26) lists which of the three pinging kinds actually mention the
role; `none` silences all of them. A kind left out still posts its embed, and still counts:
team-kill totals and K/D cooldowns advance exactly as if it pinged, so turning a ping back on
does not replay or re-flag anything.

### 8.1 Team kills

Count team kills per `killer.steamId` per server, within the current match, held in
`teamKills` (§7). The match boundary is `eventTime` **decreasing** relative to
`lastEventTime` — the match clock resets on a map change, and `matchId` from the raw
feed is per-boot rather than per-match, so it cannot be used. On a decrease, clear
`teamKills` for that server before counting the new page.

Because kills are read newest-first and walked backwards, a page must be reversed into
chronological order before counting, or the third team kill would be attributed to the
wrong event.

Post every team kill without a mention. On the **3rd and every subsequent** team kill
by the same player in the same match, mention the mod role. Threshold in config
(`TEAM_KILL_PING_AT`, default 3).

Kills with `killer === null` are environment deaths and are never team kills;
`isTeamKill` already excludes self-kills.

**The embed must show its own evidence.** Because the team-kill label is inferred
rather than reported (§12), the message carries both `killer.faction` and
`victim.faction` — the two values the inference actually compared — alongside the
facts the feed reports directly: weapon (`cause`, labelled via `$lib/causes`),
`distanceM`, and the victim's name. A mod can then see *why* Warcon called it a team
kill, and a wrong call is visible rather than something to take on trust.

The embed also links to the Warcon Kills tab, filtered to that player:

```
{PANEL_PUBLIC_URL}/server/{serverId}/kills?killer={steamId}&kind=teamKill
```

The page reads the same filter parameters as the API (`parseKillFilter`,
`src/lib/kills.ts:47`), so this lands on that player's team-kill history in one click.
Note this needs the panel's **public** origin, not the `http://warcon:3000` container
address used for API calls — hence a separate `PANEL_PUBLIC_URL` in §10.

This is what makes the inference weakness tolerable: an uncertain flag that carries
the means to check it costs a mod seconds, where a bare assertion would cost trust.

### 8.2 Kicks and bans

Post every `rcon.kick`, `rcon.ban` and `rcon.unban` with `outcome === 'ok'`. No
mention. Include the acting admin (`actorName`), the target and the reason.

### 8.3 Watched players and K/D

A watched player appearing in `players[]` when they were absent in the previous cycle
mentions the mod role. Re-joining after a disconnect will re-alert; this is intended,
since the point is knowing they are on the server right now.

A K/D flag mentions the mod role, then enters a cooldown of `KD_COOLDOWN_DAYS`
(default 7) for that steam id, so a genuinely good player is not re-reported hourly
forever.

### 8.4 Feed health

If `configured` is true but `feedAt` has not advanced for `FEED_QUIET_MINUTES`
(default 30) on a server with players on it, post once without a mention. This catches
a kill-feed config that did not take — a failure mode the Warcon docs call out
explicitly, since a config written before the `/api/ingest/events` suffix was known
produces a path Warcon does not serve. Reset the warning when `feedAt` advances.

### 8.5 Server identity

Staff watch six servers from one channel, so **every alert names its server** before
anything else. The label comes from `SERVER_LABELS`, comma-separated `serverId=Label`
pairs such as `"0eec…=EU#1,c83b…=NA#3"` — the same short names players and the status
bots use. A server with no label falls back to the first eight characters of its id,
which is ugly on purpose: it shows up in the channel and gets fixed. Preflight prints
every server's label beside the live `serverName` Warcon reports, and warns for each
server without one.

The label appears in two places:

- **The embed title**, as a prefix: `NA#3 · Team kill — Alpha (3)`. The title is what a
  channel notification previews, so the server is legible without opening Discord. The
  prefix counts toward the 256-character title limit.
- **The mention line**, when the alert pings: `<@&role> **NA#3**`. That line is what a
  mod's phone shows for a mention, and it is the one they act on.

Labels are configured rather than read from the live `serverName`, because a label
must exist when a server's summary cannot be fetched — which is exactly when feed-health
and admin-action alerts still need to say where they came from.

## 9. Failure handling

Follows the status fleet's existing conventions (`src/warcon.ts`, `src/schedule.ts`).

| Condition | Behaviour |
| --- | --- |
| Cloudflare Access bounce | log as an error, distinct from an auth rejection |
| Warcon 401 / 403 | log `warcon auth rejected`, naming the likely missing capability |
| Fetch timeout / 5xx | log it and move on; the failing server is retried on the next cycle |
| Discord post fails | keep the event unacknowledged; do not advance the cursor |
| Discord rejects the post (4xx other than 429) | log as an error with the status and message, count it as delivered, carry on. The same body would fail every retry and block the server forever |
| State file missing | cold start (§7) |
| State file corrupt | log loudly, treat as cold start, move the bad file aside |

**Cursors advance only over events that posted successfully.** State is written once
per cycle, after that cycle's posts have been attempted, and an event whose post
failed is left out of the cursor update so the next cycle picks it up again. A crash
between reading and posting therefore re-reports rather than silently drops: a
moderation log that loses events is worse than one that occasionally repeats.

This makes duplicates possible but rare: only a post that succeeded while the state
write then failed gets reported twice. Given the state write is an atomic rename to a
local volume, that window is small, and a repeated line in a mod channel is a far
cheaper failure than a missed ban.

One source failing must not stop the others: each is wrapped independently, and a
server that is unreachable does not block the rest of the fleet.

There is no per-server backoff. Cycles run in a self-scheduling loop: the next cycle is
queued only after the current one has settled, so cycles never overlap or pile up.
Every Warcon request is bounded by `REQUEST_TIMEOUT_MS`, which caps how long one
unreachable server can slow a cycle. A failing server is retried every cycle, and
each failure is logged.

## 10. Configuration

```
WARCON_BASE_URL            http://warcon:3000 on the VPS
PANEL_PUBLIC_URL           the origin a mod's browser opens, for embed links
WARCON_TOKEN               the modlog key: server.view + audit.read
CF_ACCESS_CLIENT_ID        empty on the VPS
CF_ACCESS_CLIENT_SECRET    empty on the VPS

DISCORD_TOKEN              the modlog bot
DISCORD_CHANNEL_ID         the staff channel
DISCORD_MOD_ROLE_ID        the role mentioned on escalation

SERVER_IDS                 comma-separated; required — the bot refuses to start empty
SERVER_LABELS              serverId=Label pairs, comma-separated; quote it (§8.5)
POLL_INTERVAL_MS           30000
KD_POLL_INTERVAL_MS        3600000
REQUEST_TIMEOUT_MS         10000
STATE_PATH                 /data/state.json

PING_ON                    teamKill,watchedJoin,highKd   (or none)
TEAM_KILL_PING_AT          3
KD_THRESHOLD               4.0
KD_MIN_MATCHES             5
KD_MIN_MINUTES             60
KD_RANGE                   30d
KD_COOLDOWN_DAYS           7
FEED_QUIET_MINUTES         30
```

Values containing `#` must be quoted, as dotenv otherwise treats the rest of the line
as a comment — the same trap already documented in the status fleet's README.

A `npm run preflight` gate mirrors the status fleet's: verify the Discord token with a
read-only `GET /users/@me`, verify channel and role are visible, and call each of the
four Warcon endpoints once, naming a Cloudflare bounce, a Warcon rejection and a
missing `audit.read` as distinct failures. Exits non-zero, so it doubles as a deploy
gate.

## 11. Testing

`vitest`, matching the status fleet's layout and its fake-target pattern
(`tests/discord-target.test.ts`).

- **`escalate.ts`** carries the heaviest coverage: it is pure and holds every rule.
  Third team kill pings and the first two do not; a match boundary resets the count;
  K/D cooldown suppresses a re-flag and expires correctly; zero deaths does not flag.
- **Sources** run against fixtures shaped like real Warcon responses — including the
  awkward ones: a kill batch sharing one `ts`, an audit page whose newest row is
  already known, a `marks` response for a player who left mid-cycle.
- **`state.ts`**: round-trips, ring-buffer eviction, corrupt file, cold start.
- **`discord.ts`**: asserts a mention is present exactly when escalation says so, and
  that embeds stay inside Discord's field limits. A team-kill embed must carry both
  factions and a Kills-tab link built from `PANEL_PUBLIC_URL`, not `WARCON_BASE_URL` —
  a test that would otherwise only fail in production, where the internal container
  address is unreachable from a browser.
- **Server identity**: every embed title starts with its server's label, a pinging
  message names the server beside the mention, and an unlabelled server falls back to
  its short id.
- **Cursor safety**: a Discord failure must leave the cursor unadvanced, and the next
  cycle must re-report the same event.

A mock Warcon server in the shape of `scripts/mock-warcon.mjs` serves the four
endpoints so the bot can be exercised end to end without panel access.

## 12. Deployment

Same VPS as the panel and the status fleet, as a **third, independently scoped compose
project** at `/home/debian/wardogs-modlog`. Its own repository, its own GitHub Actions
workflow, its own deploy key and secrets, mirroring `scripts/deploy.sh` and
`.github/workflows/deploy.yml` in the status fleet.

```yaml
services:
  modlog:
    build: .
    image: wardogs-modlog:latest
    container_name: wardogs-modlog
    restart: unless-stopped
    env_file: .env          # secrets live only on the VPS, never in the image
    volumes:
      - modlog-state:/data  # §7
    networks: [warcon]
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  modlog-state:

networks:
  warcon:
    external: true
    name: warcon_default
```

No ports are published: every call the bot makes is outbound, to the panel over the
Docker network and to Discord over the internet. Joining `warcon_default` is what lets
`WARCON_BASE_URL=http://warcon:3000` resolve, and keeps panel traffic on the host, so
**Cloudflare Access still needs no changes and no service token**.

### 12.1 The state volume needs ownership set in the image

The runtime stage drops to `USER node`. A named volume mounted at a path that does not
exist in the image is created **owned by root**, and the `node` user then cannot write
its state file — the bot would start cleanly, cold-start every boot, and re-report
nothing, which is a silent failure rather than a crash.

The Dockerfile must therefore create the directory with the right owner *before*
dropping privileges, so Docker copies that ownership when it initialises the volume:

```dockerfile
RUN mkdir -p /data && chown node:node /data
USER node
```

### 12.2 Two hard-won details carried over from the status fleet

Both are load-bearing and both were originally found the hard way, so they are
restated rather than left to be rediscovered:

- **`docker compose run` needs `-T` and `</dev/null`.** The deploy script is piped to
  `bash -s` over SSH, and `run` attaches stdin by default — without both, it consumes
  the rest of the script and every command below it silently never executes. This
  caused a deploy that reported success while doing nothing (`7ec5d71`).
- **No `docker image prune`, anywhere.** Every command stays scoped to this compose
  project so nothing can reach the panel's containers, images or network. Old layers
  are cleaned by hand (`5855d7e`).

### 12.3 Deploy gate

`docker compose run --rm --no-deps -T modlog node dist/preflight.js </dev/null` runs
against the newly built image before `up -d` replaces the running container. It is
read-only and never writes to Discord, so it is safe against production credentials,
and it exits non-zero on a missing `audit.read` — the failure mode §4.1 warns
otherwise presents as "no kicks have happened".

Resource use is negligible: one small Node process, a few HTTP calls a minute, and a
state file measured in kilobytes against the VPS's 40 GB.

## 13. Known limitations

**Team kills are inferred, not reported.** The game's kill feed carries no factions at
all. Warcon compares the factions it last *observed* for killer and victim
(`isTeamKill`, `src/lib/server/feed-core.ts:120`), and those observations come from a
status poll running on the order of tens of seconds while kills arrive every ~2s. A
player who switches sides shortly before a kill can be misclassified in either
direction.

This is acceptable for a log and a ping — both prompt a human to look, and neither is
evidence. It would **not** be acceptable as input to anything automatic, and anyone
extending this bot toward auto-kicking should treat that as a blocking objection
rather than a caveat.

**Career K/D describes a good player as readily as a cheat.** It is what was asked for
and it is cheap, but the sharper signal is Warcon's `kill_rate` trigger — kills in a
window and headshot share — whose own source comments note that even that "is a reason
for staff to look, never proof". Reaching it means widening the API key (§4.1).

**Polling adds latency.** Up to one poll interval, plus Warcon's own observation lag,
between an event and the ping.

## 14. Open decisions deferred

None blocking. Recorded so they are not rediscovered as surprises:

- Whether to widen the key for `kill_rate` flags (§4.1).
- Whether to move to the SSE stream if ping latency proves annoying (§5).
- Whether match recaps and kill highlights are worth adding; both are available on
  `server.view` and were explored but cut from this scope.
