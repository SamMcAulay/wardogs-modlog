import { describe, expect, test } from 'vitest';
import { checkAll, type CheckResult } from '../src/preflight.js';
import { WarconAuthError } from '../src/warcon.js';

const config = {
  serverIds: ['s1'],
  discordToken: 'dtok',
  discordChannelId: '111',
  discordModRoleId: '222',
  kdRange: '30d',
  kdMinMinutes: 60,
  sweatRange: '30d',
  rateMinMinutes: 180,
  serverLabels: { s1: 'EU#1' }
};

// Routes by URL so the channel and mod-role checks get sensible answers too,
// not just /users/@me.
const okDiscord = async (url: string) => {
  if (url.includes('/channels/')) {
    return new Response(JSON.stringify({ id: '111', name: 'mod-log', guild_id: 'g1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (url.includes('/guilds/') && url.endsWith('/roles')) {
    return new Response(JSON.stringify([{ id: '222', name: 'Moderator' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ username: 'modlog' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

const EXPORT = 'rank,steam_id,name,playtime_min,seeded_min,kills,deaths,matches\r\n1,765,A,60,0,5,1,1';

describe('checkAll', () => {
  test('passes when every endpoint answers', async () => {
    const client = {
      getJson: async () => ({
        ok: true, entries: [], kills: [], rows: [], marks: [], live: null, query: { sort: 'perHour' },
        dossier: { names: [], summary: {} }
      }),
      getCsv: async () => EXPORT
    } as never;
    const results = await checkAll(client, config as never, okDiscord);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test('reports a missing audit.read distinctly from other failures', async () => {
    const client = {
      getJson: async (path: string) => {
        if (path.startsWith('/api/audit')) throw new WarconAuthError('warcon auth rejected (403)');
        return { ok: true, entries: [], kills: [], rows: [], marks: [], live: null };
      }
    } as never;
    const results = await checkAll(client, config as never, okDiscord);
    const audit = results.find((r) => r.name.includes('audit'))!;
    expect(audit.ok).toBe(false);
    expect(audit.detail).toMatch(/audit\.read/);
  });

  test('reports a bad Discord token', async () => {
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
    } as never;
    const bad = async () => new Response('{}', { status: 401 });
    const results = await checkAll(client, config as never, bad);
    expect(results.find((r) => r.name === 'discord token')!.ok).toBe(false);
  });

  test('a labelled server\'s label result is ok and names both the label and the live name', async () => {
    const client = {
      getJson: async (path: string) => {
        if (path.endsWith('/summary')) {
          return { ok: true, live: { serverId: 's1', ok: true, status: { serverName: 'Warcon EU Server 1' }, players: [] } };
        }
        return { ok: true, entries: [], kills: [], rows: [] };
      }
    } as never;
    const results = await checkAll(client, config as never, okDiscord);
    const label = results.find((r) => r.name === 'label (s1)')!;
    expect(label.ok).toBe(true);
    expect(label.detail).toContain('EU#1');
    expect(label.detail).toContain('Warcon EU Server 1');
  });

  test('an unlabelled server\'s result is ok and contains "add it to SERVER_LABELS"', async () => {
    const unlabelled = { ...config, serverIds: ['s2'], serverLabels: {} };
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
    } as never;
    const results = await checkAll(client, unlabelled as never, okDiscord);
    const label = results.find((r) => r.name === 'label (s2)')!;
    expect(label.ok).toBe(true);
    expect(label.detail).toContain('add it to SERVER_LABELS');
  });

  test('channel visible and role present are both ok', async () => {
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
    } as never;
    const results = await checkAll(client, config as never, okDiscord);
    expect(results.find((r) => r.name === 'discord channel')!.ok).toBe(true);
    expect(results.find((r) => r.name === 'discord mod role')!.ok).toBe(true);
  });

  test('a 403 on the channel fails that check and skips the role check', async () => {
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
    } as never;
    const forbiddenChannel = async (url: string) => {
      if (url.includes('/channels/')) return new Response('{}', { status: 403 });
      return okDiscord(url);
    };
    const results = await checkAll(client, config as never, forbiddenChannel);
    const channel = results.find((r) => r.name === 'discord channel')!;
    const role = results.find((r) => r.name === 'discord mod role')!;
    expect(channel.ok).toBe(false);
    expect(role.ok).toBe(false);
    expect(role.detail).toContain('skipped');
  });

  test('a role missing from the guild fails naming the id', async () => {
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
    } as never;
    const noSuchRole = async (url: string) => {
      if (url.includes('/guilds/') && url.endsWith('/roles')) {
        return new Response(JSON.stringify([{ id: '999', name: 'Someone Else' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return okDiscord(url);
    };
    const results = await checkAll(client, config as never, noSuchRole);
    const role = results.find((r) => r.name === 'discord mod role')!;
    expect(role.ok).toBe(false);
    expect(role.detail).toContain('222');
  });
});

describe('sweat-list board', () => {
  const PERHOUR =
    '/api/servers/s1/leaderboard?scope=server&range=30d&sort=perHour&dir=desc&minMinutes=180&page=1';
  const rowA = { steamId: '765', name: 'A', minutes: 600, kills: 150, deaths: 10, matches: 9 };

  /** A panel whose perHour board answers as given; everything else answers. */
  const panel = (board: unknown) => {
    const paths: string[] = [];
    const client = {
      getJson: async (path: string) => {
        paths.push(path);
        if (path === PERHOUR) return board;
        return { ok: true, entries: [], kills: [], rows: [], marks: [], live: null };
      }
    } as never;
    return { client, paths };
  };
  const find = (results: CheckResult[], name: string): CheckResult | undefined =>
    results.find((r) => r.name === name);

  test('a panel that sorts by perHour passes, and no dossier is read', async () => {
    const { client, paths } = panel({ ok: true, rows: [rowA], query: { sort: 'perHour' } });
    const results = await checkAll(client, config as never, okDiscord);
    expect(find(results, 'perHour board (s1)')!.ok).toBe(true);
    expect(paths).toContain(PERHOUR);
    // The per-server checks read no dossier; /lookup's check reads one, once.
    expect(paths.filter((p) => /\/players\/\d+$/.test(p))).toEqual(['/api/servers/s1/players/76561197960287930']);
    expect(results.some((r) => r.name.startsWith('dossier'))).toBe(false);
  });

  test('a panel that falls back to another sort fails the perHour check', async () => {
    const { client } = panel({ ok: true, rows: [rowA], query: { sort: 'kills' } });
    const board = find(await checkAll(client, config as never, okDiscord), 'perHour board (s1)')!;
    expect(board.ok).toBe(false);
    expect(board.detail).toContain('kills');
  });

  test('a rejected perHour board is explained', async () => {
    const client = {
      getJson: async (path: string) => {
        if (path === PERHOUR) throw new WarconAuthError('warcon auth rejected (403)');
        return { ok: true, entries: [], kills: [], rows: [], marks: [], live: null };
      }
    } as never;
    const board = find(await checkAll(client, config as never, okDiscord), 'perHour board (s1)')!;
    expect(board.ok).toBe(false);
    expect(board.detail).toContain('server.view');
  });
});

describe('live-data check', () => {
  const summaryWith = (matchSeconds: unknown) => ({
    ok: true,
    live: { serverId: 's1', ok: true, status: { serverName: 'EU 1', matchSeconds }, players: [] }
  });
  const run = async (summary: () => unknown) => {
    const client = {
      getJson: async (path: string) => {
        if (path.endsWith('/summary')) return summary();
        return { ok: true, entries: [], kills: [], rows: [], marks: [], query: { sort: 'perHour' } };
      }
    } as never;
    const results = await checkAll(client, config as never, okDiscord);
    return results.find((r) => r.name === 'live data (s1)');
  };

  test('reads ok and active when the summary carries a match clock', async () => {
    expect(await run(() => summaryWith(754))).toEqual({
      name: 'live data (s1)',
      ok: true,
      detail: 'live check active'
    });
  });

  test('reads ok but inactive when there is no match clock', async () => {
    const inactive = {
      name: 'live data (s1)',
      ok: true,
      detail: 'no match clock — live alerts inactive until the server reports one'
    };
    expect(await run(() => summaryWith(null))).toEqual(inactive);
    expect(await run(() => ({ ok: true, live: null }))).toEqual(inactive);
    expect(await run(() => summaryWith(undefined))).toEqual(inactive);
  });

  test('never fails the deploy, even when the summary itself did not answer', async () => {
    const check = await run(() => {
      throw new Error('summary 500');
    });
    expect(check).toMatchObject({ ok: true, detail: expect.stringContaining('skipped') });
  });
});

describe('lookup checks', () => {
  const answering = {
    getJson: async (path: string) =>
      path.includes('/players/')
        ? { ok: true, dossier: { names: [], summary: {} } }
        : { ok: true, entries: [], kills: [], rows: [], marks: [], live: null, query: { sort: 'perHour' } },
    getCsv: async () => EXPORT
  } as never;
  const find = (results: CheckResult[], name: string) => results.find((r) => r.name === name)!;

  test('the dossier and the org export answer; no Steam key is fine', async () => {
    const results = await checkAll(answering, config as never, okDiscord);
    expect(find(results, 'lookup dossier').ok).toBe(true);
    expect(find(results, 'lookup 30-day board')).toMatchObject({ ok: true, detail: 'answered, 1 players' });
    expect(find(results, 'steam key')).toMatchObject({ ok: true });
    expect(find(results, 'steam key').detail).toContain('unset');
  });

  test('a rejected Steam key fails', async () => {
    const steamFetch = (async () => new Response('', { status: 403 })) as typeof fetch;
    const results = await checkAll(answering, { ...config, steamApiKey: 'bad' } as never, okDiscord, steamFetch);
    expect(find(results, 'steam key')).toMatchObject({ ok: false, detail: 'steam rejected STEAM_API_KEY' });
  });

  test('an export that is not CSV fails the board check', async () => {
    const client = {
      getJson: (answering as { getJson: unknown }).getJson,
      getCsv: async () => {
        throw new Error('blocked by Cloudflare Access (non-CSV response, content-type: text/html)');
      }
    } as never;
    expect(find(await checkAll(client, config as never, okDiscord), 'lookup 30-day board').ok).toBe(false);
  });
});
