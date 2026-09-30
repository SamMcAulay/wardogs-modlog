import { describe, expect, test } from 'vitest';
import { BoardCache, parseCsv, parseExport } from '../src/board-cache.js';
import type { WarconClient } from '../src/warcon.js';

const HEADER =
  'rank,steam_id,name,playtime_min,seeded_min,kills,deaths,kd,kills_per_hour,headshots,team_kills,suicides,vehicle_kills,kill_streak,death_streak,matches,wins,losses,draws,win_pct,cash,last_seen';
const csv = (...rows: string[]): string => [HEADER, ...rows].join('\r\n');
const ALPHA = '1,76561190000000001,"Alpha, ""the"" one",600,60,90,30,3,10,0,0,0,0,0,0,12,0,0,0,,0,';

describe('parseCsv', () => {
  test('reads quoted commas, doubled quotes and line breaks', () => {
    expect(parseCsv('a,"b,c","say ""hi""","two\nlines"\r\nx,y,z,w')).toEqual([
      ['a', 'b,c', 'say "hi"', 'two\nlines'],
      ['x', 'y', 'z', 'w']
    ]);
  });
});

describe('parseExport', () => {
  test('keys rows by Steam ID, reading columns by name', () => {
    const rows = parseExport(csv(ALPHA));
    expect(rows.get('76561190000000001')).toEqual({ minutes: 600, seedMinutes: 60, kills: 90, deaths: 30, matches: 12 });
  });

  test('an export missing a column fails loudly', () => {
    expect(() => parseExport('steam_id,name\r\n1,a')).toThrow(/playtime_min/);
  });
});

describe('BoardCache', () => {
  const fakeClient = (answers: (() => Promise<string>)[]) => {
    const paths: string[] = [];
    const client = {
      getCsv: (path: string) => {
        paths.push(path);
        return answers.shift()!();
      }
    } as unknown as WarconClient;
    return { client, paths };
  };

  test('reads the org export once an hour per range', async () => {
    let now = 0;
    const { client, paths } = fakeClient([async () => csv(ALPHA), async () => csv()]);
    const cache = new BoardCache(client, 'srv', () => now);
    expect((await cache.row('30d', '76561190000000001'))?.kills).toBe(90);
    expect(await cache.row('30d', '76561190000000009')).toBeNull();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('/api/servers/srv/leaderboard/export?');
    expect(paths[0]).toContain('scope=org');
    expect(paths[0]).toContain('range=30d');
    expect(paths[0]).toContain('minMinutes=0');
    now = 61 * 60 * 1000;
    expect(await cache.row('30d', '76561190000000001')).toBeNull();
    expect(paths).toHaveLength(2);
  });

  test('lookups arriving together share one download', async () => {
    const { client, paths } = fakeClient([async () => csv(ALPHA)]);
    const cache = new BoardCache(client, 'srv', () => 0);
    await Promise.all([cache.row('all', 'a'), cache.row('all', 'b'), cache.row('all', 'c')]);
    expect(paths).toHaveLength(1);
  });

  test('a failed refresh serves the last copy, and throws with none', async () => {
    let now = 0;
    const { client } = fakeClient([
      async () => {
        throw new Error('panel down');
      },
      async () => csv(ALPHA),
      async () => {
        throw new Error('panel down');
      }
    ]);
    const cache = new BoardCache(client, 'srv', () => now);
    await expect(cache.row('30d', '76561190000000001')).rejects.toThrow('panel down');
    expect((await cache.row('30d', '76561190000000001'))?.kills).toBe(90);
    now = 2 * 60 * 60 * 1000;
    expect((await cache.row('30d', '76561190000000001'))?.kills).toBe(90);
  });
});
