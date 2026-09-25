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
    expect(s.cold).toBe(true);
  });

  test('round-trips through save and load', async () => {
    const path = join(dir, 'state.json');
    const s = emptyState();
    serverState(s, 's1').lastAuditId = 99;
    s.kdAlerted['765'] = 1234;
    await saveState(path, s);

    const back = await loadState(path);
    expect(back.servers.s1?.lastAuditId).toBe(99);
    expect(back.kdAlerted['765']).toBe(1234);
    expect(back.cold).toBe(false);
  });

  test('a corrupt file is moved aside and cold-starts', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{not json');
    const s = await loadState(path);
    expect(s.cold).toBe(true);
    expect(existsSync(`${path}.corrupt`)).toBe(true);
  });

  test('serverState creates a zeroed entry once and then reuses it', () => {
    const s = emptyState();
    const a = serverState(s, 's1');
    a.lastAuditId = 5;
    expect(serverState(s, 's1').lastAuditId).toBe(5);
    expect(serverState(s, 's2').lastAuditId).toBe(0);
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
