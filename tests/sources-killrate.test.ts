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

  test("uses the panel's rate, which leaves seeding time out", async () => {
    // 150 kills over 660 minutes, 60 of them seeding: 15.0 an hour by Warcon's formula.
    const seeder: BoardRow = { ...row('s', 0), kills: 150, minutes: 660, seedMinutes: 60 };
    const { client } = panel({ boards: { '30d': [seeder] } });
    const [e] = (await pollKillRate(client, 's1', emptyState(), cfg, NOW)) as KillRateEvent[];
    expect(e!.sweat).toEqual({ perHour: 15, kills: 150, minutes: 660, range: '30d' });
  });

  test('keeps paging past a last row that is above the threshold only once seeding is left out', async () => {
    // 150 kills over 900 minutes is 10/hour, but 300 of them were seeding: 15/hour on the panel.
    const heavySeeder: BoardRow = { ...row('seed', 0), kills: 150, minutes: 900, seedMinutes: 300 };
    const rows = [...Array.from({ length: PAGE_SIZE - 1 }, (_, i) => row(`h${i}`, 30)), heavySeeder, row('next', 16)];
    const { client, paths } = panel({ boards: { '30d': rows } });
    const events = (await pollKillRate(client, 's1', emptyState(), cfg, NOW)) as KillRateEvent[];
    expect(paths.filter((p) => p.includes('range=30d'))).toHaveLength(2);
    expect(events.map((e) => e.steamId)).toContain('seed');
    expect(events.map((e) => e.steamId)).toContain('next');
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

  test('compares the seed-inclusive recent rate with the usual rate', async () => {
    // 75 kills over 300 minutes is 15/hour with seeding in (22.5 without): the usual rate
    // includes seeding, so the ratio is 15 / 10.
    const seeder: BoardRow = { ...row('a', 0, 300), kills: 75, seedMinutes: 100 };
    const { client } = panel({ boards: { '7d': [seeder] }, dossiers: { a: usual(10) } });
    const [e] = (await pollKillRate(client, 's1', emptyState(), cfg, NOW)) as KillRateEvent[];
    expect(e!.surge).toEqual({
      perHour: 15, minutes: 300, usualPerHour: 10, usualMinutes: 6000, ratio: 1.5, range: '7d'
    });
  });

  test('the surge floor uses the seed-inclusive rate, but paging never stops early', async () => {
    // 'mild' is 12/hour on the panel but 9/hour with seeding in: under the floor.
    const mild: BoardRow = { ...row('mild', 0, 400), kills: 60, seedMinutes: 100 };
    const rows = [...Array.from({ length: PAGE_SIZE - 1 }, (_, i) => row(`h${i}`, 30, 300)), mild, row('next', 20, 300)];
    const dossiers = Object.fromEntries(rows.map((r) => [r.steamId, usual(10)]));
    const state = emptyState();
    for (const r of rows) state.baselines[`s1:${r.steamId}`] = { perHour: 10, minutes: 6000, at: NOW };
    const { client, paths } = panel({ boards: { '7d': rows }, dossiers });
    const events = (await pollKillRate(client, 's1', state, cfg, NOW)) as KillRateEvent[];
    expect(paths.filter((p) => p.includes('range=7d'))).toHaveLength(2);
    const ids = events.map((e) => e.steamId);
    expect(ids).not.toContain('mild');
    expect(ids).toContain('next');
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
