import { describe, expect, test } from 'vitest';
import type { BoardCache } from '../src/board-cache.js';
import {
  LOOKUP_COMMAND,
  escapeMd,
  gatherLookup,
  hours,
  lookupMessage,
  parsePlayerInput,
  type LookupData
} from '../src/lookup.js';
import { parseActionId, playerNameFromTitle } from '../src/player-actions.js';
import type { SteamClient } from '../src/steam.js';
import type { WarconClient } from '../src/warcon.js';
import type { Dossier } from '../src/warcon-types.js';

const STEAM = '76561198000000001';
const EU1 = '0eec42dc-f73f-4e43-a62e-7e0900fcf38c';
const NA1 = '0abd34ac-c564-4d2e-9853-263d707528c3';
const links = { panelPublicUrl: 'https://panel.example.com', serverLabels: { [EU1]: 'EU#1', [NA1]: 'NA#1' } };

const dossier = (over: Partial<Dossier> = {}): Dossier => ({
  steamId: STEAM,
  name: 'Alpha',
  names: ['Alpha', 'xX_Alpha_Xx', 'OldAlpha'],
  online: null,
  steam: {
    persona: 'Alpha',
    profileUrl: `https://steamcommunity.com/profiles/${STEAM}`,
    public: true,
    accountAgeDays: 730,
    vacBans: 0,
    gameBans: 0,
    daysSinceLastBan: null,
    communityBanned: false
  },
  risk: { score: 10, level: 'low', reasons: [] },
  watch: { watched: false, reason: '', updatedByName: '', updatedAt: null },
  bannedOn: [],
  summary: {
    sessions: 12,
    minutes: 1200,
    kills: 300,
    deaths: 100,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-09-29T00:00:00.000Z'
  },
  combat: { teamKills: 4, teamKilled: 2, headshots: 50 },
  perServer: [
    { serverId: NA1, serverName: 'Warcon NA', sessions: 2, minutes: 200, lastSeen: '2026-09-01T00:00:00.000Z' },
    { serverId: EU1, serverName: 'Warcon EU', sessions: 10, minutes: 1000, lastSeen: '2026-09-29T00:00:00.000Z' }
  ],
  notes: [],
  ...over
});

const data = (over: Partial<LookupData> = {}, d: Partial<Dossier> = {}): LookupData => ({
  dossier: dossier(d),
  thirty: { ok: true, value: { row: { minutes: 600, seedMinutes: 0, kills: 40, deaths: 10, matches: 9 }, cutMinutes: null } },
  lifetime: { ok: true, value: { row: { minutes: 1200, seedMinutes: 200, kills: 300, deaths: 100, matches: 30 }, cutMinutes: null } },
  steam: {
    ok: true,
    value: { totalMinutes: 300_000, ignoredMinutes: 0, top: { name: 'Rust', minutes: 120_000 }, wardogsMinutes: 6000 }
  },
  ...over
});

const text = (m: ReturnType<typeof lookupMessage>): string =>
  [m.embeds[0]!.description, ...m.embeds[0]!.fields!.map((f) => `${f.name}: ${f.value}`)].join('\n');
const fieldOf = (m: ReturnType<typeof lookupMessage>, name: string) =>
  m.embeds[0]!.fields!.find((f) => f.name === name)?.value;

describe('parsePlayerInput', () => {
  test('a SteamID64, a profile link, or a vanity link', () => {
    expect(parsePlayerInput(` ${STEAM} `)).toEqual({ steamId: STEAM });
    expect(parsePlayerInput(`https://steamcommunity.com/profiles/${STEAM}/`)).toEqual({ steamId: STEAM });
    expect(parsePlayerInput('steamcommunity.com/id/alpha_1/')).toEqual({ vanity: 'alpha_1' });
  });

  test('names and malformed ids are refused', () => {
    expect(parsePlayerInput('Alpha')).toBeNull();
    expect(parsePlayerInput('12345678901234567')).toBeNull();
    expect(parsePlayerInput(`${STEAM}1`)).toBeNull();
    expect(parsePlayerInput('https://example.com/id/alpha')).toBeNull();
  });
});

describe('the command', () => {
  test('is /lookup with one required player option, guild only', () => {
    expect(LOOKUP_COMMAND.name).toBe('lookup');
    expect(LOOKUP_COMMAND.contexts).toEqual([0]);
    expect(LOOKUP_COMMAND.options[0]).toMatchObject({ type: 3, name: 'player', required: true });
  });
});

describe('gatherLookup', () => {
  const warcon = (fail = false) =>
    ({
      getJson: async (path: string) => {
        if (fail) throw new Error('warcon request failed (500)');
        expect(path).toBe(`/api/servers/${EU1}/players/${STEAM}`);
        return { ok: true, dossier: dossier() };
      }
    }) as unknown as WarconClient;
  const boards = (fail = false) =>
    ({
      row: async () => {
        if (fail) throw new Error('export down');
        return { row: null, cutMinutes: null };
      }
    }) as unknown as BoardCache;

  test('reads the dossier, both boards and Steam', async () => {
    const steam = { playtime: async () => null } as unknown as SteamClient;
    const d = await gatherLookup({ warcon: warcon(), boards: boards(), steam, serverId: EU1, wardogsAppId: 1, ignoredAppIds: new Set<number>() }, STEAM);
    expect(d.dossier.name).toBe('Alpha');
    expect(d.thirty).toEqual({ ok: true, value: { row: null, cutMinutes: null } });
    expect(d.steam).toEqual({ ok: true, value: null });
  });

  test('a failed board or no Steam key is a part missing, not a failed lookup', async () => {
    const d = await gatherLookup({ warcon: warcon(), boards: boards(true), steam: null, serverId: EU1, wardogsAppId: 1, ignoredAppIds: new Set<number>() }, STEAM);
    expect(d.thirty).toEqual({ ok: false, reason: 'export down' });
    expect(d.steam).toEqual({ ok: false, reason: 'not configured' });
  });

  test('a failed dossier fails the lookup', async () => {
    await expect(
      gatherLookup({ warcon: warcon(true), boards: boards(), steam: null, serverId: EU1, wardogsAppId: 1, ignoredAppIds: new Set<number>() }, STEAM)
    ).rejects.toThrow('500');
  });
});

describe('lookupMessage', () => {
  test('shows the name, its history and every figure asked for', () => {
    const m = lookupMessage(data(), links, EU1);
    const e = m.embeds[0]!;
    expect(e.title).toBe('Lookup — Alpha');
    expect(playerNameFromTitle(e.title)).toBe('Alpha');
    expect(e.url).toBe(`https://panel.example.com/server/${EU1}/players/${STEAM}`);
    expect(fieldOf(m, 'Also known as')).toBe('xX\\_Alpha\\_Xx · OldAlpha');
    const h = fieldOf(m, 'Hours')!;
    expect(h).toContain('Our servers: **20 h** (12 sessions)');
    expect(h).toContain('Wardogs total: **100 h**');
    expect(h).toContain('All Steam games: **5,000 h**');
    expect(h).toContain('Most played: Rust (**2,000 h**)');
    // Lifetime K/D from the dossier; the rate from the export, seeding left out: 300 / (1000/60).
    expect(fieldOf(m, 'Lifetime')).toContain('K/D **3.00**');
    expect(fieldOf(m, 'Lifetime')).toContain('**18.0** kills/h');
    expect(fieldOf(m, 'Last 30 days')).toContain('K/D **4.00**');
    expect(fieldOf(m, 'Last 30 days')).toContain('**4.0** kills/h');
    expect(fieldOf(m, 'Team kills')).toBe('**4** given\n2 received');
    expect(fieldOf(m, 'Time per server')).toBe('EU#1 17 h · NA#1 3.3 h');
  });

  test('offline: Watch only, no Kick', () => {
    const m = lookupMessage(data(), links, EU1);
    expect(m.components[0]!.components.map((b) => b.label)).toEqual(['Watch']);
  });

  test('online: Kick and Watch on the server they are on', () => {
    const m = lookupMessage(data({}, { online: { serverId: NA1, serverName: 'Warcon NA' } }), links, EU1);
    expect(m.embeds[0]!.description).toContain('Online now on **NA#1**');
    const ids = m.components[0]!.components.map((b) => parseActionId(b.custom_id));
    expect(ids.map((i) => [i?.action, i?.serverId])).toEqual([
      ['kick', NA1],
      ['watch', NA1]
    ]);
  });

  test('watched and offline: no buttons, and the reason shows', () => {
    const m = lookupMessage(data({}, { watch: { watched: true, reason: 'aimbot?', updatedByName: 'Mod', updatedAt: null } }), links, EU1);
    expect(m.components).toEqual([]);
    expect(m.embeds[0]!.description).toContain('👁️ **Watched:** aimbot?');
    expect(m.embeds[0]!.color).toBe(0x3498db);
  });

  test('banned is red and lists where', () => {
    const m = lookupMessage(
      data({}, { bannedOn: [{ serverId: EU1, serverName: 'x', reason: 'cheating', bannedBy: 'Mod' }] }),
      links,
      EU1
    );
    expect(m.embeds[0]!.color).toBe(0xe74c3c);
    expect(fieldOf(m, 'Banned on')).toBe('EU#1: cheating (by Mod)');
  });

  test('missing parts say why instead of showing zeros', () => {
    const m = lookupMessage(
      data({ thirty: { ok: false, reason: 'x' }, lifetime: { ok: false, reason: 'x' }, steam: { ok: true, value: null } }, { combat: null }),
      links,
      EU1
    );
    expect(fieldOf(m, 'Last 30 days')).toBe('unavailable');
    expect(fieldOf(m, 'Lifetime')).toContain('(seeding included)');
    expect(fieldOf(m, 'Hours')).toContain('Steam: hidden (game details are private)');
    expect(fieldOf(m, 'Team kills')).toBe('No kill feed yet');
  });

  test('no Steam key, and no play in 30 days', () => {
    const m = lookupMessage(data({ steam: { ok: false, reason: 'not configured' }, thirty: { ok: true, value: { row: null, cutMinutes: null } } }), links, EU1);
    expect(fieldOf(m, 'Hours')).toContain('not configured');
    expect(fieldOf(m, 'Last 30 days')).toBe('No play');
  });

  test('missing from a full export reads as little play, not none', () => {
    const m = lookupMessage(data({ thirty: { ok: true, value: { row: null, cutMinutes: 90 } } }), links, EU1);
    expect(fieldOf(m, 'Last 30 days')).toBe("Under 1.5 h played, too little for Warcon's export");
  });

  test('left-out overlay hours are named', () => {
    const steam = { ok: true as const, value: { totalMinutes: 6000, ignoredMinutes: 1200, top: null, wardogsMinutes: 60 } };
    expect(fieldOf(lookupMessage(data({ steam }), links, EU1), 'Hours')).toContain(
      'All Steam games: **100 h** (overlay tools left out: 20 h)'
    );
  });

  test('a player never seen here still gets their Steam side', () => {
    const m = lookupMessage(
      data({}, { name: STEAM, names: [], perServer: [], summary: { sessions: 0, minutes: 0, kills: 0, deaths: 0, firstSeen: null, lastSeen: null } }),
      links,
      EU1
    );
    expect(text(m)).toContain('Never seen on our servers.');
    expect(fieldOf(m, 'Also known as')).toBe('No other names');
    expect(fieldOf(m, 'Time per server')).toBeUndefined();
    expect(fieldOf(m, 'Lifetime')).toBe('No play');
    expect(fieldOf(m, 'Hours')).toContain('Wardogs total');
  });

  test('every field fits Discord', () => {
    const long = 'x'.repeat(3000);
    const m = lookupMessage(
      data({}, { names: Array.from({ length: 10 }, (_, i) => `${long}${i}`), notes: [{ authorName: 'M', body: long, createdAt: '2026-09-01T00:00:00Z' }] }),
      links,
      EU1
    );
    for (const f of m.embeds[0]!.fields!) expect(f.value.length).toBeLessThanOrEqual(1024);
  });
});

describe('formatting', () => {
  test('hours read naturally', () => {
    expect(hours(90)).toBe('1.5 h');
    expect(hours(60 * 1234)).toBe('1,234 h');
  });

  test('player text shows as typed', () => {
    expect(escapeMd('**bold** _x_ `c`')).toBe('\\*\\*bold\\*\\* \\_x\\_ \\`c\\`');
  });
});
