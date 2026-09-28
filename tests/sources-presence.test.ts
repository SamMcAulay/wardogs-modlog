import { describe, expect, test } from 'vitest';
import { MARKS_BATCH, pollPresence, type PresenceConfig } from '../src/sources/presence.js';
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

const summaryOf = (players: P[], matchSeconds: number | null = null): SummaryBody => ({
  ok: true,
  live: {
    serverId: 's1',
    ok: true,
    status: { serverName: 'EU 1', matchSeconds },
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
function panel(summary: SummaryBody, watched: string[] = [], failMarks = false) {
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
            reason: '',
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

const run = (s: ServerState, summary: SummaryBody, watched: string[] = []) =>
  pollPresence(panel(summary, watched).client, 's1', s, cfg, NOW);

const hots = (events: ModEvent[]) =>
  events.filter((e): e is HotPlayerEvent => e.kind === 'hotPlayer');
const joins = (events: ModEvent[]) =>
  events.filter((e): e is PlayerJoinedEvent => e.kind === 'playerJoined');

describe('when a player was first seen in the match', () => {
  test('players present at the first observation of a match get firstSeen 0', async () => {
    const s = warm();
    await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b' }], 900));
    expect(s.match).toEqual({ lastMatchSeconds: 900, firstSeen: { a: 0, b: 0 }, alerted: [] });
  });

  test('a player who appears later in the same match gets the last observed clock', async () => {
    // They joined some time after the previous observation; dating them from it can only
    // make their time longer and their rate lower.
    const s = warm();
    await run(s, summaryOf([{ steamId: 'a' }], 900));
    await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b' }], 930));
    expect(s.match.firstSeen).toEqual({ a: 0, b: 900 });
    expect(s.match.lastMatchSeconds).toBe(930);
  });

  test('a reconnect mid-match keeps the original firstSeen', async () => {
    const s = warm();
    await run(s, summaryOf([{ steamId: 'a' }], 300));
    await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b' }], 600));
    await run(s, summaryOf([{ steamId: 'a' }], 900)); // b leaves
    await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b' }], 1200)); // b is back
    expect(s.match.firstSeen['b']).toBe(300);
  });

  test('a cold server still records the match, so its first warm cycle is not a first observation', async () => {
    const s = emptyServerState();
    await run(s, summaryOf([{ steamId: 'a' }], 300));
    expect(s.match.firstSeen).toEqual({ a: 0 });
    s.warm = true;
    await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b' }], 330));
    expect(s.match.firstSeen).toEqual({ a: 0, b: 300 });
  });
});

describe('hot right now', () => {
  test('hot at exactly the minutes threshold', async () => {
    // 20 minutes, 10 kills: 30 an hour.
    const events = await run(warm(), summaryOf([{ steamId: 'a', kills: 10, deaths: 2 }], 1200));
    expect(hots(events)).toEqual([
      {
        kind: 'hotPlayer',
        serverId: 's1',
        at: new Date(NOW).toISOString(),
        steamId: 'a',
        name: 'Pa',
        kills: 10,
        deaths: 2,
        minutes: 20,
        perHour: 30
      }
    ]);
  });

  test('hot at exactly the kills and per-hour thresholds', async () => {
    // 24 minutes, 8 kills: exactly 20 an hour.
    const events = await run(warm(), summaryOf([{ steamId: 'a', kills: 8 }], 1440));
    expect(hots(events).map((e) => [e.kills, e.minutes, e.perHour])).toEqual([[8, 24, 20]]);
  });

  test('not hot below the minutes threshold', async () => {
    const events = await run(warm(), summaryOf([{ steamId: 'a', kills: 10 }], 1199));
    expect(hots(events)).toEqual([]);
  });

  test('not hot below the kills threshold', async () => {
    // 20 minutes, 7 kills: 21 an hour, but too few kills.
    const events = await run(warm(), summaryOf([{ steamId: 'a', kills: 7 }], 1200));
    expect(hots(events)).toEqual([]);
  });

  test('not hot below the per-hour threshold', async () => {
    // 30 minutes, 9 kills: 18 an hour.
    const events = await run(warm(), summaryOf([{ steamId: 'a', kills: 9 }], 1800));
    expect(hots(events)).toEqual([]);
  });

  test('time is counted from firstSeen, not from the start of the match', async () => {
    const s = warm();
    await run(s, summaryOf([{ steamId: 'a' }], 600));
    // b appears at 1200, so is dated from the last observation, 600. At 1500 that is 15
    // minutes (60 an hour from the match start would read hot); at 1800 it is 20
    // minutes, and 10 kills is 30 an hour.
    await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b', kills: 10 }], 1200));
    expect(hots(await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b', kills: 10 }], 1500)))).toEqual([]);
    const events = await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'b', kills: 10 }], 1800));
    expect(hots(events).map((e) => [e.steamId, e.minutes, e.perHour])).toEqual([['b', 20, 30]]);
  });

  test('a gap in observation cannot make a newcomer read hot', async () => {
    // Last seen at 600; the panel was unreachable until 2400. c joined somewhere in that
    // gap and already has 9 kills. Dated from 2400, c would need only 2 more kills in
    // 20 minutes to read 33 an hour; dated from 600, at 3600 c's 11 kills over 50 minutes
    // is 13 an hour — correctly not hot.
    const s = warm();
    await run(s, summaryOf([{ steamId: 'a' }], 600));
    await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'c', kills: 9 }], 2400));
    expect(s.match.firstSeen['c']).toBe(600);
    expect(hots(await run(s, summaryOf([{ steamId: 'a' }, { steamId: 'c', kills: 11 }], 3600)))).toEqual([]);
  });

  test('a player posts once per match', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    const first = await run(s, summaryOf([{ steamId: 'a', kills: 10 }], 1200));
    expect(hots(first)).toHaveLength(1);
    expect(s.match.alerted).toEqual(['a']);
    const again = await run(s, summaryOf([{ steamId: 'a', kills: 20 }], 1500));
    expect(hots(again)).toEqual([]);
  });

  test('a match boundary resets, so the same player can alert again in the next match', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    expect(hots(await run(s, summaryOf([{ steamId: 'a', kills: 10 }], 1200)))).toHaveLength(1);

    // The clock went backwards: a new match. Everyone present counts from 0 again.
    const boundary = await run(s, summaryOf([{ steamId: 'a', kills: 0 }], 60));
    expect(hots(boundary)).toEqual([]);
    expect(s.match).toEqual({ lastMatchSeconds: 60, firstSeen: { a: 0 }, alerted: [] });

    expect(hots(await run(s, summaryOf([{ steamId: 'a', kills: 10 }], 1200)))).toHaveLength(1);
  });

  test('a null clock skips the live check without touching the match state', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    await run(s, summaryOf([{ steamId: 'a', kills: 1 }], 600));
    const before = structuredClone(s.match);
    const events = await run(s, summaryOf([{ steamId: 'a', kills: 50 }, { steamId: 'b' }], null));
    expect(hots(events)).toEqual([]);
    expect(s.match).toEqual(before);
  });

  test('a summary with no live data changes nothing, so players are not re-reported as joining', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    await run(s, summaryOf([{ steamId: 'a' }], 600));
    const before = structuredClone(s.match);
    const events = await run(s, { ok: true, live: null }, ['a']);
    expect(events).toEqual([]);
    expect(s.presentSteamIds).toEqual(['a']);
    expect(s.match).toEqual(before);
    // The next good read still sees a, already present: not a join.
    expect(joins(await run(s, summaryOf([{ steamId: 'a' }], 630), ['a']))).toEqual([]);
  });

  test('a summary whose live read failed changes nothing either', async () => {
    const s = warm({ presentSteamIds: ['a'] });
    const failed: SummaryBody = { ok: true, live: { serverId: 's1', ok: false, status: null, players: [] } };
    expect(await run(s, failed, ['a'])).toEqual([]);
    expect(s.presentSteamIds).toEqual(['a']);
  });

  test('a cold server posts no hot player and does not mark one alerted', async () => {
    const s = emptyServerState();
    const events = await run(s, summaryOf([{ steamId: 'a', kills: 10 }], 1200));
    expect(hots(events)).toEqual([]);
    expect(s.match.alerted).toEqual([]);
    // Once warm, the same player still hot is reported.
    s.warm = true;
    expect(hots(await run(s, summaryOf([{ steamId: 'a', kills: 11 }], 1230)))).toHaveLength(1);
  });

  test('a player the scoreboard gives no kill count for is skipped', async () => {
    const summary = summaryOf([{ steamId: 'a' }], 1200);
    const player = summary.live!.players[0]! as unknown as Record<string, unknown>;
    delete player['kills'];
    delete player['deaths'];
    expect(hots(await run(warm({ presentSteamIds: ['a'] }), summary))).toEqual([]);
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
    await run(s, summaryOf([{ steamId: 'a' }], 300));
    const match = structuredClone(s.match);
    const summary = summaryOf([{ steamId: 'a', kills: 20 }, { steamId: 'c' }], 1200);

    await expect(pollPresence(panel(summary, ['c'], true).client, 's1', s, cfg, NOW)).rejects.toThrow(
      'marks 503'
    );
    expect(s.presentSteamIds).toEqual(['a']);
    expect(s.match).toEqual(match); // the hot player is not marked alerted with no event out

    const events = await run(s, summary, ['c']);
    expect(joins(events).map((e) => e.steamId)).toEqual(['c']);
    expect(hots(events).map((e) => e.steamId)).toEqual(['a']);
    expect(s.presentSteamIds).toEqual(['a', 'c']);
  });
});
