# Tiered alerts: sweats and surges

Date: 2026-09-26. Amends `2026-09-24-wardogs-modlog-design.md` (the base spec): §8 rules and
pings, §10 configuration, §11 testing. Where the two disagree, this document wins.

## 1. Why

Pings were switched off (`PING_ON=none`) because every watched join and K/D flag mentioned the
mod role, which was too much. The staff want the channel ranked by how serious an alert is, and a
ping reserved for the serious end. They also want to spot two kinds of player the current alerts
miss:

- **Sweats**, who keep up a high kill rate week after week. 15 to 20 kills an hour is the usual
  mark of one on these servers.
- **Surges**, who are suddenly far better than their own record: the pattern a new cheat or a
  shared account leaves.

Both are read from the same leaderboard as the K/D alert, which is built from the game's own
scoreboard. **Neither needs the kill feed**, so both work today, while team-kill alerts wait on
the feed being set up.

## 2. Tiers

| Tier | Alert | Colour | Pings the mod role |
| --- | --- | --- | --- |
| 1 | Watched player joins | blue `0x3498db` | no |
| 2 | High K/D (unchanged rule, base spec §8.3) | orange `0xe67e22` | no |
| 3 | Sweat (§3) | red `0xe74c3c` | yes, unless `PING_ON` says otherwise |
| 3 | Surge (§4) | red `0xe74c3c` | yes, unless `PING_ON` says otherwise |

Every tiered embed carries a footer naming its tier, e.g. `Tier 1 · watchlist`,
`Tier 2 · high K/D`, `Tier 3 · sweat`, `Tier 3 · surge`, `Tier 3 · sweat + surge`, so colour is
never the only signal.

Untiered alerts keep their own colours and never ping: kicks, bans and unbans (grey
`0x6c757d`), feed quiet (brown `0x8a6d3b`), and team kills, which move to purple `0x9b59b6` so
they don't read as tier 3. **Team kills stop pinging.** Base spec §8.1's "the third team kill
pings" is withdrawn. `TEAM_KILL_PING_AT` is removed, and the embed still shows the running
count.

## 3. Sweat

A player whose kill rate over `SWEAT_RANGE` (default `30d`) is at least `SWEAT_PER_HOUR`
(default `15`), with at least `RATE_MIN_MINUTES` (default `180`, three hours) played in that
range.

- Source: `GET /api/servers/{id}/leaderboard?scope=server&range={SWEAT_RANGE}&sort=perHour&dir=desc&minMinutes={RATE_MIN_MINUTES}&page={n}`.
- Kill rate is computed by the bot from the row, with **Warcon's own formula**:
  `kills / ((minutes - seedMinutes) / 60)`, seeding time left out (a row without
  `seedMinutes` reads it as 0; no active minutes reads as 0 kills an hour). So the figure in
  the alert matches the panel's `perHour`, and the threshold never depends on how the panel
  rounds its own column. The alert's playtime is still total minutes played.
- Paging: fifty rows a page. Read page 1; read the next page only while the page was full and
  its last row is still at or above the threshold, by that same seed-excluded rate. That is
  the rate the panel sorts by, so paging can never stop early. Stop after four pages.

## 4. Surge

A player whose kill rate over `SURGE_RANGE` (default `7d`, at least `RATE_MIN_MINUTES` played in
it) is:

- at least `SURGE_PER_HOUR` (default `10`), so a jump from 2 to 3 an hour is not a surge; and
- at least `SURGE_RATIO` (default `1.5`) times their **usual rate on that server**.

**Usual rate** is all-time kills over all-time minutes on that server, from the player's dossier
(`GET /api/servers/{id}/players/{steamId}`, the `perServer` entry whose `serverId` matches).
There is no surge unless that entry holds at least `SURGE_HISTORY_MINUTES` (default `600`, ten
hours): a player's first week is not compared against almost nothing. The all-time figure
includes the recent week. That makes a surge slightly harder to trigger, never easier, and is
accepted.

**Seeding.** The usual rate includes seeding time, and the dossier does not say how much of it
was seeding. So a surge compares **seed-inclusive** rates: the recent rate, the
`SURGE_PER_HOUR` floor and the ratio all use `kills / (minutes / 60)`, unlike the sweat (§3).
This is a known bias: a player who seeded heavily in the past and little this week can read as
a mild surge. Removing it needs a seed-excluded usual rate, which the dossier doesn't expose.
The embed labels the surge's figure `Recent kills/hour` so it is not confused with a sweat's.

- Candidates come from the `SURGE_RANGE` leaderboard, sorted by `perHour`, paged as in §3 while
  rows are at or above `SURGE_PER_HOUR` by the panel's seed-excluded rate (never below the
  inclusive one, so paging cannot stop early); the seed-inclusive floor is applied after. A
  candidate who is already a sweat this run is looked up first, so their surge part joins the
  same alert instead of pinging separately on a later run; the rest are taken highest recent
  rate first.
- **Panel load.** Warcon does not rate-limit authenticated key reads, but each dossier is
  several database queries and may refresh the player's Steam data, and the bot's regular
  polling already makes three or four reads per server every 30 seconds. To bound the load a
  run puts on the panel, the bot:
  - **caches** each usual rate for 24 hours in state (`baselines`, keyed `serverId:steamId`,
    holding `perHour`, `minutes` and `at`); and
  - makes **at most 10 dossier lookups per server per hourly run**. Candidates past the cap are
    looked up on a later run, highest rate first, so a real surge is reached within a few hours
    even on a busy server.
- The dossier read needs only `server.view`. The watch reason it withholds (base spec §5.3) is
  not used here.

## 5. One alert per player

A player can be a sweat and surging at once. The two are merged into **one** event and one
embed, so one person never pings twice. The new event kind:

```ts
interface KillRateEvent {
  kind: 'killRate';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
  sweat: { perHour: number; kills: number; minutes: number; range: string } | null; // perHour seed-excluded (§3)
  surge: {
    perHour: number;          // over SURGE_RANGE, seeding included (§4)
    minutes: number;          // played over SURGE_RANGE
    usualPerHour: number;     // all-time on this server
    usualMinutes: number;
    ratio: number;            // perHour / usualPerHour
    range: string;
  } | null;
}
```

At least one of `sweat` and `surge` is non-null. The embed:

- Title: `{label} · Sweat — {name}`, `Surge — {name}` or `Sweat + surge — {name}`.
- Fields: kills per hour and playtime for each part present (the surge's rate is labelled
  `Recent kills/hour`, so the two stay distinct even when both ranges match); for a surge, the
  usual rate and the ratio (`1.8×`).
- Link: the player's dossier, as the K/D embed already does.

A usual rate of zero, where the player has history but no recorded kills, makes the ratio
infinite. It counts as a surge and the embed shows `new`, not a ratio.

## 6. Cooldown and pings

- **Cooldown.** Sweat and surge each have their own cooldown of `KD_COOLDOWN_DAYS` (default 7;
  it now governs all three rate alerts, and the name is kept so existing `.env` files keep
  working). The cooldowns live in state as `rateAlerted`, keyed `sweat:{steamId}` and
  `surge:{steamId}`. Like `kdAlerted`, they are global across servers.
- **Escalation** drops whichever part is still cooling. If both parts are dropped, nothing
  posts. It stamps the parts that post.
- **Pings.** The event pings when any part it carries is listed in `PING_ON`.
- **`PING_ON`** now lists tier-3 kinds only: `sweat`, `surge`, or `none`. The default, when
  unset or blank, is both. The old kinds (`teamKill`, `watchedJoin`, `highKd`) are rejected at
  startup with an error explaining that only tier-3 alerts ping. The deploy's preflight then
  fails instead of starting a bot that ignores the setting.

**Operator note.** The live VPS has `PING_ON=none`. After this ships, remove that line to get
tier-3 pings.

## 7. Scheduling and failure

- The kill-rate source runs on the K/D schedule (`KD_POLL_INTERVAL_MS`, hourly), as a fifth
  source. Like K/D, it has no cursor, so it never gates a server's warm state.
- **A failed read.** If a leaderboard read or a dossier lookup throws, the whole source fails
  for that server for that run: the runner logs it and the next hourly run retries. Sweat
  results from a run whose surge lookups failed are *not* posted early. Delaying one hour is
  preferred to posting half a picture.
- **A failed post.** The runner's rollback (base spec §9) covers `rateAlerted` and
  `baselines` the same way it covers `kdAlerted`. A delivered kill-rate alert keeps its cooldown
  stamps. Its retry key is `killRate:{serverId}:{steamId}`.
- **Pruning.** Before saving, `rateAlerted` entries older than the cooldown are pruned, and
  `baselines` older than 24 hours.
- **Preflight.** Per server, the deploy's preflight reads page 1 of the `SWEAT_RANGE` board
  sorted by `perHour` (with `RATE_MIN_MINUTES`) and fails unless the panel echoes
  `query.sort === 'perHour'`: Warcon silently falls back to another sort for one it doesn't
  know. If that board has a row, it reads the first row's dossier and fails unless
  `dossier.perServer` is a list; an empty board is ok ("no rows to sample").

## 8. Configuration

Added, all optional:

```
SWEAT_PER_HOUR             15
SWEAT_RANGE                30d
SURGE_RANGE                7d
SURGE_PER_HOUR             10
SURGE_RATIO                1.5
SURGE_HISTORY_MINUTES      600
RATE_MIN_MINUTES           180
PING_ON                    sweat,surge   (or none)
```

- The ranges accept what the leaderboard accepts: `7d`, `30d`, `90d`, `all`. Anything else fails
  at startup.
- **Removed:** `TEAM_KILL_PING_AT`. A leftover value in `.env` is ignored.

## 9. Testing

- **Source (`sources/killrate.ts`)**, against leaderboard and dossier fixtures:
  - The sweat threshold is inclusive.
  - Paging stops on a short page, on a row below the threshold, and at four pages.
  - A surge needs the ratio, the floor and the history.
  - A cached baseline skips the dossier call.
  - A stale (24h+) cached baseline is refreshed.
  - The ten-lookup cap is respected, highest rate first.
  - A zero usual rate reads as `new`.
  - A missing `perServer` entry is no surge.
  - Sweat and surge for one player merge into one event.
  - A dossier failure fails the source.
- **Escalation:**
  - Tier-3 events ping per `PING_ON`.
  - Watched joins, K/D and team kills never ping.
  - The cooldown is per part, and both parts cooling means no post.
- **Discord:** tier colours and footers for every tiered kind; the merged title; `new` in place
  of an infinite ratio; field limits.
- **Runner:** a failed post rolls back `rateAlerted` and `baselines` and re-stamps delivered
  kill-rate alerts; pruning.
- **Config:** new defaults; range validation; `PING_ON` accepts `sweat`/`surge`/`none` and
  rejects the old kinds with the tier-3 message.

## 10. Out of scope

- Sweat and surge thresholds per server: one setting covers all six.
- Anything needing the kill feed: headshot share, weapon mix.
- Routing tiers to different channels.
