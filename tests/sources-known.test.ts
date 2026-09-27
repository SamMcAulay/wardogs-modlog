import { describe, expect, test } from 'vitest';
import { MAX_PAGES, PAGE_SIZE, pollKnown, type KnownConfig } from '../src/sources/known.js';
import { emptyServerState, type ServerState } from '../src/state.js';
import type { BoardRow } from '../src/warcon-types.js';
import type { WarconClient } from '../src/warcon.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const cfg: KnownConfig = {
  sweatPerHour: 15,
  sweatRange: '30d',
  rateMinMinutes: 180,
  kdThreshold: 4,
  kdMinMatches: 5,
  kdMinMinutes: 60,
  kdRange: '30d'
};

/** `rate` kills per hour over `minutes`. */
const rateRow = (steamId: string, rate: number, minutes = 600): BoardRow => ({
  steamId,
  name: `P${steamId}`,
  minutes,
  kills: (rate * minutes) / 60,
  deaths: 10,
  matches: 9
});

const kdRow = (steamId: string, over: Partial<BoardRow> = {}): BoardRow => ({
  steamId,
  name: `P${steamId}`,
  minutes: 400,
  kills: 52,
  deaths: 10,
  matches: 9,
  ...over
});

/** A fake panel serving the perHour board in pages and the K/D board whole; logs paths. */
function panel(opts: { sweat?: BoardRow[]; kd?: BoardRow[]; fail?: 'perHour' | 'kd' }) {
  const paths: string[] = [];
  const client = {
    getJson: async (path: string) => {
      paths.push(path);
      const url = new URL(path, 'http://x');
      const sort = url.searchParams.get('sort');
      if (sort === opts.fail) throw new Error(`${sort} board down`);
      if (sort === 'perHour') {
        const page = Number(url.searchParams.get('page'));
        const rows = (opts.sweat ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        return { ok: true, rows, query: { sort } };
      }
      return { ok: true, rows: opts.kd ?? [], query: { sort } };
    }
  } as unknown as WarconClient;
  return { client, paths };
}

const refresh = async (opts: Parameters<typeof panel>[0], s: ServerState = emptyServerState()) => {
  const { client, paths } = panel(opts);
  const events = await pollKnown(client, 's1', s, cfg, NOW);
  return { s, paths, events };
};

describe('pollKnown', () => {
  test('refreshes both lists from both boards, stamps knownAt and posts nothing', async () => {
    const { s, events, paths } = await refresh({
      sweat: [rateRow('a', 20), rateRow('b', 15), rateRow('c', 14.9)],
      kd: [kdRow('k'), kdRow('ok', { kills: 10, deaths: 10 })]
    });
    expect(events).toEqual([]);
    expect(s.knownSweats).toEqual(['a', 'b']);
    expect(s.knownHighKd).toEqual(['k']);
    expect(s.knownAt).toBe(NOW);
    expect(paths).toEqual([
      '/api/servers/s1/leaderboard?scope=server&range=30d&sort=perHour&dir=desc&minMinutes=180&page=1',
      '/api/servers/s1/leaderboard?scope=server&range=30d&sort=kd&dir=desc&minMinutes=60'
    ]);
  });

  test('replaces the old lists rather than adding to them', async () => {
    const s = { ...emptyServerState(), knownSweats: ['gone'], knownHighKd: ['gone'], knownAt: 1 };
    await refresh({ sweat: [rateRow('a', 20)], kd: [] }, s);
    expect(s.knownSweats).toEqual(['a']);
    expect(s.knownHighKd).toEqual([]);
  });

  test.each(['perHour', 'kd'] as const)('a failed %s board keeps the old lists and knownAt', async (fail) => {
    const s = { ...emptyServerState(), knownSweats: ['old'], knownHighKd: ['oldkd'], knownAt: 1 };
    const { client } = panel({ sweat: [rateRow('a', 20)], kd: [kdRow('k')], fail });
    await expect(pollKnown(client, 's1', s, cfg, NOW)).rejects.toThrow('board down');
    expect(s.knownSweats).toEqual(['old']);
    expect(s.knownHighKd).toEqual(['oldkd']);
    expect(s.knownAt).toBe(1);
  });
});

describe('the sweat list', () => {
  test("uses the panel's rate, which leaves seeding time out", async () => {
    // 150 kills over 660 minutes, 60 of them seeding: 15.0 an hour by Warcon's formula.
    const seeder: BoardRow = { ...rateRow('s', 0), kills: 150, minutes: 660, seedMinutes: 60 };
    // 150 over 660 with no seeding is 13.6 an hour: not a sweat.
    const plain: BoardRow = { ...rateRow('p', 0), kills: 150, minutes: 660 };
    const { s } = await refresh({ sweat: [seeder, plain] });
    expect(s.knownSweats).toEqual(['s']);
  });

  test('pages while a full page ends above the threshold, and stops at four', async () => {
    const hot = Array.from({ length: PAGE_SIZE * 5 }, (_, i) => rateRow(`h${i}`, 30));
    const { s, paths } = await refresh({ sweat: hot });
    expect(paths.filter((p) => p.includes('sort=perHour'))).toHaveLength(MAX_PAGES);
    expect(s.knownSweats).toHaveLength(PAGE_SIZE * MAX_PAGES);
  });

  test('stops paging on a short page', async () => {
    const { paths } = await refresh({ sweat: [rateRow('a', 30)] });
    expect(paths.filter((p) => p.includes('sort=perHour'))).toHaveLength(1);
  });

  test('stops paging on a page whose last row is below the threshold', async () => {
    const rows = [...Array.from({ length: PAGE_SIZE - 1 }, (_, i) => rateRow(`h${i}`, 30)), rateRow('cold', 5)];
    const { paths } = await refresh({ sweat: [...rows, rateRow('never', 30)] });
    expect(paths.filter((p) => p.includes('sort=perHour'))).toHaveLength(1);
  });

  test('keeps paging past a last row that is above the threshold only once seeding is left out', async () => {
    // 150 kills over 900 minutes is 10/hour, but 300 of them were seeding: 15/hour on the panel.
    const heavySeeder: BoardRow = { ...rateRow('seed', 0), kills: 150, minutes: 900, seedMinutes: 300 };
    const rows = [...Array.from({ length: PAGE_SIZE - 1 }, (_, i) => rateRow(`h${i}`, 30)), heavySeeder, rateRow('next', 16)];
    const { s, paths } = await refresh({ sweat: rows });
    expect(paths.filter((p) => p.includes('sort=perHour'))).toHaveLength(2);
    expect(s.knownSweats).toContain('seed');
    expect(s.knownSweats).toContain('next');
  });
});

describe('the high K/D list', () => {
  test('lists a player over the K/D threshold with enough matches', async () => {
    expect((await refresh({ kd: [kdRow('a')] })).s.knownHighKd).toEqual(['a']);
  });

  test('the threshold is inclusive', async () => {
    expect((await refresh({ kd: [kdRow('a', { kills: 40, deaths: 10 })] })).s.knownHighKd).toEqual(['a']);
  });

  test('leaves out a high K/D with too few matches', async () => {
    expect((await refresh({ kd: [kdRow('a', { matches: 4 })] })).s.knownHighKd).toEqual([]);
  });

  test('leaves out an ordinary K/D', async () => {
    expect((await refresh({ kd: [kdRow('a', { kills: 10, deaths: 10 })] })).s.knownHighKd).toEqual([]);
  });

  test('zero deaths is not an infinite K/D', async () => {
    expect((await refresh({ kd: [kdRow('a', { kills: 3, deaths: 0 })] })).s.knownHighKd).toEqual([]);
  });

  test('a player with no kills and no deaths is not listed', async () => {
    expect((await refresh({ kd: [kdRow('a', { kills: 0, deaths: 0 })] })).s.knownHighKd).toEqual([]);
  });
});
