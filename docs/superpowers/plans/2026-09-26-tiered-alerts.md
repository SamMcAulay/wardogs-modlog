# Tiered Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank the bot's alerts into three coloured tiers, reserve the mod-role ping for tier 3, and add two tier-3 alerts: sweats (15+ kills an hour sustained) and surges (a player's recent rate well above their own usual).

**Architecture:**
- A new `killRate` event carries an optional sweat part and an optional surge part, so one player produces one alert.
- A new source reads the leaderboard sorted by kills per hour, and reads each candidate's dossier for their usual rate. Usual rates are cached in state for 24 hours and capped at 10 lookups per server per run.
- Escalation applies per-part cooldowns and pings only tier-3 kinds listed in `PING_ON`.
- Discord colours embeds by tier and names the tier in a footer.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, `@discordjs/rest`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-26-tiered-alerts-design.md`. It amends `docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md`; read both.

## Global Constraints

- Node 22, ESM, and every relative import ends in `.js`.
- Tests run with `npx vitest run`. The typecheck is `npm run typecheck`, which covers `src` and `tests`. Both must be clean before each commit.
- The Warcon key holds `server.view` + `audit.read` only. The dossier read (`GET /api/servers/{id}/players/{steamId}`) needs only `server.view`.
- Kill rate is always computed by the bot as `kills / (minutes / 60)`, never read from a panel column.
- At most 10 dossier lookups per server per run. Usual rates are cached for 24 hours (`BASELINE_TTL_MS = 86_400_000`).
- Only tier-3 alerts (`killRate`) may ping. Team kills, watched joins, K/D, kicks, bans and feed quiet never ping.
- Colours: tier 1 `0x3498db`, tier 2 `0xe67e22`, tier 3 `0xe74c3c`, team kill `0x9b59b6`, admin action `0x6c757d`, feed quiet `0x8a6d3b`.
- Commit messages: a subject line, then a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` on its own line. Use a heredoc (`git commit -F - <<'MSG' … MSG`).

## Review Focus

1. **A player who is both a sweat and surging** must produce exactly one event, one decision and at most one ping (Task 4 merge test; Task 2 escalation test).
2. **A rate exactly at a threshold** (15.0 kills an hour, or a ratio of exactly 1.5) counts: every threshold is inclusive (Task 4).
3. **A player whose dossier has no entry for this server**, because they only played elsewhere, must be no surge and must not crash (Task 4).
4. **A busy server with more than 10 uncached candidates** makes only 10 dossier calls, highest recent rate first. A later run, with those cached, reaches the rest (Task 4).
5. **The state file already on the VPS**, which has no `rateAlerted` or `baselines`, must load cleanly, with both empty (Task 1).

---

### Task 1: State and settings for rate alerts

**Files:**
- Modify: `src/state.ts`
- Modify: `src/config.ts`
- Test: `tests/state.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  - In `state.ts`:
    - `export interface Baseline { perHour: number; minutes: number; at: number }`
    - `export const BASELINE_TTL_MS = 86_400_000`
    - `State.rateAlerted: Record<string, number>`, keyed `sweat:{steamId}` / `surge:{steamId}`
    - `State.baselines: Record<string, Baseline>`, keyed `{serverId}:{steamId}`
  - In `config.ts`:
    - `export const BOARD_RANGES = ['7d', '30d', '90d', 'all'] as const`
    - `Config` gains `sweatPerHour: number`, `sweatRange: string`, `surgeRange: string`, `surgePerHour: number`, `surgeRatio: number`, `surgeHistoryMinutes: number` and `rateMinMinutes: number`.

- [ ] **Step 1: Write the failing state tests**

Add to `tests/state.test.ts`, inside its top-level `describe` or as a new one. Import `emptyState`, `loadState` and `saveState` from `../src/state.js`, alongside whatever the file already imports:

```ts
describe('rate-alert state', () => {
  test('a fresh state has empty rate cooldowns and baselines', () => {
    const s = emptyState();
    expect(s.rateAlerted).toEqual({});
    expect(s.baselines).toEqual({});
  });

  test('a state file written before rate alerts loads with both empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'modlog-state-'));
    const path = join(dir, 'state.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, servers: {}, kdAlerted: { '765': 1 }, startedAt: 1 }),
      'utf8'
    );
    const s = await loadState(path);
    expect(s.rateAlerted).toEqual({});
    expect(s.baselines).toEqual({});
    expect(s.kdAlerted).toEqual({ '765': 1 });
  });

  test('rate cooldowns and baselines survive a save and load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'modlog-state-'));
    const path = join(dir, 'state.json');
    const s = emptyState();
    s.rateAlerted['sweat:765'] = 42;
    s.baselines['s1:765'] = { perHour: 12.5, minutes: 900, at: 7 };
    await saveState(path, s);
    const back = await loadState(path);
    expect(back.rateAlerted).toEqual({ 'sweat:765': 42 });
    expect(back.baselines).toEqual({ 's1:765': { perHour: 12.5, minutes: 900, at: 7 } });
  });
});
```

Make sure the file imports `mkdtemp` and `writeFile` from `node:fs/promises`, `tmpdir` from `node:os` and `join` from `node:path`. Add any that are missing.

- [ ] **Step 2: Write the failing config tests**

In `tests/config.test.ts`, extend the `applies documented defaults` test with these expectations (keep its existing lines):

```ts
    expect(c.sweatPerHour).toBe(15);
    expect(c.sweatRange).toBe('30d');
    expect(c.surgeRange).toBe('7d');
    expect(c.surgePerHour).toBe(10);
    expect(c.surgeRatio).toBe(1.5);
    expect(c.surgeHistoryMinutes).toBe(600);
    expect(c.rateMinMinutes).toBe(180);
```

and add:

```ts
  test('rate ranges accept the leaderboard ranges', () => {
    const c = loadConfig({ ...base, SWEAT_RANGE: '90d', SURGE_RANGE: 'all' });
    expect(c.sweatRange).toBe('90d');
    expect(c.surgeRange).toBe('all');
  });

  test('a rate range the leaderboard does not accept fails at startup, naming the variable', () => {
    expect(() => loadConfig({ ...base, SURGE_RANGE: '14d' })).toThrow(
      /SURGE_RANGE must be one of 7d, 30d, 90d, all/
    );
  });
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run tests/state.test.ts tests/config.test.ts`
Expected: FAIL. `rateAlerted`/`baselines` are undefined, and the config fields are undefined.

- [ ] **Step 4: Implement the state fields**

In `src/state.ts`, add above `export interface State`:

```ts
/** A player's all-time kill rate on one server, as last read from their dossier. */
export interface Baseline {
  perHour: number;
  minutes: number;
  /** epoch ms of the lookup */
  at: number;
}

/** How long a looked-up usual rate is trusted before it is read again (tiered-alerts spec §4). */
export const BASELINE_TTL_MS = 86_400_000;
```

In `State`, after `kdAlerted`:

```ts
  /** `sweat:{steamId}` / `surge:{steamId}` -> epoch ms of the last alert of that kind */
  rateAlerted: Record<string, number>;
  /** `{serverId}:{steamId}` -> that player's usual rate on that server */
  baselines: Record<string, Baseline>;
```

In `emptyState()`:

```ts
  return {
    version: 1,
    servers: {},
    kdAlerted: {},
    rateAlerted: {},
    baselines: {},
    startedAt: Date.now()
  };
```

In `loadState`'s returned object, after `kdAlerted: parsed.kdAlerted ?? {},`:

```ts
      rateAlerted: parsed.rateAlerted ?? {},
      baselines: parsed.baselines ?? {},
```

- [ ] **Step 5: Implement the settings**

In `src/config.ts`, add below the imports:

```ts
/** The `range` values Warcon's leaderboard accepts. */
export const BOARD_RANGES = ['7d', '30d', '90d', 'all'] as const;
```

In `interface Config`, after `feedQuietMinutes: number;`:

```ts
  sweatPerHour: number;
  sweatRange: string;
  surgeRange: string;
  surgePerHour: number;
  surgeRatio: number;
  surgeHistoryMinutes: number;
  rateMinMinutes: number;
```

Inside `loadConfig`, after the `num` helper:

```ts
  const range = (key: string, fallback: string): string => {
    const value = (env[key] ?? '').trim() || fallback;
    if (!(BOARD_RANGES as readonly string[]).includes(value)) {
      throw new Error(`${key} must be one of ${BOARD_RANGES.join(', ')}, got: ${value}`);
    }
    return value;
  };
```

and in the returned object, after `feedQuietMinutes: …`:

```ts
    sweatPerHour: num('SWEAT_PER_HOUR', 15),
    sweatRange: range('SWEAT_RANGE', '30d'),
    surgeRange: range('SURGE_RANGE', '7d'),
    surgePerHour: num('SURGE_PER_HOUR', 10),
    surgeRatio: num('SURGE_RATIO', 1.5),
    surgeHistoryMinutes: num('SURGE_HISTORY_MINUTES', 600),
    rateMinMinutes: num('RATE_MIN_MINUTES', 180)
```

(Add a trailing comma to `feedQuietMinutes`.)

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run tests/state.test.ts tests/config.test.ts && npx vitest run && npm run typecheck`
Expected: all PASS, typecheck clean. If the typecheck reports a test fixture that builds a
full `Config` (for example in `tests/preflight.test.ts`) or a full `State` object, add the new
fields to it with their defaults. Don't change the fixture's other values.

- [ ] **Step 7: Commit**

```bash
git add src/state.ts src/config.ts tests/state.test.ts tests/config.test.ts
git commit -F - <<'MSG'
feat: state and settings for sweat and surge alerts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 2: The kill-rate event, escalation and `PING_ON`

**Files:**
- Modify: `src/events.ts`, `src/escalate.ts`, `src/config.ts`, `src/runner.ts` (`retryKey` only), `src/discord.ts` (the `killRate` embed only), `src/index.ts` (escalate config only)
- Test: `tests/escalate.test.ts` (rewritten), `tests/config.test.ts`, `tests/runner.test.ts` (fixture only), `tests/discord.test.ts`, `tests/events.test.ts`

**Interfaces:**
- Consumes: `State.rateAlerted` (Task 1).
- Produces:
  - In `events.ts`:
    - `SweatPart { perHour: number; kills: number; minutes: number; range: string }`
    - `SurgePart { perHour: number; minutes: number; usualPerHour: number; usualMinutes: number; ratio: number; range: string }`, where `ratio` is `Infinity` when `usualPerHour` is 0
    - `KillRateEvent { kind: 'killRate'; serverId; at; steamId; name; sweat: SweatPart | null; surge: SurgePart | null }`, added to `ModEvent`
  - `eventKey` gives `killRate:{serverId}:{steamId}:{at}`, and `retryKey` gives `killRate:{serverId}:{steamId}`.
  - In `escalate.ts`:
    - `PING_KINDS = ['sweat', 'surge'] as const`
    - `EscalateConfig = { kdCooldownDays: number; pingOn: ReadonlySet<PingKind> }`, with `teamKillPingAt` removed
  - `Config.teamKillPingAt` is removed.

- [ ] **Step 1: Replace `tests/escalate.test.ts` with the new rules**

```ts
import { describe, expect, test } from 'vitest';
import { escalate, PING_KINDS, type EscalateConfig } from '../src/escalate.js';
import { emptyState } from '../src/state.js';
import type { KillRateEvent, ModEvent, TeamKillEvent } from '../src/events.js';

const cfg: EscalateConfig = { kdCooldownDays: 7, pingOn: new Set(PING_KINDS) };
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const DAY = 86_400_000;

const tk = (eventId: string, eventTime: number, killer = '765'): TeamKillEvent => ({
  kind: 'teamKill',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  eventId,
  eventTime,
  killer: { steamId: killer, name: 'Alpha', faction: 'Valkyra' },
  victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
  cause: 'Id.Item.AK74M',
  distanceM: 40,
  count: 0
});

const kd = (steamId = '765'): ModEvent => ({
  kind: 'highKd',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  steamId,
  name: 'Alpha',
  kd: 5.2,
  kills: 52,
  deaths: 10,
  matches: 9,
  minutes: 400
});

const sweat = { perHour: 17, kills: 170, minutes: 600, range: '30d' };
const surge = {
  perHour: 21,
  minutes: 300,
  usualPerHour: 12,
  usualMinutes: 6000,
  ratio: 1.75,
  range: '7d'
};

const rate = (over: Partial<KillRateEvent> = {}): KillRateEvent => ({
  kind: 'killRate',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  steamId: '765',
  name: 'Alpha',
  sweat,
  surge: null,
  ...over
});

describe('team kills', () => {
  test('never ping, however many there are', () => {
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30), tk('d', 40)], emptyState(), cfg, NOW);
    expect(out.every((d) => d.ping === false)).toBe(true);
  });

  test('the running count is stamped onto the event', () => {
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30)], emptyState(), cfg, NOW);
    expect(out.map((d) => (d.event as TeamKillEvent).count)).toEqual([1, 2, 3]);
  });

  test('counts are kept per killer', () => {
    const out = escalate([tk('a', 10, 'X'), tk('b', 20, 'Y'), tk('c', 30, 'X')], emptyState(), cfg, NOW);
    expect(out.map((d) => (d.event as TeamKillEvent).count)).toEqual([1, 1, 2]);
  });

  test('the count survives across cycles via state', () => {
    const state = emptyState();
    escalate([tk('a', 10), tk('b', 20)], state, cfg, NOW);
    const out = escalate([tk('c', 30)], state, cfg, NOW);
    expect((out[0]!.event as TeamKillEvent).count).toBe(3);
  });

  test('a match boundary resets the count', () => {
    const state = emptyState();
    escalate([tk('a', 300), tk('b', 310)], state, cfg, NOW);
    const out = escalate([tk('c', 5)], state, cfg, NOW);
    expect((out[0]!.event as TeamKillEvent).count).toBe(1);
  });
});

describe('tiers 1 and 2 never ping', () => {
  test('a watched join posts without a ping', () => {
    const out = escalate(
      [{ kind: 'watchedJoin', serverId: 's1', at: '2026-09-24T12:00:00.000Z', steamId: '9', name: 'W' }],
      emptyState(),
      cfg,
      NOW
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(false);
  });

  test('a K/D flag posts without a ping and starts its cooldown', () => {
    const state = emptyState();
    const out = escalate([kd()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(false);
    expect(state.kdAlerted['765']).toBe(NOW);
  });

  test('a K/D re-flag inside the cooldown is dropped', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 2 * DAY;
    expect(escalate([kd()], state, cfg, NOW)).toHaveLength(0);
  });

  test('a K/D re-flag after the cooldown posts again', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 8 * DAY;
    expect(escalate([kd()], state, cfg, NOW)).toHaveLength(1);
  });
});

describe('untiered alerts never ping', () => {
  test('admin actions and a quiet feed', () => {
    const out = escalate(
      [
        {
          kind: 'adminAction',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          auditId: 1,
          action: 'rcon.ban',
          actorName: 'mod',
          target: '765',
          reason: 'griefing'
        },
        { kind: 'feedQuiet', serverId: 's1', at: '2026-09-24T12:00:00.000Z', lastFeedAt: null }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out.map((d) => d.ping)).toEqual([false, false]);
  });
});

describe('tier 3: kill rate', () => {
  test('a sweat pings and starts its own cooldown', () => {
    const state = emptyState();
    const out = escalate([rate()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
    expect(state.rateAlerted['sweat:765']).toBe(NOW);
    expect(state.rateAlerted['surge:765']).toBeUndefined();
  });

  test('a sweat that is also surging is one decision with one ping, both parts stamped', () => {
    const state = emptyState();
    const out = escalate([rate({ surge })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(true);
    expect(state.rateAlerted['sweat:765']).toBe(NOW);
    expect(state.rateAlerted['surge:765']).toBe(NOW);
  });

  test('a part still cooling is removed from the event; the other still posts', () => {
    const state = emptyState();
    state.rateAlerted['sweat:765'] = NOW - 2 * DAY;
    const out = escalate([rate({ surge })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    const e = out[0]!.event as KillRateEvent;
    expect(e.sweat).toBeNull();
    expect(e.surge).toEqual(surge);
    expect(state.rateAlerted['sweat:765']).toBe(NOW - 2 * DAY);
  });

  test('both parts cooling posts nothing', () => {
    const state = emptyState();
    state.rateAlerted['sweat:765'] = NOW - DAY;
    state.rateAlerted['surge:765'] = NOW - DAY;
    expect(escalate([rate({ surge })], state, cfg, NOW)).toHaveLength(0);
  });

  test('a cooldown past KD_COOLDOWN_DAYS no longer suppresses', () => {
    const state = emptyState();
    state.rateAlerted['sweat:765'] = NOW - 8 * DAY;
    expect(escalate([rate()], state, cfg, NOW)).toHaveLength(1);
  });

  test('PING_ON=none posts tier 3 without a ping but still stamps the cooldown', () => {
    const state = emptyState();
    const off: EscalateConfig = { ...cfg, pingOn: new Set() };
    const out = escalate([rate()], state, off, NOW);
    expect(out[0]!.ping).toBe(false);
    expect(state.rateAlerted['sweat:765']).toBe(NOW);
  });

  test('PING_ON=surge pings a surge but not a sweat on its own', () => {
    const onlySurge: EscalateConfig = { ...cfg, pingOn: new Set(['surge'] as const) };
    const sweatOnly = escalate([rate()], emptyState(), onlySurge, NOW);
    const both = escalate([rate({ surge })], emptyState(), onlySurge, NOW);
    expect(sweatOnly[0]!.ping).toBe(false);
    expect(both[0]!.ping).toBe(true);
  });
});
```

- [ ] **Step 2: Update the config tests for the new `PING_ON`**

In `tests/config.test.ts`:
- **Defaults:** in `applies documented defaults`, delete `expect(c.teamKillPingAt).toBe(3);`. Replace the `pingOn` expectation with `expect([...c.pingOn].sort()).toEqual(['surge', 'sweat']);`.
- **Old tests:** delete the tests named `PING_ON=none turns every ping off`, `PING_ON lists the kinds that ping, trimmed` and `PING_ON names an unknown kind in its error`.
- **New tests:** add these:

```ts
  test('PING_ON=none turns every ping off', () => {
    expect(loadConfig({ ...base, PING_ON: 'none' }).pingOn.size).toBe(0);
  });

  test('PING_ON lists the tier-3 kinds that ping, trimmed', () => {
    expect([...loadConfig({ ...base, PING_ON: ' surge ' }).pingOn]).toEqual(['surge']);
  });

  test('PING_ON rejects a kind that no longer pings, saying why', () => {
    expect(() => loadConfig({ ...base, PING_ON: 'watchedJoin' })).toThrow(
      /PING_ON entry "watchedJoin" no longer pings: only tier-3 alerts \(sweat, surge\)/
    );
  });

  test('PING_ON names an unknown kind in its error', () => {
    expect(() => loadConfig({ ...base, PING_ON: 'sweat,kicks' })).toThrow(/PING_ON.*"kicks"/);
  });
```

- [ ] **Step 3: Add the event-key tests**

In `tests/events.test.ts`, add:

```ts
test('a kill-rate event is keyed by server, player and time', () => {
  expect(
    eventKey({
      kind: 'killRate',
      serverId: 's1',
      at: '2026-09-24T12:00:00.000Z',
      steamId: '765',
      name: 'Alpha',
      sweat: { perHour: 17, kills: 170, minutes: 600, range: '30d' },
      surge: null
    })
  ).toBe('killRate:s1:765:2026-09-24T12:00:00.000Z');
});
```

In `tests/runner.test.ts`:
- **Fixture:** change the `deps()` fixture's `escalateConfig` to `{ kdCooldownDays: 7, pingOn: new Set(PING_KINDS) }`.
- **Import:** add `retryKey` to the `../src/runner.js` import.
- **New test:**

```ts
test('retryKey drops the cycle time from a kill-rate event', () => {
  expect(
    retryKey({
      kind: 'killRate',
      serverId: 's1',
      at: '2026-09-24T12:00:00.000Z',
      steamId: '765',
      name: 'Alpha',
      sweat: null,
      surge: null
    })
  ).toBe('killRate:s1:765');
});
```

- [ ] **Step 4: Add the kill-rate embed tests**

In `tests/discord.test.ts`, add (the file already defines `links`, with `serverLabels: { s1: 'NA#3' }`, and `ROLE`):

```ts
describe('kill-rate embed', () => {
  const base = {
    kind: 'killRate' as const,
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    steamId: '765',
    name: 'Alpha'
  };
  const sweat = { perHour: 17.04, kills: 170, minutes: 600, range: '30d' };
  const surge = { perHour: 21, minutes: 300, usualPerHour: 12, usualMinutes: 6000, ratio: 1.75, range: '7d' };

  test('a sweat alone is titled Sweat and shows its rate and playtime', () => {
    const m = buildMessage({ event: { ...base, sweat, surge: null }, ping: true }, links, ROLE);
    const e = m.embeds[0]!;
    expect(e.title).toBe('NA#3 · Sweat — Alpha');
    expect(e.fields).toContainEqual({ name: 'Kills/hour (30d)', value: '17.0', inline: true });
    expect(e.fields).toContainEqual({ name: 'Playtime (30d)', value: '10.0 h', inline: true });
    expect(e.url).toBe('https://panel.example.com/server/s1/players/765');
  });

  test('both parts are titled Sweat + surge and show the ratio', () => {
    const m = buildMessage({ event: { ...base, sweat, surge }, ping: true }, links, ROLE);
    const e = m.embeds[0]!;
    expect(e.title).toBe('NA#3 · Sweat + surge — Alpha');
    expect(e.fields).toContainEqual({ name: 'Vs usual', value: '1.8×', inline: true });
    expect(e.fields).toContainEqual({ name: 'Usual kills/hour', value: '12.0 over 100.0 h', inline: true });
  });

  test('an infinite ratio reads as new', () => {
    const m = buildMessage(
      { event: { ...base, sweat: null, surge: { ...surge, usualPerHour: 0, ratio: Infinity } }, ping: true },
      links,
      ROLE
    );
    expect(m.embeds[0]!.title).toBe('NA#3 · Surge — Alpha');
    expect(m.embeds[0]!.fields).toContainEqual({ name: 'Vs usual', value: 'new', inline: true });
  });
});
```

- [ ] **Step 5: Run the tests and watch them fail**

Run: `npx vitest run tests/escalate.test.ts tests/config.test.ts tests/events.test.ts tests/runner.test.ts tests/discord.test.ts`
Expected: FAIL. `killRate` is unknown, team kills still ping, and `PING_ON` still accepts the old kinds.

- [ ] **Step 6: Add the event type**

In `src/events.ts`, add `| KillRateEvent` to the `ModEvent` union, and add:

```ts
/** Sustained high kill rate over SWEAT_RANGE (tiered-alerts spec §3). */
export interface SweatPart {
  perHour: number;
  kills: number;
  minutes: number;
  range: string;
}

/** Recent rate well above the player's own usual on this server (tiered-alerts spec §4). */
export interface SurgePart {
  /** over `range` */
  perHour: number;
  /** played over `range` */
  minutes: number;
  /** all-time on this server */
  usualPerHour: number;
  usualMinutes: number;
  /** perHour / usualPerHour; Infinity when usualPerHour is 0 */
  ratio: number;
  range: string;
}

/** Tier 3: one per player, carrying a sweat part, a surge part, or both (spec §5). */
export interface KillRateEvent {
  kind: 'killRate';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
  sweat: SweatPart | null;
  surge: SurgePart | null;
}
```

In `eventKey`'s switch, add:

```ts
    case 'killRate':
      return `killRate:${e.serverId}:${e.steamId}:${e.at}`;
```

In `src/runner.ts`'s `retryKey` switch, add:

```ts
    case 'killRate':
      return `killRate:${e.serverId}:${e.steamId}`;
```

- [ ] **Step 7: Rewrite escalation**

Replace `src/escalate.ts` with:

```ts
import type { Decision, ModEvent } from './events.js';
import { serverState, type State } from './state.js';

/**
 * The alert kinds that can mention the mod role: tier 3 only (tiered-alerts spec §2, §6).
 * Everything else posts without a ping.
 */
export const PING_KINDS = ['sweat', 'surge'] as const;
export type PingKind = (typeof PING_KINDS)[number];

export interface EscalateConfig {
  /** governs the K/D, sweat and surge cooldowns alike */
  kdCooldownDays: number;
  /** PING_ON: tier-3 kinds left out still post, just without the mention. */
  pingOn: ReadonlySet<PingKind>;
}

/**
 * Decides which events post and which ping, stamps team kills with their running count,
 * and applies the K/D and kill-rate cooldowns. Mutates `state` but performs no I/O.
 *
 * Events must arrive in chronological order — see base spec §8.1: the kills API returns
 * newest first, so the source reverses each page before calling this.
 */
export function escalate(
  events: ModEvent[],
  state: State,
  cfg: EscalateConfig,
  now: number
): Decision[] {
  const out: Decision[] = [];
  const cooldownMs = cfg.kdCooldownDays * 86_400_000;
  const cooling = (at: number | undefined): boolean => at !== undefined && now - at < cooldownMs;

  for (const event of events) {
    switch (event.kind) {
      case 'teamKill': {
        const s = serverState(state, event.serverId);
        // The match clock resets on a map change; matchId is per boot, not per match.
        if (event.eventTime < s.lastEventTime) s.teamKills = {};
        s.lastEventTime = event.eventTime;

        const count = (s.teamKills[event.killer.steamId] ?? 0) + 1;
        s.teamKills[event.killer.steamId] = count;
        out.push({ event: { ...event, count }, ping: false });
        break;
      }

      case 'highKd': {
        if (cooling(state.kdAlerted[event.steamId])) break;
        state.kdAlerted[event.steamId] = now;
        out.push({ event, ping: false });
        break;
      }

      case 'killRate': {
        const sweatKey = `sweat:${event.steamId}`;
        const surgeKey = `surge:${event.steamId}`;
        const sweat = event.sweat && !cooling(state.rateAlerted[sweatKey]) ? event.sweat : null;
        const surge = event.surge && !cooling(state.rateAlerted[surgeKey]) ? event.surge : null;
        if (!sweat && !surge) break; // both parts still cooling
        if (sweat) state.rateAlerted[sweatKey] = now;
        if (surge) state.rateAlerted[surgeKey] = now;
        out.push({
          event: { ...event, sweat, surge },
          ping: (!!sweat && cfg.pingOn.has('sweat')) || (!!surge && cfg.pingOn.has('surge'))
        });
        break;
      }

      case 'watchedJoin':
      case 'adminAction':
      case 'feedQuiet':
        out.push({ event, ping: false });
        break;
    }
  }

  return out;
}
```

- [ ] **Step 8: Update the `PING_ON` parsing and remove `TEAM_KILL_PING_AT`**

In `src/config.ts`, replace `parsePingOn` with:

```ts
/** Kinds that pinged before tiering; named in the error so an old .env explains itself. */
const RETIRED_PING_KINDS = ['teamKill', 'watchedJoin', 'highKd'];

/** Unset or blank: every tier-3 kind pings. `none`: nothing does. Otherwise a comma list. */
function parsePingOn(raw: string): ReadonlySet<PingKind> {
  const value = raw.trim();
  if (value === '') return new Set(PING_KINDS);
  if (value.toLowerCase() === 'none') return new Set();
  const kinds = new Set<PingKind>();
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (RETIRED_PING_KINDS.includes(entry)) {
      throw new Error(
        `PING_ON entry "${entry}" no longer pings: only tier-3 alerts (sweat, surge) mention the mod role — use sweat, surge or none`
      );
    }
    if (!(PING_KINDS as readonly string[]).includes(entry)) {
      throw new Error(
        `PING_ON entry "${entry}" is not one of ${PING_KINDS.join(', ')} (or use PING_ON=none)`
      );
    }
    kinds.add(entry as PingKind);
  }
  return kinds;
}
```

Delete `teamKillPingAt: number;` from `Config` and `teamKillPingAt: num('TEAM_KILL_PING_AT', 3),` from `loadConfig`.

In `src/index.ts`, change the escalate config to:

```ts
      escalateConfig: {
        kdCooldownDays: config.kdCooldownDays,
        pingOn: config.pingOn
      },
```

- [ ] **Step 9: Add the kill-rate embed**

In `src/discord.ts`:
- **Colour:** add `killRate: 0xe74c3c,` to `COLOR` (Task 3 reorganises the colours into tiers).
- **Helper:** add below `weapon`:

```ts
/** 600 -> `10.0 h` */
const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)} h`;
```

In `embedFor`'s switch, add:

```ts
    case 'killRate': {
      const what = e.sweat && e.surge ? 'Sweat + surge' : e.sweat ? 'Sweat' : 'Surge';
      const fields: EmbedField[] = [];
      if (e.sweat) {
        fields.push(field(`Kills/hour (${e.sweat.range})`, e.sweat.perHour.toFixed(1)));
        fields.push(field(`Playtime (${e.sweat.range})`, hours(e.sweat.minutes)));
      }
      if (e.surge) {
        fields.push(field(`Kills/hour (${e.surge.range})`, e.surge.perHour.toFixed(1)));
        fields.push(
          field('Usual kills/hour', `${e.surge.usualPerHour.toFixed(1)} over ${hours(e.surge.usualMinutes)}`)
        );
        fields.push(
          field('Vs usual', Number.isFinite(e.surge.ratio) ? `${e.surge.ratio.toFixed(1)}×` : 'new')
        );
      }
      return {
        title: `${what} — ${e.name}`,
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.killRate,
        timestamp: e.at,
        fields
      };
    }
```

- [ ] **Step 10: Run the full suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, typecheck clean. If an existing test elsewhere asserted that a team kill, watched join or K/D decision pings, it now contradicts spec §2. Change its expectation to `false`, and list each such change in your report.

- [ ] **Step 11: Commit**

```bash
git add src tests
git commit -F - <<'MSG'
feat: kill-rate event; only tier-3 alerts ping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 3: Tier colours and footers

**Files:**
- Modify: `src/discord.ts`
- Test: `tests/discord.test.ts`

**Interfaces:**
- Consumes: `KillRateEvent` (Task 2).
- Produces: `Embed.footer?: { text: string }`. Tiered embeds carry the footers below.

- [ ] **Step 1: Write the failing tests**

Add to `tests/discord.test.ts`:

```ts
describe('tiers', () => {
  const at = '2026-09-24T12:00:00.000Z';
  const msg = (event: import('../src/events.js').ModEvent) =>
    buildMessage({ event, ping: false }, links, ROLE).embeds[0]!;

  test('a watched join is tier 1, blue', () => {
    const e = msg({ kind: 'watchedJoin', serverId: 's1', at, steamId: '9', name: 'W' });
    expect(e.color).toBe(0x3498db);
    expect(e.footer).toEqual({ text: 'Tier 1 · watchlist' });
  });

  test('a K/D flag is tier 2, orange', () => {
    const e = msg({
      kind: 'highKd', serverId: 's1', at, steamId: '9', name: 'K',
      kd: 5, kills: 50, deaths: 10, matches: 9, minutes: 400
    });
    expect(e.color).toBe(0xe67e22);
    expect(e.footer).toEqual({ text: 'Tier 2 · high K/D' });
  });

  test('kill-rate alerts are tier 3, red, and name their parts', () => {
    const sweat = { perHour: 17, kills: 170, minutes: 600, range: '30d' };
    const surge = { perHour: 21, minutes: 300, usualPerHour: 12, usualMinutes: 6000, ratio: 1.75, range: '7d' };
    const base = { kind: 'killRate' as const, serverId: 's1', at, steamId: '9', name: 'R' };
    expect(msg({ ...base, sweat, surge: null }).footer).toEqual({ text: 'Tier 3 · sweat' });
    expect(msg({ ...base, sweat: null, surge }).footer).toEqual({ text: 'Tier 3 · surge' });
    const both = msg({ ...base, sweat, surge });
    expect(both.footer).toEqual({ text: 'Tier 3 · sweat + surge' });
    expect(both.color).toBe(0xe74c3c);
  });

  test('untiered alerts have no footer, and a team kill is purple', () => {
    const tkEmbed = msg({
      kind: 'teamKill', serverId: 's1', at, eventId: 'e', eventTime: 1,
      killer: { steamId: '1', name: 'A', faction: 'V' },
      victim: { steamId: '2', name: 'B', faction: 'V' },
      cause: null, distanceM: null, count: 1
    });
    expect(tkEmbed.color).toBe(0x9b59b6);
    expect(tkEmbed.footer).toBeUndefined();
    expect(msg({ kind: 'feedQuiet', serverId: 's1', at, lastFeedAt: null }).footer).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/discord.test.ts`
Expected: FAIL. The colours are the old ones, and there are no footers.

- [ ] **Step 3: Implement**

In `src/discord.ts`, add `footer?: { text: string };` to `interface Embed`, and replace `COLOR` with:

```ts
/** Tier colours (tiered-alerts spec §2); untiered alerts keep their own. */
const COLOR = {
  tier1: 0x3498db,
  tier2: 0xe67e22,
  tier3: 0xe74c3c,
  teamKill: 0x9b59b6,
  adminAction: 0x6c757d,
  feedQuiet: 0x8a6d3b
} as const;
```

Then in `embedFor`:
- **watchedJoin:** `color: COLOR.tier1,` and add `footer: { text: 'Tier 1 · watchlist' },`
- **highKd:** `color: COLOR.tier2,` and add `footer: { text: 'Tier 2 · high K/D' },`
- **killRate:** `color: COLOR.tier3,` and add `footer: { text: \`Tier 3 · ${what.toLowerCase()}\` },`. `what` is `Sweat`, `Surge` or `Sweat + surge`, which lowercase to the footers in the tests.
- **teamKill, adminAction and feedQuiet:** these keep `COLOR.teamKill`, `COLOR.adminAction` and `COLOR.feedQuiet`, with no footer.

- [ ] **Step 4: Run the full suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts tests/discord.test.ts
git commit -F - <<'MSG'
feat: alerts are coloured by tier and name their tier

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 4: The kill-rate source

**Files:**
- Create: `src/sources/killrate.ts`
- Modify: `src/warcon-types.ts`
- Test: `tests/sources-killrate.test.ts`

**Interfaces:**
- Consumes:
  - `KillRateEvent`, `SweatPart` and `SurgePart` (Task 2)
  - `State.baselines` and `BASELINE_TTL_MS` (Task 1)
  - `WarconClient.getJson<T>(path)`
  - `BoardBody` / `BoardRow`
- Produces:
  - `warcon-types.ts`:
    - `DossierServerTotals { serverId: string; minutes: number; kills: number; deaths: number }`
    - `DossierBody { ok: boolean; dossier: { perServer: DossierServerTotals[] } }`
  - `sources/killrate.ts`:
    - `KillRateConfig { sweatPerHour; sweatRange; surgeRange; surgePerHour; surgeRatio; surgeHistoryMinutes; minMinutes }` (all numbers except the two ranges)
    - `pollKillRate(client, serverId, state: State, cfg: KillRateConfig, now: number): Promise<ModEvent[]>`
    - `PAGE_SIZE = 50`, `MAX_PAGES = 4`, `LOOKUPS_PER_RUN = 10`
    - `perHour(kills, minutes)`

- [ ] **Step 1: Write the failing tests**

Create `tests/sources-killrate.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  LOOKUPS_PER_RUN,
  PAGE_SIZE,
  pollKillRate,
  type KillRateConfig
} from '../src/sources/killrate.js';
import { emptyState } from '../src/state.js';
import type { KillRateEvent } from '../src/events.js';
import type { BoardRow, DossierBody } from '../src/warcon-types.js';
import type { WarconClient } from '../src/warcon.js';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const DAY = 86_400_000;
const cfg: KillRateConfig = {
  sweatPerHour: 15,
  sweatRange: '30d',
  surgeRange: '7d',
  surgePerHour: 10,
  surgeRatio: 1.5,
  surgeHistoryMinutes: 600,
  minMinutes: 180
};

/** `rate` kills per hour over `minutes`. */
const row = (steamId: string, rate: number, minutes = 600): BoardRow => ({
  steamId,
  name: `P${steamId}`,
  minutes,
  kills: (rate * minutes) / 60,
  deaths: 10,
  matches: 9
});

/** A fake panel: leaderboard pages per range, dossiers per player, and a log of paths. */
function panel(opts: {
  boards: Record<string, BoardRow[]>; // range -> all rows, highest rate first
  dossiers?: Record<string, DossierBody['dossier']['perServer']>;
  failDossier?: boolean;
}) {
  const paths: string[] = [];
  const client = {
    getJson: async (path: string) => {
      paths.push(path);
      const url = new URL(path, 'http://x');
      if (url.pathname.endsWith('/leaderboard')) {
        const rows = opts.boards[url.searchParams.get('range')!] ?? [];
        const page = Number(url.searchParams.get('page'));
        return { ok: true, rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
      }
      const steamId = url.pathname.split('/').pop()!;
      if (opts.failDossier) throw new Error('dossier down');
      return { ok: true, dossier: { perServer: opts.dossiers?.[steamId] ?? [] } };
    }
  } as unknown as WarconClient;
  return { client, paths };
}

const usual = (rate: number, minutes = 6000) => [
  { serverId: 's1', minutes, kills: (rate * minutes) / 60, deaths: 100 }
];

describe('sweats', () => {
  test('flags 15/hour and above over the sweat range, inclusive', async () => {
    const { client, paths } = panel({ boards: { '30d': [row('a', 20), row('b', 15), row('c', 14.9)] } });
    const events = (await pollKillRate(client, 's1', emptyState(), cfg, NOW)) as KillRateEvent[];
    expect(events.map((e) => e.steamId)).toEqual(['a', 'b']);
    expect(events[1]!.sweat).toEqual({ perHour: 15, kills: 150, minutes: 600, range: '30d' });
    expect(paths[0]).toBe(
      '/api/servers/s1/leaderboard?scope=server&range=30d&sort=perHour&dir=desc&minMinutes=180&page=1'
    );
  });

  test('pages while a full page ends above the threshold, and stops at four', async () => {
    const hot = Array.from({ length: PAGE_SIZE * 5 }, (_, i) => row(`h${i}`, 30));
    const { client, paths } = panel({ boards: { '30d': hot } });
    await pollKillRate(client, 's1', emptyState(), cfg, NOW);
    expect(paths.filter((p) => p.includes('range=30d'))).toHaveLength(4);
  });

  test('stops paging on a page whose last row is below the threshold', async () => {
    const rows = [...Array.from({ length: PAGE_SIZE - 1 }, (_, i) => row(`h${i}`, 30)), row('cold', 5)];
    const { client, paths } = panel({ boards: { '30d': rows } });
    await pollKillRate(client, 's1', emptyState(), cfg, NOW);
    expect(paths.filter((p) => p.includes('range=30d'))).toHaveLength(1);
  });
});

describe('surges', () => {
  test('flags a recent rate at least 1.5x the usual, inclusive', async () => {
    const { client } = panel({ boards: { '7d': [row('a', 15, 300)] }, dossiers: { a: usual(10) } });
    const [e] = (await pollKillRate(client, 's1', emptyState(), cfg, NOW)) as KillRateEvent[];
    expect(e!.surge).toEqual({
      perHour: 15, minutes: 300, usualPerHour: 10, usualMinutes: 6000, ratio: 1.5, range: '7d'
    });
    expect(e!.sweat).toBeNull();
  });

  test('is no surge below the ratio, below the floor, or without enough history', async () => {
    const { client } = panel({
      boards: { '7d': [row('ratio', 14, 300), row('short', 20, 300)] },
      dossiers: { ratio: usual(10), short: usual(5, 599) }
    });
    expect(await pollKillRate(client, 's1', emptyState(), cfg, NOW)).toEqual([]);
  });

  test('a player with no history on this server is no surge and no crash', async () => {
    const { client } = panel({
      boards: { '7d': [row('away', 20, 300)] },
      dossiers: { away: [{ serverId: 'other', minutes: 9000, kills: 900, deaths: 1 }] }
    });
    expect(await pollKillRate(client, 's1', emptyState(), cfg, NOW)).toEqual([]);
  });

  test('history but no recorded kills reads as an infinite ratio', async () => {
    const { client } = panel({
      boards: { '7d': [row('fresh', 20, 300)] },
      dossiers: { fresh: [{ serverId: 's1', minutes: 900, kills: 0, deaths: 3 }] }
    });
    const [e] = (await pollKillRate(client, 's1', emptyState(), cfg, NOW)) as KillRateEvent[];
    expect(e!.surge!.ratio).toBe(Infinity);
  });

  test('a cached usual rate skips the dossier; a day-old one is read again', async () => {
    const state = emptyState();
    state.baselines['s1:fresh'] = { perHour: 10, minutes: 6000, at: NOW - DAY + 1 };
    state.baselines['s1:stale'] = { perHour: 10, minutes: 6000, at: NOW - DAY };
    const { client, paths } = panel({
      boards: { '7d': [row('fresh', 20, 300), row('stale', 20, 300)] },
      dossiers: { stale: usual(10) }
    });
    await pollKillRate(client, 's1', state, cfg, NOW);
    expect(paths.filter((p) => p.includes('/players/'))).toEqual(['/api/servers/s1/players/stale']);
    expect(state.baselines['s1:stale']!.at).toBe(NOW);
  });

  test('looks up at most ten uncached players, highest recent rate first', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => row(`p${i}`, 30 - i, 300));
    const dossiers = Object.fromEntries(rows.map((r) => [r.steamId, usual(10)]));
    const state = emptyState();
    const { client, paths } = panel({ boards: { '7d': rows }, dossiers });
    await pollKillRate(client, 's1', state, cfg, NOW);
    const looked = paths.filter((p) => p.includes('/players/')).map((p) => p.split('/').pop());
    expect(looked).toEqual(rows.slice(0, LOOKUPS_PER_RUN).map((r) => r.steamId));

    // The next run has those ten cached, so it reaches the other five.
    const next = panel({ boards: { '7d': rows }, dossiers });
    await pollKillRate(next.client, 's1', state, cfg, NOW + 60_000);
    const later = next.paths.filter((p) => p.includes('/players/')).map((p) => p.split('/').pop());
    expect(later).toEqual(rows.slice(LOOKUPS_PER_RUN).map((r) => r.steamId));
  });

  test('a dossier failure fails the whole source', async () => {
    const { client } = panel({ boards: { '30d': [row('s', 20)], '7d': [row('a', 20, 300)] }, failDossier: true });
    await expect(pollKillRate(client, 's1', emptyState(), cfg, NOW)).rejects.toThrow('dossier down');
  });
});

describe('one alert per player', () => {
  test('a sweat who is also surging is one event carrying both parts', async () => {
    const { client } = panel({
      boards: { '30d': [row('a', 18)], '7d': [row('a', 25, 300)] },
      dossiers: { a: usual(12) }
    });
    const events = (await pollKillRate(client, 's1', emptyState(), cfg, NOW)) as KillRateEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.sweat).not.toBeNull();
    expect(events[0]!.surge).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/sources-killrate.test.ts`
Expected: FAIL, because `../src/sources/killrate.js` can't be resolved.

- [ ] **Step 3: Add the dossier type**

In `src/warcon-types.ts`, add:

```ts
/** One server's all-time totals from a player's dossier (tiered-alerts spec §4). */
export interface DossierServerTotals {
  serverId: string;
  minutes: number;
  kills: number;
  deaths: number;
}

/** `GET /api/servers/{id}/players/{steamId}` — only the fields the bot reads. */
export interface DossierBody {
  ok: boolean;
  dossier: { perServer: DossierServerTotals[] };
}
```

- [ ] **Step 4: Implement the source**

Create `src/sources/killrate.ts`:

```ts
import type { KillRateEvent, ModEvent } from '../events.js';
import { BASELINE_TTL_MS, type State } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { BoardBody, BoardRow, DossierBody } from '../warcon-types.js';

export interface KillRateConfig {
  sweatPerHour: number;
  sweatRange: string;
  surgeRange: string;
  surgePerHour: number;
  surgeRatio: number;
  surgeHistoryMinutes: number;
  /** RATE_MIN_MINUTES: playtime needed inside each range */
  minMinutes: number;
}

/** Rows per leaderboard page; Warcon serves fifty. */
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4;
/** Dossier reads per server per run — keeps the bot inside Warcon's 120/min (spec §4). */
export const LOOKUPS_PER_RUN = 10;

/** Kills per hour, computed here so thresholds never depend on the panel's rounding. */
export const perHour = (kills: number, minutes: number): number =>
  minutes > 0 ? kills / (minutes / 60) : 0;

const rateOf = (r: BoardRow): number => perHour(r.kills, r.minutes);

/** Leaderboard rows at or above `floor` kills per hour, highest first. */
async function hotRows(
  client: WarconClient,
  serverId: string,
  range: string,
  minMinutes: number,
  floor: number
): Promise<BoardRow[]> {
  const out: BoardRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      scope: 'server',
      range,
      sort: 'perHour',
      dir: 'desc',
      minMinutes: String(minMinutes),
      page: String(page)
    });
    const { rows } = await client.getJson<BoardBody>(
      `/api/servers/${encodeURIComponent(serverId)}/leaderboard?${query}`
    );
    out.push(...rows.filter((r) => rateOf(r) >= floor));
    const last = rows[rows.length - 1];
    if (rows.length < PAGE_SIZE || !last || rateOf(last) < floor) break;
  }
  return out.sort((a, b) => rateOf(b) - rateOf(a));
}

/**
 * Tier 3: sweats (a sustained high rate) and surges (a recent rate well above the
 * player's own usual on this server), merged into one event per player
 * (tiered-alerts spec §3–§5).
 *
 * Usual rates come from the player's dossier and are cached in `state.baselines` for a
 * day; a run reads at most LOOKUPS_PER_RUN uncached ones, highest recent rate first, so
 * a busy server's later candidates are reached on the following runs. Any failed read
 * fails the whole source: the runner logs it and the next hourly run retries.
 */
export async function pollKillRate(
  client: WarconClient,
  serverId: string,
  state: State,
  cfg: KillRateConfig,
  now: number
): Promise<ModEvent[]> {
  const at = new Date(now).toISOString();
  const sweats = await hotRows(client, serverId, cfg.sweatRange, cfg.minMinutes, cfg.sweatPerHour);
  const recent = await hotRows(client, serverId, cfg.surgeRange, cfg.minMinutes, cfg.surgePerHour);

  const byPlayer = new Map<string, KillRateEvent>();
  const eventFor = (r: BoardRow): KillRateEvent => {
    let e = byPlayer.get(r.steamId);
    if (!e) {
      e = { kind: 'killRate', serverId, at, steamId: r.steamId, name: r.name, sweat: null, surge: null };
      byPlayer.set(r.steamId, e);
    }
    return e;
  };

  for (const r of sweats) {
    eventFor(r).sweat = { perHour: rateOf(r), kills: r.kills, minutes: r.minutes, range: cfg.sweatRange };
  }

  let lookups = 0;
  for (const r of recent) {
    const key = `${serverId}:${r.steamId}`;
    let usual = state.baselines[key];
    if (!usual || now - usual.at >= BASELINE_TTL_MS) {
      if (lookups >= LOOKUPS_PER_RUN) continue; // reached on a later run
      lookups++;
      const { dossier } = await client.getJson<DossierBody>(
        `/api/servers/${encodeURIComponent(serverId)}/players/${encodeURIComponent(r.steamId)}`
      );
      const here = dossier.perServer.find((p) => p.serverId === serverId);
      usual = {
        perHour: here ? perHour(here.kills, here.minutes) : 0,
        minutes: here?.minutes ?? 0,
        at: now
      };
      state.baselines[key] = usual;
    }

    if (usual.minutes < cfg.surgeHistoryMinutes) continue; // too little history to compare
    const recentRate = rateOf(r);
    const ratio = usual.perHour > 0 ? recentRate / usual.perHour : Infinity;
    if (ratio < cfg.surgeRatio) continue;
    eventFor(r).surge = {
      perHour: recentRate,
      minutes: r.minutes,
      usualPerHour: usual.perHour,
      usualMinutes: usual.minutes,
      ratio,
      range: cfg.surgeRange
    };
  }

  return [...byPlayer.values()];
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/sources-killrate.test.ts && npx vitest run && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/sources/killrate.ts src/warcon-types.ts tests/sources-killrate.test.ts
git commit -F - <<'MSG'
feat: sweat and surge source over the kills-per-hour board

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 5: Wire the source into the runner and the process

**Files:**
- Modify: `src/runner.ts`, `src/index.ts`, `scripts/mock-warcon.mjs`
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes:
  - `pollKillRate` and `KillRateConfig` (Task 4)
  - `State.rateAlerted`, `State.baselines` and `BASELINE_TTL_MS` (Task 1)
  - `retryKey` with its `killRate` case (Task 2)
- Produces: `CycleSources.killRate(serverId: string): Promise<ModEvent[]>`.

- [ ] **Step 1: Write the failing runner tests**

In `tests/runner.test.ts`, add `killRate: async () => []` to the `deps()` fixture's `sources`, then add:

```ts
describe('kill-rate alerts in the cycle', () => {
  const rateEvent = (steamId: string): ModEvent => ({
    kind: 'killRate',
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    steamId,
    name: steamId,
    sweat: { perHour: 18, kills: 180, minutes: 600, range: '30d' },
    surge: null
  });

  test('runs only on the K/D schedule', async () => {
    const killRate = vi.fn(async () => []);
    const base = deps({ state: warmState() });
    await runCycle({ ...base, runKd: false, sources: { ...base.sources, killRate } });
    expect(killRate).not.toHaveBeenCalled();
    await runCycle({ ...base, runKd: true, sources: { ...base.sources, killRate } });
    expect(killRate).toHaveBeenCalledWith('s1');
  });

  test('a failing kill-rate read does not keep a cold server cold', async () => {
    const state = emptyState();
    const base = deps({ state, runKd: true });
    await runCycle({
      ...base,
      sources: { ...base.sources, killRate: async () => { throw new Error('board down'); } }
    });
    expect(state.servers['s1']!.warm).toBe(true);
  });

  test('a failed post rolls back kill-rate cooldowns and baselines but keeps delivered ones', async () => {
    const state = warmState();
    state.baselines['s1:old'] = { perHour: 9, minutes: 900, at: NOW };
    let calls = 0;
    const base = deps({ state, runKd: true });
    await runCycle({
      ...base,
      sources: {
        ...base.sources,
        killRate: async () => {
          state.baselines['s1:new'] = { perHour: 11, minutes: 700, at: NOW }; // looked up this run
          return [rateEvent('765'), rateEvent('766')];
        }
      },
      poster: {
        post: async () => {
          calls++;
          if (calls === 2) throw new Error('discord down');
        }
      }
    });
    expect(state.rateAlerted['sweat:765']).toBe(NOW); // delivered: cooldown stands
    expect(state.rateAlerted['sweat:766']).toBeUndefined(); // not delivered: retried
    expect(state.baselines).toEqual({ 's1:old': { perHour: 9, minutes: 900, at: NOW } });
  });

  test('expired kill-rate cooldowns and day-old baselines are pruned before saving', async () => {
    const day = 86_400_000;
    const state = warmState();
    state.rateAlerted = { 'sweat:old': NOW - 7 * day, 'surge:new': NOW - 6 * day };
    state.baselines = {
      's1:old': { perHour: 1, minutes: 1, at: NOW - day },
      's1:new': { perHour: 1, minutes: 1, at: NOW - day + 1 }
    };
    await runCycle(deps({ state }));
    expect(state.rateAlerted).toEqual({ 'surge:new': NOW - 6 * day });
    expect(Object.keys(state.baselines)).toEqual(['s1:new']);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/runner.test.ts`
Expected: FAIL. `killRate` is never called, and nothing is rolled back or pruned.

- [ ] **Step 3: Implement it in the runner**

In `src/runner.ts`:
- **Import:** change the state import to `import { BASELINE_TTL_MS, serverState, type ServerState, type State } from './state.js';`.
- **Interface:** add `killRate(serverId: string): Promise<ModEvent[]>;` to `CycleSources`.
- **Snapshots:** after `const kdSnapshot = { ...deps.state.kdAlerted };`, add:

```ts
    const rateSnapshot = { ...deps.state.rateAlerted };
    const baselineSnapshot = { ...deps.state.baselines };
```

- **Source run:** after the `kd` run line, add:

```ts
    if (deps.runKd) await run('killRate', () => deps.sources.killRate(serverId), false);
```

- **Rollback:** in the `if (failed)` block, after `deps.state.kdAlerted = kdSnapshot;`, add:

```ts
      deps.state.rateAlerted = rateSnapshot;
      deps.state.baselines = baselineSnapshot;
```

and extend the re-stamp loop so it also covers kill-rate alerts that went out:

```ts
      for (const d of decisions) {
        if (!delivered.has(retryKey(d.event))) continue;
        if (d.event.kind === 'highKd') deps.state.kdAlerted[d.event.steamId] = deps.now;
        if (d.event.kind === 'killRate') {
          if (d.event.sweat) deps.state.rateAlerted[`sweat:${d.event.steamId}`] = deps.now;
          if (d.event.surge) deps.state.rateAlerted[`surge:${d.event.steamId}`] = deps.now;
        }
      }
```

(This replaces the existing loop, which handles only `highKd`.)

- **Pruning:** after the existing `kdAlerted` pruning loop, add:

```ts
  for (const [key, at] of Object.entries(deps.state.rateAlerted)) {
    if (deps.now - at >= cooldownMs) delete deps.state.rateAlerted[key];
  }
  for (const [key, baseline] of Object.entries(deps.state.baselines)) {
    if (deps.now - baseline.at >= BASELINE_TTL_MS) delete deps.state.baselines[key];
  }
```

- [ ] **Step 4: Wire it into the process**

In `src/index.ts`:
- **Import:** add `import { pollKillRate } from './sources/killrate.js';`.
- **Source:** add to `sources`:

```ts
        killRate: (id) =>
          pollKillRate(
            client,
            id,
            state,
            {
              sweatPerHour: config.sweatPerHour,
              sweatRange: config.sweatRange,
              surgeRange: config.surgeRange,
              surgePerHour: config.surgePerHour,
              surgeRatio: config.surgeRatio,
              surgeHistoryMinutes: config.surgeHistoryMinutes,
              minMinutes: config.rateMinMinutes
            },
            now
          )
```

- [ ] **Step 5: Teach the mock panel the new reads**

In `scripts/mock-warcon.mjs`:
- **Leaderboard:** in the `/leaderboard` handler, add a sweat row to `rows`:
  `{ steamId: '76561190000000004', name: 'Delta', minutes: 600, kills: 180, deaths: 12, matches: 9 }`
  That's 18 kills an hour.
- **Dossier:** add this handler *after* the `/players/marks` handler and before the `/leaderboard` one:

```js
  const dossier = /\/players\/(\d+)$/.exec(p);
  if (dossier) {
    const serverId = p.split('/')[3];
    return json(res, {
      ok: true,
      // Delta's usual is 8/hour over 100 hours, so the mock's 18/hour is also a surge.
      dossier: {
        perServer: [{ serverId, minutes: 6000, kills: dossier[1].endsWith('4') ? 800 : 100, deaths: 50 }]
      }
    });
  }
```

Check that `p` holds the URL path in that file, as the existing handlers use it, and that `p.split('/')[3]` is the server id for `/api/servers/{id}/players/{steamId}`.

- [ ] **Step 6: Run everything**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS, typecheck clean, build succeeds.

Then smoke-test against the mock. In one terminal run `npm run mock`. In another run:

```sh
WARCON_BASE_URL=http://127.0.0.1:8787 PANEL_PUBLIC_URL=https://panel.example.com WARCON_TOKEN=x DISCORD_TOKEN=x DISCORD_CHANNEL_ID=1 DISCORD_MOD_ROLE_ID=2 SERVER_IDS=s1 node -e "
import('./dist/sources/killrate.js').then(async ({ pollKillRate }) => {
  const { WarconClient } = await import('./dist/warcon.js');
  const { emptyState } = await import('./dist/state.js');
  const c = new WarconClient({ baseUrl: 'http://127.0.0.1:8787', token: 'x', cfClientId: null, cfClientSecret: null, timeoutMs: 5000 });
  console.log(JSON.stringify(await pollKillRate(c, 's1', emptyState(), { sweatPerHour: 15, sweatRange: '30d', surgeRange: '7d', surgePerHour: 10, surgeRatio: 1.5, surgeHistoryMinutes: 600, minMinutes: 180 }, Date.now()), null, 2));
});"
```

Expected: one event for Delta (`76561190000000004`) with both `sweat` and `surge`. Put the output in your report, then stop the mock.

- [ ] **Step 7: Commit**

```bash
git add src/runner.ts src/index.ts scripts/mock-warcon.mjs tests/runner.test.ts
git commit -F - <<'MSG'
feat: sweat and surge alerts run hourly, with rollback and pruning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `.env.example`, `docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: README**

In `README.md`:
- **Alert table:** replace the "Event | Pings the mod role?" table and the `PING_ON` paragraph under it with:

```markdown
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
```

- **Configuration table:**
  - Delete the `TEAM_KILL_PING_AT` row.
  - Change the `PING_ON` row to: `Tier-3 alerts that mention the mod role: \`sweat\`, \`surge\`, or \`none\` (default: both)`.
  - Add these rows:

```markdown
| `SWEAT_PER_HOUR` | Kills an hour that marks a sweat (default `15`) |
| `SWEAT_RANGE` | Period a sweat's rate is measured over: `7d`, `30d`, `90d` or `all` (default `30d`) |
| `SURGE_RANGE` | Recent period compared with a player's usual rate (default `7d`) |
| `SURGE_PER_HOUR` | Minimum recent kills an hour for a surge (default `10`) |
| `SURGE_RATIO` | How many times their usual rate counts as a surge (default `1.5`) |
| `SURGE_HISTORY_MINUTES` | Playtime on a server before a player can surge there (default `600`) |
| `RATE_MIN_MINUTES` | Playtime needed inside each range for sweats and surges (default `180`) |
```

- **Cooldown:** where the README describes `KD_COOLDOWN_DAYS`, say that it now applies to K/D, sweat and surge, each tracked separately.

- [ ] **Step 2: `.env.example`**

Delete the `TEAM_KILL_PING_AT=3` line, and replace the `PING_ON` comment and line with:

```
# Only tier-3 alerts (sweat, surge) can mention the mod role. Unset or blank: both do.
# PING_ON=none posts everything without a ping.
PING_ON=sweat,surge

SWEAT_PER_HOUR=15
SWEAT_RANGE=30d
SURGE_RANGE=7d
SURGE_PER_HOUR=10
SURGE_RATIO=1.5
SURGE_HISTORY_MINUTES=600
RATE_MIN_MINUTES=180
```

- [ ] **Step 3: Point the base spec at the amendment**

In `docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md`:
- **Section 8:** directly under the `## 8. Rules` heading, add:
  > Amended 2026-09-26 by `2026-09-26-tiered-alerts-design.md`: alerts are tiered, only tier 3 (sweat, surge) pings, and team kills no longer ping. Where the two disagree, the amendment wins.
- **Section 10:** in the configuration block, delete the `TEAM_KILL_PING_AT` line, and change the `PING_ON` line to `PING_ON                    sweat,surge   (or none)`.

- [ ] **Step 4: Check nothing still names the removed setting**

Run: `grep -rn "TEAM_KILL_PING_AT\|teamKillPingAt" src tests README.md .env.example docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md`
Expected: no matches, except inside the new amendment spec itself if it's under `docs/`. It isn't in this command's paths.

Run: `npx vitest run && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md
git commit -F - <<'MSG'
docs: tiers, sweats, surges and the new PING_ON

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```
