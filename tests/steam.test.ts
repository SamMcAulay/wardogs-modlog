import { describe, expect, test } from 'vitest';
import { SteamClient, VeteranChecker, playtimeOf, veteranOf, type OwnedGame, type VeteranConfig } from '../src/steam.js';

const WARDOGS = 1867240;

describe('playtimeOf', () => {
  test('totals every game, finds the most played and Wardogs', () => {
    const p = playtimeOf(
      [
        { appid: 1, name: 'Rust', playtime_forever: 6000 },
        { appid: WARDOGS, name: 'WARDOGS', playtime_forever: 1200 },
        { appid: 3, name: 'Unplayed', playtime_forever: 0 }
      ],
      WARDOGS
    );
    expect(p).toEqual({ totalMinutes: 7200, ignoredMinutes: 0, top: { name: 'Rust', minutes: 6000 }, wardogsMinutes: 1200 });
  });

  test('ignored tools leave the total and the top game, but never Wardogs', () => {
    const p = playtimeOf(
      [
        { appid: 1366800, name: 'Crosshair X', playtime_forever: 9000 },
        { appid: 1, name: 'Rust', playtime_forever: 600 },
        { appid: WARDOGS, name: 'WARDOGS', playtime_forever: 300 }
      ],
      WARDOGS,
      new Set([1366800, WARDOGS])
    );
    expect(p).toEqual({ totalMinutes: 900, ignoredMinutes: 9000, top: { name: 'Rust', minutes: 600 }, wardogsMinutes: 300 });
  });

  test('a hidden game list is hidden, not zero hours', () => {
    expect(playtimeOf(undefined, WARDOGS)).toBeNull();
  });

  test('a visible library without Wardogs says so', () => {
    const p = playtimeOf([{ appid: 1, name: 'Rust', playtime_forever: 60 }], WARDOGS);
    expect(p?.wardogsMinutes).toBeNull();
  });

  test('a library of unplayed games has no top game', () => {
    expect(playtimeOf([{ appid: 1, name: 'Rust', playtime_forever: 0 }], WARDOGS)?.top).toBeNull();
  });
});

describe('SteamClient', () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('asks for names and free games, and reads the list', async () => {
    let url = '';
    const steam = new SteamClient({
      apiKey: 'SECRET',
      fetchImpl: async (u) => {
        url = String(u);
        return json({ response: { games: [{ appid: WARDOGS, name: 'WARDOGS', playtime_forever: 90 }] } });
      }
    });
    const p = await steam.playtime('76561198000000001', WARDOGS);
    expect(p?.wardogsMinutes).toBe(90);
    expect(url).toContain('GetOwnedGames');
    expect(url).toContain('include_appinfo=1');
    expect(url).toContain('include_played_free_games=1');
  });

  test('errors never carry the key', async () => {
    const steam = new SteamClient({ apiKey: 'SECRET', fetchImpl: async () => json({}, 500) });
    await expect(steam.playtime('76561198000000001', WARDOGS)).rejects.toThrow(/failed \(500\)/);
    await expect(steam.playtime('76561198000000001', WARDOGS)).rejects.not.toThrow(/SECRET/);
    const down = new SteamClient({
      apiKey: 'SECRET',
      fetchImpl: async () => {
        throw new Error('fetch failed https://api.steampowered.com/?key=SECRET');
      }
    });
    await expect(down.playtime('76561198000000001', WARDOGS)).rejects.not.toThrow(/SECRET/);
  });

  test('resolves a vanity name, or null when no profile has it', async () => {
    const found = new SteamClient({
      apiKey: 'k',
      fetchImpl: async () => json({ response: { success: 1, steamid: '76561198000000001' } })
    });
    expect(await found.resolveVanity('alpha')).toBe('76561198000000001');
    const missing = new SteamClient({ apiKey: 'k', fetchImpl: async () => json({ response: { success: 42 } }) });
    expect(await missing.resolveVanity('nobody')).toBeNull();
  });
});

describe('veteranOf', () => {
  const cfg: VeteranConfig = {
    totalHours: 10_000,
    gameHours: 1_000,
    competitive: new Set([730, 252490]),
    ignored: new Set([431960])
  };
  const h = (hours: number) => hours * 60;

  test('10k hours across all games, the ignored tools left out', () => {
    const games: OwnedGame[] = [
      { appid: 1, name: 'Factorio', playtime_forever: h(6_000) },
      { appid: 2, name: 'Stardew', playtime_forever: h(4_000) }
    ];
    expect(veteranOf(games, cfg)).toEqual({ totalMinutes: h(10_000) });
    // Wallpaper Engine's hours don't lift a 9,999 h library over the line.
    const padded = [{ appid: 1, name: 'Factorio', playtime_forever: h(9_999) }, { appid: 431960, playtime_forever: h(5_000) }];
    expect(veteranOf(padded, cfg)).toBeNull();
  });

  test('1k hours in one competitive game, naming the most played', () => {
    const games: OwnedGame[] = [
      { appid: 730, name: 'Counter-Strike 2', playtime_forever: h(1_500) },
      { appid: 252490, name: 'Rust', playtime_forever: h(1_200) },
      { appid: 3, name: 'Factorio', playtime_forever: h(5_000) } // not competitive
    ];
    expect(veteranOf(games, cfg)).toEqual({ game: { name: 'Counter-Strike 2', minutes: h(1_500) } });
  });

  test('both lines at once', () => {
    const games: OwnedGame[] = [
      { appid: 730, name: 'Counter-Strike 2', playtime_forever: h(3_000) },
      { appid: 3, name: 'Factorio', playtime_forever: h(8_000) }
    ];
    expect(veteranOf(games, cfg)).toEqual({ totalMinutes: h(11_000), game: { name: 'Counter-Strike 2', minutes: h(3_000) } });
  });

  test('under both lines, a hidden list, or a line set to 0 tags nothing', () => {
    expect(veteranOf([{ appid: 730, name: 'CS2', playtime_forever: h(999) }], cfg)).toBeNull();
    expect(veteranOf(undefined, cfg)).toBeNull();
    expect(veteranOf([{ appid: 730, name: 'CS2', playtime_forever: h(20_000) }], { ...cfg, totalHours: 0, gameHours: 0 })).toBeNull();
  });
});

describe('VeteranChecker', () => {
  const cfg: VeteranConfig = { totalHours: 10_000, gameHours: 1_000, competitive: new Set([730]), ignored: new Set() };
  const vet: OwnedGame[] = [{ appid: 730, name: 'Counter-Strike 2', playtime_forever: 1_000 * 60 }];
  const fake = (answers: Record<string, OwnedGame[] | undefined | Error>) => {
    const asked: string[] = [];
    return {
      asked,
      steam: {
        ownedGames: async (id: string) => {
          asked.push(id);
          const a = answers[id];
          if (a instanceof Error) throw a;
          return a;
        }
      }
    };
  };

  test('returns only the veterans, and remembers every answer for the TTL', async () => {
    const f = fake({ a: vet, b: [], c: undefined });
    const checker = new VeteranChecker(f.steam, cfg, 1000);
    const first = await checker.check(['a', 'b', 'c'], 0);
    expect([...first.keys()]).toEqual(['a']);
    const again = await checker.check(['a', 'b', 'c'], 999);
    expect([...again.keys()]).toEqual(['a']);
    expect(f.asked).toEqual(['a', 'b', 'c']); // nobody asked twice
    await checker.check(['b'], 1000);
    expect(f.asked).toEqual(['a', 'b', 'c', 'b']); // expired
  });

  test('a failed lookup tags nobody, is logged, and is asked again next time', async () => {
    const f = fake({ a: new Error('steam IPlayerService/GetOwnedGames/v1 failed (429)'), b: vet });
    const warnings: string[] = [];
    const checker = new VeteranChecker(f.steam, cfg, 1000, (m) => warnings.push(m));
    expect([...(await checker.check(['a', 'b'], 0)).keys()]).toEqual(['b']);
    expect(warnings).toEqual(['steam veteran check for a: steam IPlayerService/GetOwnedGames/v1 failed (429)']);
    await checker.check(['a'], 1);
    expect(f.asked.filter((id) => id === 'a')).toHaveLength(2);
  });
});
