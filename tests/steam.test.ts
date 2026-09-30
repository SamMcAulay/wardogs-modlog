import { describe, expect, test } from 'vitest';
import { SteamClient, playtimeOf } from '../src/steam.js';

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
