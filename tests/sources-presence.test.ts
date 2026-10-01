import { describe, expect, test } from 'vitest';
import { LIVE_STALE_MS, MARKS_BATCH, pollPresence, type PresenceConfig } from '../src/sources/presence.js';
import { emptyServerState, type ServerState } from '../src/state.js';
import type { HotPlayerEvent, ModEvent, PlayerJoinedEvent } from '../src/events.js';
import type { MarksBody, SummaryBody } from '../src/warcon-types.js';
import type { WarconClient } from '../src/warcon.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const cfg: PresenceConfig = { livePerHour: 20, liveMinMinutes: 20, liveMinKills: 8 };

interface P {
  steamId: string;
  name?: string;
  kills?: number;
  deaths?: number;
}

const summaryOf = (players: P[], map?: string): SummaryBody => ({
  ok: true,
  live: {
    serverId: 's1',
    ok: true,
    status: { serverName: 'EU 1', ...(map ? { map } : {}) },
    players: players.map((p) => ({
      steamId: p.steamId,
      name: p.name ?? `P${p.steamId}`,
      faction: 'Valkyra',
      kills: p.kills ?? 0,
      deaths: p.deaths ?? 0,
      cash: 0,
      ping: 40
    }))
  }
});

/** A fake panel: one summary, marks answering `watched` for the listed ids; logs every path. */
function panel(summary: SummaryBody, watchedIn: string[] | Record<string, string> = [], failMarks = false) {
  // A list of watched ids, or a map of watched id -> watch reason.
  const reasons: Record<string, string> = Array.isArray(watchedIn)
    ? Object.fromEntries(watchedIn.map((id) => [id, '']))
    : watchedIn;
  const watched = Object.keys(reasons);
  const paths: string[] = [];
  const client = {
    getJson: async (path: string) => {
      paths.push(path);
      if (path.includes('/players/marks')) {
        if (failMarks) throw new Error('marks 503');
        const ids = new URL(path, 'http://x').searchParams.get('ids')!.split(',');
        return {
          ok: true,
          marks: [...ids, ...watched].map((steamId) => ({
            steamId,
            watched: watched.includes(steamId),
            reason: reasons[steamId] ?? '',
            firstVisit: false
          }))
        } satisfies MarksBody;
      }
      return summary;
    }
  } as unknown as WarconClient;
  return { client, paths };
}

/** A server that has completed a clean cycle, so the live check runs. */
const warm = (over: Partial<ServerState> = {}): ServerState => ({ ...emptyServerState(), warm: true, ...over });

const run = (s: ServerState, summary: SummaryBody, watched: string[] | Record<string, string> = []) =>
  pollPresence(panel(summary, watched).client, 's1', s, cfg, NOW);

/** NOW plus `min` minutes */
const at = (min: number): number => NOW + min * 60_000;
/** One cycle `min` minutes after NOW. */
const runAt = (s: ServerState, min: number, players: P[], map?: string) =>
  pollPresence(panel(summaryOf(players, map)).client, 's1', s, cfg, at(min));

/** Cycles every half minute from `from` to `to`, with kills from `killsAt(min)`, as the bot polls. */
async function poll(s: ServerState, from: number, to: number, players: (min: number) => P[]): Promise<HotPlayerEvent[]> {
  const out: HotPlayerEvent[] = [];
  for (let min = from; min <= to; min += 0.5) out.push(...hots(await runAt(s, min, players(min))));
  return out;
}

const hots = (events: ModEvent[]) =>
  events.filter((e): e is HotPlayerEvent => e.kind === 'hotPlayer');
const joins = (events: ModEvent[]) =>
  events.filter((e): e is PlayerJoinedEvent => e.kind === 'playerJoined');

describe('where counting starts', () => {
  test('at the first observation, from now and the kills they already have', async () => {
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a', kills: 12 }, { steamId: 'b' }]);
    expect(s.match).toEqual({
      lastSeenAt: NOW,
      map: null,
      baselines: { a: { at: NOW, kills: 12, last: 12 }, b: { at: NOW, kills: 0, last: 0 } },
      alerted: []
    });
  });

  test('a newcomer counts from zero, dated from the previous observation', async () => {
    // They joined some time after it; dating them from it can only make their time
    // longer and their rate lower.
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a' }]);
    await runAt(s, 0.5, [{ steamId: 'a' }, { steamId: 'b', kills: 1 }]);
    expect(s.match.baselines['b']).toEqual({ at: at(0), kills: 0, last: 1 });
    expect(s.match.lastSeenAt).toBe(at(0.5));
  });

  test('a reconnect that kept its kills keeps its baseline', async () => {
    // Re-dating b from the last observation with 15 kills counted would overstate them.
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a' }, { steamId: 'b', kills: 3 }]);
    await runAt(s, 10, [{ steamId: 'a' }, { steamId: 'b', kills: 15 }]);
    await runAt(s, 10.5, [{ steamId: 'a' }]); // b leaves
    await runAt(s, 11, [{ steamId: 'a' }, { steamId: 'b', kills: 15 }]); // and is back
    expect(s.match.baselines['b']).toEqual({ at: NOW, kills: 3, last: 15 });
  });

  test('a reconnect that lost its kills counts again from zero', async () => {
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a', kills: 1 }, { steamId: 'b', kills: 1 }, { steamId: 'c', kills: 9 }]);
    await runAt(s, 5, [{ steamId: 'a', kills: 2 }, { steamId: 'b', kills: 2 }, { steamId: 'c', kills: 0 }]);
    expect(s.match.baselines['c']).toEqual({ at: NOW, kills: 0, last: 0 });
    expect(s.match.baselines['a']).toEqual({ at: NOW, kills: 1, last: 2 }); // not a new match
  });

  test('a gap over LIVE_STALE_MS starts over from now', async () => {
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a', kills: 1 }]);
    const later = (LIVE_STALE_MS + 60_000) / 60_000;
    await runAt(s, later, [{ steamId: 'a', kills: 9 }]);
    expect(s.match.baselines['a']).toEqual({ at: at(later), kills: 9, last: 9 });
  });

  test('a cold server still records the match, so its first warm cycle is not a first observation', async () => {
    const s = emptyServerState();
    await runAt(s, 0, [{ steamId: 'a' }]);
    s.warm = true;
    await runAt(s, 0.5, [{ steamId: 'a' }, { steamId: 'b' }]);
    expect(s.match.baselines['b']).toEqual({ at: at(0), kills: 0, last: 0 });
  });
});

describe('a new match', () => {
  test('a changed map clears every baseline, so absent players are forgotten too', async () => {
    const s = warm();
    // Only one of three still here went down, which alone would not be a new match.
    const roster = (a: number) => [{ steamId: 'a', kills: a }, { steamId: 'b' }, { steamId: 'c' }];
    await runAt(s, 0, [...roster(3), { steamId: 'gone', kills: 5 }], 'Town');
    await runAt(s, 5, roster(20), 'Town');
    await runAt(s, 5.5, roster(0), 'Harbour');
    expect(s.match.map).toBe('Harbour');
    expect(Object.keys(s.match.baselines).sort()).toEqual(['a', 'b', 'c']);
    expect(s.match.baselines['b']).toEqual({ at: at(5), kills: 0, last: 0 });
  });

  test('without a map, most of the roster going down on the scoreboard is a new match', async () => {
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a', kills: 9 }, { steamId: 'b', kills: 7 }, { steamId: 'gone', kills: 5 }]);
    await runAt(s, 5, [{ steamId: 'a', kills: 0 }, { steamId: 'b', kills: 1 }]);
    expect(s.match.baselines).toEqual({
      a: { at: NOW, kills: 0, last: 0 },
      b: { at: NOW, kills: 0, last: 1 }
    });
  });
});

describe('hot right now', () => {
  test('hot once 20 minutes are measured, with the figures', async () => {
    const s = warm();
    // a starts with 4 kills and gains one every two minutes: 30 an hour.
    const events = await poll(s, 0, 20, (min) => [{ steamId: 'a', kills: 4 + Math.floor(min / 2), deaths: 2 }]);
    expect(events).toEqual([
      {
        kind: 'hotPlayer',
        serverId: 's1',
        at: new Date(at(20)).toISOString(),
        steamId: 'a',
        name: 'Pa',
        kills: 14,
        deaths: 2,
        measuredKills: 10,
        minutes: 20,
        perHour: 30
      }
    ]);
  });

  test('kills before counting started do not count', async () => {
    // 30 kills already on the board at the first observation, then a steady 15 an hour.
    const events = await poll(warm(), 0, 40, (min) => [{ steamId: 'a', kills: 30 + Math.floor(min / 4) }]);
    expect(events).toEqual([]);
  });

  test('hot at exactly the kills and per-hour thresholds', async () => {
    // 8 kills in 24 minutes: exactly 20 an hour.
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a' }]);
    for (let m = 5; m < 24; m += 5) await runAt(s, m, [{ steamId: 'a' }]);
    const events = hots(await runAt(s, 24, [{ steamId: 'a', kills: 8 }]));
    expect(events.map((e) => [e.measuredKills, e.minutes, e.perHour])).toEqual([[8, 24, 20]]);
  });

  test.each([
    ['the minutes threshold', 19.5, 10],
    ['the kills threshold (21 an hour)', 20, 7],
    ['the per-hour threshold (18 an hour)', 30, 9]
  ])('not hot below %s', async (_name, minutes, kills) => {
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a' }]);
    // A stale gap would reset; stay inside it with an observation every few minutes.
    for (let m = 5; m < minutes; m += 5) await runAt(s, m, [{ steamId: 'a' }]);
    expect(hots(await runAt(s, minutes, [{ steamId: 'a', kills }]))).toEqual([]);
  });

  test('a newcomer is timed from the observation before they appeared', async () => {
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a' }]);
    // b appears at 0.5 with 2 kills, dated from 0, and reaches 10 at 15 minutes
    // (40 an hour, but too soon); at 20 minutes 10 kills is 30 an hour.
    const events = await poll(s, 0.5, 20, (min) => [{ steamId: 'a' }, { steamId: 'b', kills: min < 15 ? 2 : 10 }]);
    expect(events.map((e) => [e.steamId, e.minutes, e.perHour])).toEqual([['b', 20, 30]]);
  });

  test('a player posts once per match', async () => {
    const s = warm();
    await runAt(s, 0, [{ steamId: 'a' }]);
    for (let m = 5; m < 20; m += 5) await runAt(s, m, [{ steamId: 'a' }]);
    expect(hots(await runAt(s, 20, [{ steamId: 'a', kills: 10 }]))).toHaveLength(1);
    expect(s.match.alerted).toEqual(['a']);
    expect(hots(await runAt(s, 25, [{ steamId: 'a', kills: 20 }]))).toEqual([]);
  });

  test('a new match clears alerted, so the same player can alert again', async () => {
    const s = warm();
    const rate = (start: number) => (min: number) => [{ steamId: 'a', kills: Math.max(0, Math.floor((min - start) / 2)) }];
    expect(await poll(s, 0, 20, rate(0))).toHaveLength(1);
    // The board resets at 25: a new match.
    await runAt(s, 25, [{ steamId: 'a', kills: 0 }]);
    expect(s.match.alerted).toEqual([]);
    expect(await poll(s, 25.5, 46, rate(25))).toHaveLength(1);
  });

  test('a summary with no live data changes nothing, so players are not re-reported as joining', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    await runAt(s, 0, [{ steamId: 'a' }]);
    const before = structuredClone(s.match);
    const events = await run(s, { ok: true, live: null }, ['a']);
    expect(events).toEqual([]);
    expect(s.presentSteamIds).toEqual(['a']);
    expect(s.match).toEqual(before);
    // The next good read still sees a, already present: not a join.
    expect(joins(await runAt(s, 0.5, [{ steamId: 'a' }]))).toEqual([]);
  });

  test('a summary whose live read failed changes nothing either', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    const failed: SummaryBody = { ok: true, live: { serverId: 's1', ok: false, status: null, players: [] } };
    expect(await run(s, failed, ['a'])).toEqual([]);
    expect(s.presentSteamIds).toEqual(['a']);
  });

  test('a cold server posts no hot player and does not mark one alerted', async () => {
    const s = emptyServerState();
    await runAt(s, 0, [{ steamId: 'a' }]);
    for (let m = 5; m < 20; m += 5) await runAt(s, m, [{ steamId: 'a' }]);
    expect(hots(await runAt(s, 20, [{ steamId: 'a', kills: 10 }]))).toEqual([]);
    expect(s.match.alerted).toEqual([]);
    // Once warm, the same player still hot is reported.
    s.warm = true;
    expect(hots(await runAt(s, 20.5, [{ steamId: 'a', kills: 11 }]))).toHaveLength(1);
  });

  test('a player the scoreboard gives no kill count for is skipped', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    const summary = summaryOf([{ steamId: 'a' }]);
    const player = summary.live!.players[0]! as unknown as Record<string, unknown>;
    delete player['kills'];
    delete player['deaths'];
    await pollPresence(panel(summary).client, 's1', s, cfg, at(0));
    expect(s.match.baselines).toEqual({});
    expect(hots(await pollPresence(panel(summary).client, 's1', s, cfg, at(30)))).toEqual([]);
  });
});

describe('join alerts', () => {
  test('tags come from marks and the known lists', async () => {
    const s = warm({ knownSweats: ['a', 'd'], knownHighKd: ['b', 'd'] });
    const events = await run(
      s,
      summaryOf([{ steamId: 'a' }, { steamId: 'b' }, { steamId: 'c' }, { steamId: 'd' }, { steamId: 'e' }]),
      ['c', 'd']
    );
    expect(joins(events).map((e) => [e.steamId, e.watched, e.sweat, e.highKd])).toEqual([
      ['a', false, true, false],
      ['b', false, false, true],
      ['c', true, false, false],
      ['d', true, true, true]
    ]);
    expect(joins(events)[0]).toMatchObject({ serverId: 's1', name: 'Pa', at: new Date(NOW).toISOString() });
  });

  test("a known player's join carries the numbers that put them on the list", async () => {
    const sweat = { perHour: 18, kills: 180, minutes: 600, range: '30d' };
    const highKd = { kd: 5.2, kills: 52, deaths: 10, matches: 9, range: '30d' };
    const s = warm({ knownSweats: ['a'], knownHighKd: ['a'], knownStats: { a: { sweat, highKd } } });
    const [e] = joins(await run(s, summaryOf([{ steamId: 'a' }])));
    expect(e).toMatchObject({ sweat: true, highKd: true, sweatStats: sweat, highKdStats: highKd });
  });

  test('a watched-only join carries no numbers', async () => {
    const [e] = joins(await run(warm(), summaryOf([{ steamId: 'c' }]), ['c']));
    expect(e!.sweatStats).toBeUndefined();
    expect(e!.highKdStats).toBeUndefined();
  });

  test("a watched player's join carries the watch reason", async () => {
    const [e] = joins(await run(warm(), summaryOf([{ steamId: 'c' }]), { c: 'aimbot suspicion' }));
    expect(e).toMatchObject({ watched: true, watchReason: 'aimbot suspicion' });
  });

  test('a watch with no reason on record carries none', async () => {
    const [e] = joins(await run(warm(), summaryOf([{ steamId: 'c' }]), ['c']));
    expect(e!.watchReason).toBeUndefined();
  });

  test('a joiner with no tag posts nothing', async () => {
    expect(await run(warm(), summaryOf([{ steamId: 'e' }]))).toEqual([]);
  });

  test('empty known lists leave only the watched tag', async () => {
    const events = await run(warm(), summaryOf([{ steamId: 'a' }, { steamId: 'c' }]), ['c']);
    expect(joins(events).map((e) => e.steamId)).toEqual(['c']);
  });

  test('a player already present is not a join, and a known list does not change that', async () => {
    const s = warm({ presentSteamIds: ['a'], knownSweats: ['a'] });
    expect(await run(s, summaryOf([{ steamId: 'a' }]), ['a'])).toEqual([]);
  });

  test('re-reports after the player left and came back', async () => {
    const s = warm({ presentSteamIds: ['c'] });
    await run(s, summaryOf([]));
    expect(joins(await run(s, summaryOf([{ steamId: 'c' }]), ['c']))).toHaveLength(1);
  });

  test('always records the current roster, tagged or not', async () => {
    const s = warm();
    await run(s, summaryOf([{ steamId: 'e' }]));
    expect(s.presentSteamIds).toEqual(['e']);
  });

  test('skips the marks call entirely when nobody arrived', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    const { client, paths } = panel(summaryOf([{ steamId: 'a' }]));
    await pollPresence(client, 's1', s, cfg, NOW);
    expect(paths).toEqual(['/api/servers/s1/summary']);
  });

  test('asks marks in batches', async () => {
    const players = Array.from({ length: MARKS_BATCH + 50 }, (_, i) => ({ steamId: `p${i}` }));
    const { client, paths } = panel(summaryOf(players), ['p0', `p${MARKS_BATCH + 49}`]);
    const events = await pollPresence(client, 's1', warm(), cfg, NOW);
    const marks = paths.filter((p) => p.includes('/players/marks'));
    expect(marks.map((p) => new URL(p, 'http://x').searchParams.get('ids')!.split(',').length)).toEqual([
      MARKS_BATCH,
      50
    ]);
    expect(joins(events).map((e) => e.steamId)).toEqual(['p0', `p${MARKS_BATCH + 49}`]);
  });

  test('a marks answer for a player not asked about in that batch is ignored', async () => {
    // The fake panel also answers for every watched id, asked or not.
    const events = await run(warm(), summaryOf([{ steamId: 'a' }]), ['zzz']);
    expect(events).toEqual([]);
  });

  test('a failed marks call leaves the roster and match uncommitted, so the next cycle still reports', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    await runAt(s, 0, [{ steamId: 'a' }]);
    for (let m = 5; m < 20; m += 5) await runAt(s, m, [{ steamId: 'a' }]);
    const match = structuredClone(s.match);
    const summary = summaryOf([{ steamId: 'a', kills: 20 }, { steamId: 'c' }]);

    await expect(pollPresence(panel(summary, ['c'], true).client, 's1', s, cfg, at(20))).rejects.toThrow(
      'marks 503'
    );
    expect(s.presentSteamIds).toEqual(['a']);
    expect(s.match).toEqual(match); // the hot player is not marked alerted with no event out

    const events = await pollPresence(panel(summary, ['c']).client, 's1', s, cfg, at(20));
    expect(joins(events).map((e) => e.steamId)).toEqual(['c']);
    expect(hots(events).map((e) => e.steamId)).toEqual(['a']);
    expect(s.presentSteamIds).toEqual(['a', 'c']);
  });
});
