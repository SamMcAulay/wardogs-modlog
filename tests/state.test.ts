import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  emptyState,
  loadState,
  rememberKillIds,
  saveState,
  serverState,
  SEEN_KILL_CAP
} from '../src/state.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'modlog-'));
});

describe('state', () => {
  test('a missing file cold-starts rather than throwing', async () => {
    const s = await loadState(join(dir, 'nope.json'));
    expect(s.version).toBe(1);
    expect(s.servers).toEqual({});
    // No server entries: every watched server is created cold on first use.
    expect(serverState(s, 's1').warm).toBe(false);
  });

  test('round-trips through save and load', async () => {
    const path = join(dir, 'state.json');
    const s = emptyState();
    serverState(s, 's1').lastAuditId = 99;
    serverState(s, 's1').warm = true;
    serverState(s, 's2'); // seen, but never completed a clean cycle
    s.joinAlerted['765'] = 1234;
    await saveState(path, s);

    const back = await loadState(path);
    expect(back.servers.s1?.lastAuditId).toBe(99);
    expect(back.joinAlerted['765']).toBe(1234);
    // Warmth is per server and persisted: a restart keeps a cold server cold (spec §7).
    expect(back.servers.s1?.warm).toBe(true);
    expect(back.servers.s2?.warm).toBe(false);
  });

  test('a server entry from a file written before `warm` existed loads cold', async () => {
    const path = join(dir, 'state.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, servers: { s1: { lastAuditId: 4 } }, kdAlerted: {}, startedAt: 1 })
    );
    const back = await loadState(path);
    expect(back.servers.s1?.lastAuditId).toBe(4);
    expect(back.servers.s1?.warm).toBe(false);
  });

  test('a corrupt file is moved aside and cold-starts', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{not json');
    const s = await loadState(path);
    expect(s.servers).toEqual({}); // every server comes up cold
    expect(existsSync(`${path}.corrupt`)).toBe(true);
  });

  test('serverState creates a zeroed entry once and then reuses it', () => {
    const s = emptyState();
    const a = serverState(s, 's1');
    a.lastAuditId = 5;
    expect(serverState(s, 's1').lastAuditId).toBe(5);
    expect(serverState(s, 's2').lastAuditId).toBe(0);
    expect(serverState(s, 's2').warm).toBe(false); // a new server id starts cold
  });

  test('the kill-id ring keeps newest first and evicts the oldest', () => {
    const s = serverState(emptyState(), 's1');
    rememberKillIds(s, ['a', 'b']);
    rememberKillIds(s, ['c']);
    expect(s.seenKillIds.slice(0, 3)).toEqual(['c', 'a', 'b']);

    rememberKillIds(
      s,
      Array.from({ length: SEEN_KILL_CAP + 10 }, (_, i) => `x${i}`)
    );
    expect(s.seenKillIds.length).toBe(SEEN_KILL_CAP);
    expect(s.seenKillIds).not.toContain('b');
  });

  test('the ring never stores a duplicate id', () => {
    const s = serverState(emptyState(), 's1');
    rememberKillIds(s, ['a']);
    rememberKillIds(s, ['a']);
    expect(s.seenKillIds.filter((i) => i === 'a').length).toBe(1);
  });

  test('saving writes atomically, leaving no temp file behind', async () => {
    const path = join(dir, 'state.json');
    await saveState(path, emptyState());
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe('live-alert state', () => {
  test('a fresh state has no join stamps, and a fresh server entry has empty match and known lists', () => {
    const s = emptyState();
    expect(s.joinAlerted).toEqual({});
    const e = serverState(s, 's1');
    expect(e.match).toEqual({ lastSeenAt: null, map: null, baselines: {}, alerted: [] });
    expect(e.knownSweats).toEqual([]);
    expect(e.knownHighKd).toEqual([]);
    expect(e.knownAt).toBeNull();
  });

  test('an old file with kdAlerted, rateAlerted and baselines loads with them dropped and the new fields defaulted', async () => {
    const path = join(dir, 'state.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        servers: { s1: { lastAuditId: 4, presentSteamIds: ['765'], warm: true } },
        kdAlerted: { '765': 1 },
        rateAlerted: { 'sweat:765': 2 },
        baselines: { 's1:765': { perHour: 1, minutes: 1, at: 1 } },
        startedAt: 1
      }),
      'utf8'
    );
    const s = await loadState(path);
    expect(s).not.toHaveProperty('kdAlerted');
    expect(s).not.toHaveProperty('rateAlerted');
    expect(s).not.toHaveProperty('baselines');
    expect(s.joinAlerted).toEqual({});
    const e = s.servers.s1!;
    expect(e.match).toEqual({ lastSeenAt: null, map: null, baselines: {}, alerted: [] });
    expect(e.knownSweats).toEqual([]);
    expect(e.knownHighKd).toEqual([]);
    expect(e.knownAt).toBeNull();
    // Warm servers stay warm, with their roster, so nobody already on is reported joining.
    expect(e.warm).toBe(true);
    expect(e.presentSteamIds).toEqual(['765']);
  });

  test('a match saved by the retired clock-based check loads empty', async () => {
    const path = join(dir, 'state.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        servers: { s1: { warm: true, match: { lastMatchSeconds: 600, firstSeen: { '765': 0 }, alerted: ['765'] } } },
        startedAt: 1
      }),
      'utf8'
    );
    const s = await loadState(path);
    expect(s.servers.s1!.match).toEqual({ lastSeenAt: null, map: null, baselines: {}, alerted: [] });
  });

  test('join stamps, match state and known lists survive a save and load', async () => {
    const path = join(dir, 'state.json');
    const s = emptyState();
    s.joinAlerted['765'] = 42;
    const e = serverState(s, 's1');
    e.match = { lastSeenAt: 600, map: 'Town', baselines: { '765': { at: 0, kills: 2, last: 9 } }, alerted: ['765'] };
    e.knownSweats = ['765'];
    e.knownHighKd = ['766'];
    e.knownAt = 7;
    await saveState(path, s);
    const back = await loadState(path);
    expect(back.joinAlerted).toEqual({ '765': 42 });
    expect(back.servers.s1!.match).toEqual(e.match);
    expect(back.servers.s1!.knownSweats).toEqual(['765']);
    expect(back.servers.s1!.knownHighKd).toEqual(['766']);
    expect(back.servers.s1!.knownAt).toBe(7);
  });
});
