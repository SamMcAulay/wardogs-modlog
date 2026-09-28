import { describe, expect, test } from 'vitest';
import {
  DEFAULT_KICK_REASON,
  actionModal,
  actionRow,
  doneRows,
  hasRole,
  kick,
  kickLogLine,
  parseActionId,
  playerNameFromTitle,
  storedWatchReason,
  watch,
  watchLogLine,
  type ActionRow,
  type ButtonComponent
} from '../src/player-actions.js';
import type { PostResult, WarconClient } from '../src/warcon.js';

const SERVER = '0eec42dc-f73f-4e43-a62e-7e0900fcf38c';
const STEAM = '76561198000000001';

describe('the buttons', () => {
  test('Kick and Watch sit side by side, each carrying the server and the player', () => {
    const [kickButton, watchButton] = actionRow(SERVER, STEAM, { watch: true }).components;
    expect(kickButton).toMatchObject({ type: 2, style: 4, label: 'Kick' });
    expect(watchButton).toMatchObject({ type: 2, style: 1, label: 'Watch' });
    for (const b of [kickButton!, watchButton!]) expect(b.custom_id.length).toBeLessThanOrEqual(100);
    expect(parseActionId(kickButton!.custom_id)).toEqual({ action: 'kick', step: 'button', serverId: SERVER, steamId: STEAM });
    expect(parseActionId(watchButton!.custom_id)).toEqual({ action: 'watch', step: 'button', serverId: SERVER, steamId: STEAM });
  });

  test('a player already watched gets Kick only', () => {
    expect(actionRow(SERVER, STEAM, { watch: false }).components.map((b) => b.label)).toEqual(['Kick']);
  });

  test('each confirmation carries the same server and player back', () => {
    for (const action of ['kick', 'watch'] as const) {
      const modal = actionModal(action, SERVER, STEAM, 'Alpha');
      expect(modal.custom_id.length).toBeLessThanOrEqual(100);
      expect(parseActionId(modal.custom_id)).toEqual({ action, step: 'confirm', serverId: SERVER, steamId: STEAM });
    }
  });

  test('ids that are not ours, or are malformed, parse to null', () => {
    expect(parseActionId('something-else')).toBeNull();
    expect(parseActionId(`kick:${SERVER}:not-a-steam-id`)).toBeNull();
    expect(parseActionId(`watch:${SERVER}`)).toBeNull();
    expect(parseActionId(`ban:${SERVER}:${STEAM}`)).toBeNull();
  });
});

describe('the confirmations', () => {
  test('kick: names the player, reason optional and shown to them', () => {
    const modal = actionModal('kick', SERVER, STEAM, 'Alpha');
    expect(modal.title).toBe('Kick Alpha?');
    expect(modal.components[0]!.components[0]).toMatchObject({ type: 4, custom_id: 'reason', required: false, max_length: 200 });
  });

  test('watch: names the player, reason kept for staff', () => {
    const modal = actionModal('watch', SERVER, STEAM, 'Alpha');
    expect(modal.title).toBe('Watch Alpha?');
    const input = modal.components[0]!.components[0]!;
    expect(input).toMatchObject({ type: 4, custom_id: 'reason', required: false });
    expect(input.label).toMatch(/staff/i);
  });

  test('a long name keeps the title inside Discord’s 45-character limit', () => {
    expect(actionModal('watch', SERVER, STEAM, 'x'.repeat(80)).title.length).toBeLessThanOrEqual(45);
  });
});

describe('after an action', () => {
  const rows = (): ActionRow<ButtonComponent>[] => [actionRow(SERVER, STEAM, { watch: true })];

  test('only the pressed button becomes a disabled label naming the mod', () => {
    const after = doneRows(rows(), `watch:${SERVER}:${STEAM}`, 'Watched by ModMan');
    const [k, w] = after[0]!.components;
    expect(k!.label).toBe('Kick');
    expect(k!.disabled).toBeUndefined();
    expect(w).toMatchObject({ label: 'Watched by ModMan', disabled: true, style: 2 });
  });

  test('the other button still works afterwards', () => {
    const afterWatch = doneRows(rows(), `watch:${SERVER}:${STEAM}`, 'Watched by ModMan');
    const afterBoth = doneRows(afterWatch, `kick:${SERVER}:${STEAM}`, 'Kicked by ModMan');
    expect(afterBoth[0]!.components.map((b) => [b.label, b.disabled])).toEqual([
      ['Kicked by ModMan', true],
      ['Watched by ModMan', true]
    ]);
  });

  test('the channel lines say who did what, where and why', () => {
    expect(kickLogLine('ModMan', 'Alpha', 'NA#3', '')).toBe('🔨 **ModMan** kicked **Alpha** from **NA#3**');
    expect(kickLogLine('ModMan', 'Alpha', 'NA#3', 'team killing')).toBe(
      '🔨 **ModMan** kicked **Alpha** from **NA#3** — team killing'
    );
    expect(watchLogLine('ModMan', 'Alpha', 'NA#3', 'aimbot suspicion')).toBe(
      '👁️ **ModMan** added **Alpha** to the watchlist (seen on **NA#3**) — aimbot suspicion'
    );
    expect(watchLogLine('ModMan', 'Alpha', 'NA#3', '')).toBe(
      '👁️ **ModMan** added **Alpha** to the watchlist (seen on **NA#3**)'
    );
  });
});

describe('what the watchlist stores', () => {
  test('the typed reason plus who added it', () => {
    expect(storedWatchReason('aimbot suspicion', 'ModMan')).toBe('aimbot suspicion — added via Discord by ModMan');
  });

  test('no reason still records who added it', () => {
    expect(storedWatchReason('  ', 'ModMan')).toBe('Added via Discord by ModMan');
  });

  test('stays inside Warcon’s 300 characters, keeping the name', () => {
    const stored = storedWatchReason('y'.repeat(400), 'ModMan');
    expect(stored.length).toBeLessThanOrEqual(300);
    expect(stored.endsWith('— added via Discord by ModMan')).toBe(true);
  });
});

describe('reading the player from the alert', () => {
  test.each([
    ['NA#3 · Joined — Alpha', 'Alpha'],
    ['NA#3 · Hot right now — Alpha Bravo', 'Alpha Bravo'],
    ['NA#3 · Team kill — Alpha (3)', 'Alpha'],
    ['EU#1 · Joined — Name — With Dash', 'Name — With Dash']
  ])('%s → %s', (title, name) => {
    expect(playerNameFromTitle(title)).toBe(name);
  });

  test('a title without a name falls back to null', () => {
    expect(playerNameFromTitle('Kill feed has gone quiet')).toBeNull();
    expect(playerNameFromTitle(undefined)).toBeNull();
  });
});

describe('who may press them', () => {
  test('a member with the role, from the cached member or the raw one', () => {
    expect(hasRole(['1', '999'], '999')).toBe(true);
    expect(hasRole({ cache: new Map([['999', {}]]) }, '999')).toBe(true);
  });

  test('anyone else, or no member at all (a DM)', () => {
    expect(hasRole(['1'], '999')).toBe(false);
    expect(hasRole({ cache: new Map() }, '999')).toBe(false);
    expect(hasRole(undefined, '999')).toBe(false);
  });
});

/** A fake panel: marks answers per player, and every POST/PUT recorded. */
function panel(opts: { post?: PostResult; watchedReason?: string | null; marksFail?: boolean } = {}) {
  const writes: unknown[] = [];
  const client = {
    getJson: async (path: string) => {
      if (opts.marksFail) throw new Error('marks 503');
      const ids = new URL(path, 'http://x').searchParams.get('ids')!.split(',');
      return {
        ok: true,
        marks: ids.map((steamId) => ({
          steamId,
          watched: opts.watchedReason != null,
          reason: opts.watchedReason ?? '',
          firstVisit: false
        }))
      };
    },
    postAction: async (path: string, body: unknown, method = 'POST') => {
      writes.push([method, path, body]);
      return opts.post ?? { ok: true };
    }
  } as unknown as WarconClient;
  return { client, writes };
}

describe('kick()', () => {
  test('kicks through the panel with the typed reason, no mod name in it', async () => {
    const { client, writes } = panel();
    expect(await kick(client, SERVER, STEAM, '  team killing  ')).toEqual({ ok: true, message: 'Kicked.' });
    expect(writes).toEqual([['POST', `/api/servers/${SERVER}/rcon/kick`, { steamId: STEAM, reason: 'team killing' }]]);
  });

  test('an empty reason sends the generic one', async () => {
    const { client, writes } = panel();
    await kick(client, SERVER, STEAM, '   ');
    expect((writes[0] as [string, string, { reason: string }])[2].reason).toBe(DEFAULT_KICK_REASON);
  });

  test('a key without the kick permission says what to add', async () => {
    const { client } = panel({ post: { ok: false, status: 403, message: 'forbidden' } });
    expect((await kick(client, SERVER, STEAM, '')).message).toMatch(/Kick, kill, move/);
  });

  test("any other refusal passes Warcon's message on", async () => {
    const { client } = panel({ post: { ok: false, status: 404, message: 'Player is not on the server.' } });
    expect(await kick(client, SERVER, STEAM, '')).toEqual({ ok: false, message: 'Kick failed: Player is not on the server.' });
  });
});

describe('watch()', () => {
  test('adds the player with the reason and who added it', async () => {
    const { client, writes } = panel({ watchedReason: null });
    expect(await watch(client, SERVER, STEAM, 'Alpha', 'aimbot suspicion', 'ModMan')).toEqual({
      ok: true,
      message: 'Added to the watchlist.'
    });
    expect(writes).toEqual([
      [
        'PUT',
        `/api/servers/${SERVER}/players/${STEAM}/watch`,
        { watched: true, reason: 'aimbot suspicion — added via Discord by ModMan' }
      ]
    ]);
  });

  test('never overwrites an existing watch: it says why they are already watched and changes nothing', async () => {
    const { client, writes } = panel({ watchedReason: 'known cheater' });
    const r = await watch(client, SERVER, STEAM, 'Alpha', 'new reason', 'ModMan');
    expect(r).toEqual({ ok: false, message: 'Already on the watchlist: known cheater. Nothing changed.' });
    expect(writes).toEqual([]);
  });

  test('a failed watchlist check changes nothing either', async () => {
    const { client, writes } = panel({ marksFail: true });
    const r = await watch(client, SERVER, STEAM, 'Alpha', '', 'ModMan');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Couldn't check the watchlist/);
    expect(writes).toEqual([]);
  });

  test('a key without the watchlist permission says what to add', async () => {
    const { client } = panel({ watchedReason: null, post: { ok: false, status: 403, message: 'forbidden' } });
    expect((await watch(client, SERVER, STEAM, 'Alpha', '', 'ModMan')).message).toMatch(/Notes & watchlist/);
  });
});
