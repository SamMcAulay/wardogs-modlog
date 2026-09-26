import { describe, expect, test } from 'vitest';
import { checkAll } from '../src/preflight.js';
import { WarconAuthError } from '../src/warcon.js';

const config = {
  serverIds: ['s1'],
  discordToken: 'dtok',
  discordChannelId: '111',
  discordModRoleId: '222',
  kdRange: '30d',
  kdMinMinutes: 60,
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

describe('checkAll', () => {
  test('passes when every endpoint answers', async () => {
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
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
