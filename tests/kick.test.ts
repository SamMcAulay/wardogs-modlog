import { describe, expect, test } from 'vitest';
import {
  DEFAULT_KICK_REASON,
  hasRole,
  kick,
  kickLogLine,
  kickModal,
  kickRow,
  kickedRow,
  parseKickId,
  playerNameFromTitle
} from '../src/kick.js';
import type { PostResult, WarconClient } from '../src/warcon.js';

const SERVER = '0eec42dc-f73f-4e43-a62e-7e0900fcf38c';
const STEAM = '76561198000000001';

describe('kick button ids', () => {
  test('the button carries the server and the player, and parses back', () => {
    const row = kickRow(SERVER, STEAM);
    const button = row.components[0]!;
    expect(button).toMatchObject({ type: 2, style: 4, label: 'Kick' });
    expect(button.custom_id.length).toBeLessThanOrEqual(100);
    expect(parseKickId(button.custom_id)).toEqual({ step: 'button', serverId: SERVER, steamId: STEAM });
  });

  test('the confirmation carries the same server and player', () => {
    const modal = kickModal(SERVER, STEAM, 'Alpha');
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    expect(parseKickId(modal.custom_id)).toEqual({ step: 'confirm', serverId: SERVER, steamId: STEAM });
  });

  test('ids that are not ours, or are malformed, parse to null', () => {
    expect(parseKickId('something-else')).toBeNull();
    expect(parseKickId(`kick:${SERVER}:not-a-steam-id`)).toBeNull();
    expect(parseKickId(`kick:${SERVER}`)).toBeNull();
  });
});

describe('the confirmation', () => {
  test('names the player and offers an optional reason', () => {
    const modal = kickModal(SERVER, STEAM, 'Alpha');
    expect(modal.title).toBe('Kick Alpha?');
    const input = modal.components[0]!.components[0]!;
    expect(input).toMatchObject({ type: 4, custom_id: 'reason', required: false, max_length: 200 });
  });

  test('a long name keeps the title inside Discord’s 45-character limit', () => {
    expect(kickModal(SERVER, STEAM, 'x'.repeat(80)).title.length).toBeLessThanOrEqual(45);
  });
});

describe('after a kick', () => {
  test('the button becomes a disabled label naming the mod', () => {
    const button = kickedRow('ModMan').components[0]!;
    expect(button).toMatchObject({ type: 2, style: 2, label: 'Kicked by ModMan', disabled: true });
  });

  test('the channel line names the mod, the player, the server and any reason', () => {
    expect(kickLogLine('ModMan', 'Alpha', 'NA#3', '')).toBe('🔨 **ModMan** kicked **Alpha** from **NA#3**');
    expect(kickLogLine('ModMan', 'Alpha', 'NA#3', 'team killing')).toBe(
      '🔨 **ModMan** kicked **Alpha** from **NA#3** — team killing'
    );
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

describe('who may kick', () => {
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

describe('kick()', () => {
  const client = (result: PostResult, seen: unknown[] = []) =>
    ({
      postAction: async (path: string, body: unknown) => {
        seen.push([path, body]);
        return result;
      }
    }) as unknown as WarconClient;

  test('kicks through the panel with the typed reason, no mod name in it', async () => {
    const seen: unknown[] = [];
    const r = await kick(client({ ok: true }, seen), SERVER, STEAM, '  team killing  ');
    expect(r).toEqual({ ok: true, message: 'Kicked.' });
    expect(seen).toEqual([[`/api/servers/${SERVER}/rcon/kick`, { steamId: STEAM, reason: 'team killing' }]]);
  });

  test('an empty reason sends the generic one', async () => {
    const seen: unknown[] = [];
    await kick(client({ ok: true }, seen), SERVER, STEAM, '   ');
    expect((seen[0] as [string, { reason: string }])[1].reason).toBe(DEFAULT_KICK_REASON);
  });

  test('a key without the kick permission says what to add', async () => {
    const r = await kick(client({ ok: false, status: 403, message: 'forbidden' }), SERVER, STEAM, '');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Kick, kill, move/);
  });

  test("any other refusal passes Warcon's message on", async () => {
    const r = await kick(
      client({ ok: false, status: 404, message: 'Player is not on the server.' }),
      SERVER,
      STEAM,
      ''
    );
    expect(r).toEqual({ ok: false, message: 'Kick failed: Player is not on the server.' });
  });
});
