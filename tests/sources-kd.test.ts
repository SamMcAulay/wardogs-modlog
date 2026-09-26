import { describe, expect, test } from 'vitest';
import { pollKd, type KdPollConfig } from '../src/sources/kd.js';
import type { BoardBody, BoardRow } from '../src/warcon-types.js';
import type { HighKdEvent } from '../src/events.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const cfg: KdPollConfig = { threshold: 4, minMatches: 5, minMinutes: 60, range: '30d' };

const row = (over: Partial<BoardRow> = {}): BoardRow => ({
  steamId: '765',
  name: 'Alpha',
  minutes: 400,
  kills: 52,
  deaths: 10,
  matches: 9,
  ...over
});

const client = (rows: BoardRow[], seen?: (path: string) => void) =>
  ({
    getJson: async (path: string) => {
      seen?.(path);
      return { ok: true, rows } satisfies BoardBody;
    }
  }) as unknown as import('../src/warcon.js').WarconClient;

describe('pollKd', () => {
  test('flags a player over both thresholds', async () => {
    const events = await pollKd(client([row()]), 's1', cfg, NOW);
    expect(events).toHaveLength(1);
    expect((events[0] as HighKdEvent).kd).toBeCloseTo(5.2);
  });

  test('ignores a high K/D with too few matches', async () => {
    expect(await pollKd(client([row({ matches: 4 })]), 's1', cfg, NOW)).toHaveLength(0);
  });

  test('ignores an ordinary K/D over many matches', async () => {
    expect(
      await pollKd(client([row({ kills: 10, deaths: 10 })]), 's1', cfg, NOW)
    ).toHaveLength(0);
  });

  test('zero deaths is not an infinite K/D', async () => {
    expect(
      await pollKd(client([row({ kills: 3, deaths: 0 })]), 's1', cfg, NOW)
    ).toHaveLength(0);
  });

  test('a player with no kills and no deaths is not flagged', async () => {
    expect(
      await pollKd(client([row({ kills: 0, deaths: 0 })]), 's1', cfg, NOW)
    ).toHaveLength(0);
  });

  test('sends the configured floors to the panel', async () => {
    let path = '';
    await pollKd(client([], (p) => (path = p)), 's1', cfg, NOW);
    expect(path).toContain('minMinutes=60');
    expect(path).toContain('range=30d');
    expect(path).toContain('sort=kd');
    expect(path).toContain('scope=server');
  });
});
