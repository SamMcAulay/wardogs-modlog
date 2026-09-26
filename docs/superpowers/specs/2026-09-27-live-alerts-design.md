# Live alerts: who is a problem right now

Date: 2026-09-27. Amends the base spec `2026-09-24-wardogs-modlog-design.md` and supersedes
most of `2026-09-26-tiered-alerts-design.md`. Where they disagree, this document wins.

## 1. Why

The tiered alerts posted lists. Each hour the bot posted everyone over a sweat, K/D or surge
line, and re-posted them when their cooldown ran out. The staff don't want a weekly roll-call
of every good player. With this many players it becomes noise they learn to ignore. They want
to know **who is a problem in the moment**.

So from now on, every player alert means **this person is on a server now**. Nothing posts
because a list was refreshed.

## 2. What posts

| Tier | Alert | When | Colour | Pings |
| --- | --- | --- | --- | --- |
| 1 | Watched player joined | on connect, as today | blue `0x3498db` | no |
| 2 | Known sweat / high K/D joined | on connect, at most once per `JOIN_ALERT_HOURS` per player | orange `0xe67e22` | no |
| 3 | Hot right now | during a match, once per player per match | red `0xe74c3c` | yes, unless `PING_ON=none` |

- **One post per connection.** A player who joins carrying more than one tag gets one alert that
  lists every tag, at the highest tier they reach. For example, "Joined: watched · sweat" is tier 2.
- **Unchanged:** kicks, bans and unbans (grey), team kills (purple, no ping) and feed quiet
  (brown).
- **Removed:** the hourly sweat, high-K/D and surge alerts; their cooldowns (`kdAlerted`,
  `rateAlerted`); surges and everything they needed (dossier lookups, the `baselines` cache,
  every `SURGE_*` setting); and `KD_COOLDOWN_DAYS`.

## 3. Tier 3: hot right now

Every cycle (`POLL_INTERVAL_MS`, 30 s), the bot already reads each server's summary. The summary
carries each player's `kills` and `deaths` in the current match, and `status.matchSeconds`, the
match clock.

For each player on the server, the bot works out:

```
minutesInMatch = (matchSeconds - firstSeen) / 60
perHour        = kills / (minutesInMatch / 60)
```

A player is **hot** when all three hold:

| Setting | Default | Condition |
| --- | --- | --- |
| `LIVE_PER_HOUR` | 20 | `perHour ≥ LIVE_PER_HOUR` |
| `LIVE_MIN_MINUTES` | 20 | `minutesInMatch ≥ LIVE_MIN_MINUTES` |
| `LIVE_MIN_KILLS` | 8 | `kills ≥ LIVE_MIN_KILLS` |

The default is 20 rather than the 15 that marks a sustained sweat, because one match is a short,
noisy window. All three are settings. A hot player posts **once per match**.

### 3.1 When a player was first seen in the match

`firstSeen` is the match clock when the bot first saw that player in the current match. The
rules are chosen so the bot never *overstates* a rate:

- **Players present at the bot's first observation of a match** get `firstSeen = 0`. That covers a
  fresh boot, a server newly added, and the first cycle after a match boundary. The bot can't
  know when they joined, so it assumes the start of the match. That makes their time longer and
  their rate lower.
- **Players who appear later in the same match** get the match clock at that cycle.
- **A reconnect mid-match keeps the original `firstSeen`.** The scoreboard may reset their kills,
  which again only lowers the rate.

### 3.2 Match boundaries and missing data

- **A new match** is detected when `matchSeconds` is lower than the last value seen for that
  server. It clears `firstSeen` and the record of who has already been alerted this match.
- **A null `matchSeconds`** means an idle server or a build that doesn't report it. There is no
  live check that cycle, and the bot neither advances nor clears the match state.

### 3.3 State

The match state lives in the server's entry, so it is saved, survives a restart, and is covered
by the runner's rollback (base spec §9):

```ts
match: {
  lastMatchSeconds: number | null;   // null = no match observed yet
  firstSeen: Record<string, number>; // steamId -> match clock when first seen
  alerted: string[];                 // steamIds already posted as hot this match
}
```

A player is added to `alerted` when the event is emitted. A failed post rolls the whole server
entry back, so the next cycle re-emits them.

## 4. Tier 2: known players joining

### 4.1 The lists

Every `KD_POLL_INTERVAL_MS` (hourly), the bot refreshes two lists per server. It keeps them in
the server's entry and **does not post them**:

- **Sweats:** 15+ kills per hour (`SWEAT_PER_HOUR`) over `SWEAT_RANGE` (30d), with at least
  `RATE_MIN_MINUTES` (180) played. Seeding is excluded (Warcon's own `perHour`). The leaderboard
  is read and paged exactly as in tiered-alerts §3, including the seed-excluded page-stop.
- **High K/D:** K/D of `KD_THRESHOLD` (4) or more over `KD_RANGE` (30d), with at least
  `KD_MIN_MATCHES` (5) matches and `KD_MIN_MINUTES` (60). Zero deaths is not infinite. These are
  the existing rules.

The lists are stored as `knownSweats: string[]`, `knownHighKd: string[]` and
`knownAt: number | null` (epoch ms of the last successful refresh).

- **A refresh fails:** the old lists stay.
- **The lists are empty** (they have never loaded): joins carry only the watched tag.

### 4.2 The join alert

- **Detecting a join:** the existing presence diff. A player in this cycle's roster who wasn't
  in the last one has joined.
- **Tagging:** each joiner is checked against the watchlist (the existing `players/marks` call)
  and against that server's `knownSweats` and `knownHighKd`.
- **What posts:** a joiner with at least one tag produces one `playerJoined` event.

### 4.3 The once-a-day limit

- **Scope:** the limit applies to the **sweat and high-K/D tags** only.
- **Where it's kept:** `joinAlerted: Record<steamId, epoch ms>` in the global state. It is global,
  like the old `kdAlerted`.
- **Dropping tags:** if the player was posted with a known tag within `JOIN_ALERT_HOURS` (default
  24), escalation drops those tags from the event.
- **The watched tag:** still alerts on every connect, as it does today.
- **Posting:** if no tag is left, nothing posts. When known tags do post, `joinAlerted` is
  stamped.

## 5. Events

`watchedJoin`, `highKd` and `killRate` are removed. Two kinds are added:

```ts
interface PlayerJoinedEvent {
  kind: 'playerJoined';
  serverId: string; at: string; steamId: string; name: string;
  watched: boolean; sweat: boolean; highKd: boolean;   // at least one true
}

interface HotPlayerEvent {
  kind: 'hotPlayer';
  serverId: string; at: string; steamId: string; name: string;
  kills: number; deaths: number; minutes: number; perHour: number;
}
```

| | `playerJoined` | `hotPlayer` |
| --- | --- | --- |
| `eventKey` | `playerJoined:{server}:{steamId}:{at}` | `hotPlayer:{server}:{steamId}:{at}` |
| `retryKey` | `playerJoined:{server}:{steamId}` | `hotPlayer:{server}:{steamId}` |

**Embeds:**

- **playerJoined:** titled `Joined — {name}`, with a `Tags` field (e.g. `watched · sweat`).
  - Watched only: tier 1, blue, footer `Tier 1 · watchlist`, and the existing dossier hint.
  - Any known tag: tier 2, orange, footer `Tier 2 · known player`.
- **hotPlayer:** titled `Hot right now — {name}`, with fields `Kills / deaths`,
  `Minutes this match` and `Kills/hour`. Tier 3, red, footer `Tier 3 · hot right now`.
- Both link to the player's panel page.

## 6. Sources and scheduling

| Source | Runs | Cursor (gates warmth) | Replaces |
| --- | --- | --- | --- |
| `kills` | every cycle | yes | — |
| `audit` | every cycle | yes | — |
| `known` | on the K/D schedule, **before** `presence` | no | `kd`, `killRate` |
| `presence` | every cycle | yes | `watchlist` |

- **`known`** refreshes the lists and returns no events. Running it before `presence` means a
  fresh list applies to the same cycle's joins.
- **`presence`** reads the summary once. It produces both `playerJoined` and `hotPlayer`, and owns
  `presentSteamIds` and `match`.
- **The roster** is committed only after every marks call succeeds, as today.
- **Cold start:** a server that isn't warm posts nothing (base spec §7). Its first cycle records
  the roster and match state, so everyone already on the server isn't reported as joining.

## 7. Pings and settings

- **Pings:** `PING_ON` now takes `live` (the default, when unset or blank) or `none`. Any other
  value fails at startup:
  - `sweat`, `surge`, `teamKill`, `watchedJoin` and `highKd` get an error explaining that only the
    live alert pings;
  - any other value gets the unknown-kind error.
- **Added:** `LIVE_PER_HOUR` 20, `LIVE_MIN_MINUTES` 20, `LIVE_MIN_KILLS` 8, `JOIN_ALERT_HOURS` 24.
- **Kept:** `KD_POLL_INTERVAL_MS`, which now refreshes the known lists; `KD_THRESHOLD`,
  `KD_MIN_MATCHES`, `KD_MIN_MINUTES`, `KD_RANGE`, `SWEAT_PER_HOUR`, `SWEAT_RANGE` and
  `RATE_MIN_MINUTES`.
- **Removed:** `KD_COOLDOWN_DAYS`, `SURGE_RANGE`, `SURGE_PER_HOUR`, `SURGE_RATIO` and
  `SURGE_HISTORY_MINUTES`. A leftover value in `.env` is ignored.

**Operator note.** Production has `PING_ON=none`. It can stay while the new alerts settle. Remove
it to get tier-3 pings.

## 8. State compatibility

- **Old state files:** `loadState` drops `kdAlerted`, `rateAlerted` and `baselines` if present.
  It back-fills `joinAlerted: {}`, and each server's `match`, `knownSweats`, `knownHighKd` and
  `knownAt` with empty defaults.
- **Warm servers stay warm.** A server's first cycle after the upgrade still sees its existing
  roster in `presentSteamIds`, so players already on it are not reported as joining.

## 9. Preflight

- **Removed:** the dossier check, since there are no more dossier reads.
- **Kept:** the `perHour` board check, which the sweat list needs.
- **Added:** a live-data check per server. It reads the summary and reports `ok` with detail:
  - `live check active` when `status.matchSeconds` is a number;
  - `no match clock — live alerts inactive until the server reports one` when it isn't.

  It never fails a deploy, because an empty server legitimately has no match.

## 10. Testing

- **Presence:**
  - Players at the first observation get `firstSeen` 0.
  - A later joiner gets the current clock.
  - Hot at exactly each threshold (inclusive).
  - Not hot below any of the three.
  - Once per match.
  - A match boundary resets, so the same player can alert again in the next match.
  - A null clock skips the live check without touching the match state.
  - A reconnect keeps `firstSeen`.
  - Join tags come from marks and the known lists.
  - A joiner with no tag posts nothing.
  - A failed marks call leaves the roster uncommitted (existing).
- **Known lists:**
  - Refresh from both boards (sweat paging as before).
  - A failed refresh keeps the old lists.
  - The zero-deaths rule is unchanged.
- **Escalation:**
  - Known tags are dropped within `JOIN_ALERT_HOURS`; the watched tag never is.
  - Nothing posts when no tag is left.
  - Only `hotPlayer` pings, and only per `PING_ON`.
- **Runner:**
  - Source order: known before presence.
  - A failed post rolls back `match.alerted` and `joinAlerted`, and re-stamps delivered joins.
  - `joinAlerted` is pruned past `JOIN_ALERT_HOURS`.
- **State:** an old file with `kdAlerted`/`rateAlerted`/`baselines` loads with them dropped and the
  new fields defaulted.
- **Config:** the new defaults, `PING_ON` values, and the removed settings no longer on `Config`.
- **Discord:** the tier, colour and footer for each join combination and for `hotPlayer`; the
  tags text.
- **Preflight:** the live-data check reads `ok` both with and without a match clock.

## 11. Out of scope

- Live K/D (deaths are too few in one match to mean much).
- Per-server live thresholds.
- Anything needing the kill feed, such as weapon, headshots or distance.
