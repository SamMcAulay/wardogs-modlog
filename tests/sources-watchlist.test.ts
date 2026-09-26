import { describe, expect, test } from 'vitest';
import { pollWatchlist } from '../src/sources/watchlist.js';
import { emptyServerState } from '../src/state.js';
import type { MarksBody, SummaryBody } from '../src/warcon-types.js';
import type { WatchedJoinEvent } from '../src/events.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

const client = (summary: SummaryBody, marks: MarksBody) =>
  ({
    getJson: async (path: string) => (path.includes('/marks') ? marks : summary)
  }) as unknown as import('../src/warcon.js').WarconClient;

const summaryOf = (players: { steamId: string; name: string }[]): SummaryBody => ({
  ok: true,
  live: {
    serverId: 's1',
    ok: true,
    status: { serverName: 'EU 1' },
    players: players.map((p) => ({ ...p, faction: 'Valkyra' }))
  }
});

const marksOf = (watched: string[]): MarksBody => ({
  ok: true,
  marks: watched.map((steamId) => ({ steamId, watched: true, reason: '', firstVisit: false }))
});

describe('pollWatchlist', () => {
  test('reports a watched player who was absent last cycle', async () => {
    const s = emptyServerState();
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765'])),
      's1',
      s,
      NOW
    );
    expect((events[0] as WatchedJoinEvent).name).toBe('Alpha');
  });

  test('does not report a watched player who was already present', async () => {
    const s = emptyServerState();
    s.presentSteamIds = ['765'];
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765'])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(0);
  });

  test('re-reports after the player left and came back', async () => {
    const s = emptyServerState();
    s.presentSteamIds = ['765'];
    await pollWatchlist(client(summaryOf([]), marksOf([])), 's1', s, NOW);
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765'])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(1);
  });

  test('ignores an unwatched player', async () => {
    const s = emptyServerState();
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf([])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(0);
  });

  test('always records the current roster, watched or not', async () => {
    const s = emptyServerState();
    await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf([])),
      's1',
      s,
      NOW
    );
    expect(s.presentSteamIds).toEqual(['765']);
  });

  test('an offline server empties the roster and reports nothing', async () => {
    const s = emptyServerState();
    s.presentSteamIds = ['765'];
    const events = await pollWatchlist(
      client({ ok: true, live: null }, marksOf([])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(0);
    expect(s.presentSteamIds).toEqual([]);
  });

  test('skips the marks call entirely when nobody is on', async () => {
    const s = emptyServerState();
    let calls = 0;
    const counting = {
      getJson: async (path: string) => {
        calls++;
        return path.includes('/marks') ? marksOf([]) : summaryOf([]);
      }
    } as unknown as import('../src/warcon.js').WarconClient;
    await pollWatchlist(counting, 's1', s, NOW);
    expect(calls).toBe(1);
  });

  test('a failed marks call leaves the roster unchanged, so the next cycle still reports the join', async () => {
    const s = emptyServerState();
    const failing = {
      getJson: async (path: string) => {
        if (path.includes('/marks')) throw new Error('marks 503');
        return summaryOf([{ steamId: '765', name: 'Alpha' }]);
      }
    } as unknown as import('../src/warcon.js').WarconClient;

    await expect(pollWatchlist(failing, 's1', s, NOW)).rejects.toThrow('marks 503');
    expect(s.presentSteamIds).toEqual([]); // the arrival is not recorded as present

    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765'])),
      's1',
      s,
      NOW
    );
    expect(events.map((e) => (e as WatchedJoinEvent).steamId)).toEqual(['765']);
    expect(s.presentSteamIds).toEqual(['765']);
  });

  test('a marks response for a player who left mid-cycle is ignored', async () => {
    const s = emptyServerState();
    // '999' was in the roster when marks was asked but is no longer on the server:
    // marks answers for ids we did not ask about in this batch, which must not alert.
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765', '999'])),
      's1',
      s,
      NOW
    );
    expect(events.map((e) => (e as WatchedJoinEvent).steamId)).toEqual(['765']);
    expect(s.presentSteamIds).toEqual(['765']);
  });
});
