import { describe, expect, test } from 'vitest';
import { pollKills } from '../src/sources/kills.js';
import { emptyServerState } from '../src/state.js';
import type { KillsBody, KillView } from '../src/warcon-types.js';
import type { TeamKillEvent } from '../src/events.js';

const kill = (eventId: string, eventTime: number, ts: string): KillView => ({
  eventId,
  ts,
  map: 'Kavkazi',
  eventTime,
  killer: { steamId: '765', name: 'Alpha', faction: 'Valkyra' },
  victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
  cause: 'Id.Item.AK74M',
  distanceM: 40,
  headshot: false,
  suicide: false,
  teamKill: true,
  tags: []
});

const client = (body: KillsBody) =>
  ({ getJson: async () => body }) as unknown as import('../src/warcon.js').WarconClient;

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const opts = { feedQuietMinutes: 30, now: NOW };

/** A server that has completed a clean cycle, so it may report (spec §7). */
const warmServerState = () => ({ ...emptyServerState(), warm: true });

const body = (kills: KillView[], extra: Partial<KillsBody> = {}): KillsBody => ({
  ok: true,
  configured: true,
  feedAt: '2026-09-24T11:59:00.000Z',
  kills,
  total: null,
  ...extra
});

describe('pollKills', () => {
  test('emits newest-first API order as chronological events', async () => {
    const s = emptyServerState();
    // The API returns newest first.
    const events = await pollKills(
      client(body([kill('c', 30, 't3'), kill('b', 20, 't2'), kill('a', 10, 't1')])),
      's1',
      s,
      opts
    );
    expect(events.filter((e) => e.kind === 'teamKill').map((e) => (e as TeamKillEvent).eventId))
      .toEqual(['a', 'b', 'c']);
  });

  test('stops at the first already-seen id', async () => {
    const s = emptyServerState();
    s.seenKillIds = ['b'];
    const events = await pollKills(
      client(body([kill('c', 30, 't3'), kill('b', 20, 't2'), kill('a', 10, 't1')])),
      's1',
      s,
      opts
    );
    const ids = events
      .filter((e) => e.kind === 'teamKill')
      .map((e) => (e as TeamKillEvent).eventId);
    expect(ids).toEqual(['c']);
  });

  test('a batch sharing one receipt timestamp is not collapsed', async () => {
    const s = emptyServerState();
    const same = '2026-09-24T11:58:00.000Z';
    const events = await pollKills(
      client(body([kill('c', 30, same), kill('b', 20, same), kill('a', 10, same)])),
      's1',
      s,
      opts
    );
    expect(events.filter((e) => e.kind === 'teamKill')).toHaveLength(3);
  });

  test('records every returned id so the next cycle skips them', async () => {
    const s = emptyServerState();
    await pollKills(client(body([kill('b', 20, 't2'), kill('a', 10, 't1')])), 's1', s, opts);
    expect(s.seenKillIds).toContain('a');
    expect(s.seenKillIds).toContain('b');
  });

  test('a kill with no killer is skipped: the environment cannot team kill', async () => {
    const s = emptyServerState();
    const orphan = { ...kill('a', 10, 't1'), killer: null };
    const events = await pollKills(client(body([orphan])), 's1', s, opts);
    expect(events.filter((e) => e.kind === 'teamKill')).toHaveLength(0);
  });

  test('warns once when a configured feed has gone quiet', async () => {
    const s = warmServerState();
    s.presentSteamIds = ['765'];
    s.lastFeedAt = '2026-09-24T11:00:00.000Z'; // 60 minutes ago
    const stale = body([], { feedAt: '2026-09-24T11:00:00.000Z' });

    const first = await pollKills(client(stale), 's1', s, opts);
    expect(first.filter((e) => e.kind === 'feedQuiet')).toHaveLength(1);

    const second = await pollKills(client(stale), 's1', s, opts);
    expect(second.filter((e) => e.kind === 'feedQuiet')).toHaveLength(0);
  });

  test('the quiet warning resets once the feed advances', async () => {
    const s = emptyServerState();
    s.presentSteamIds = ['765'];
    s.lastFeedAt = '2026-09-24T11:00:00.000Z';
    s.feedQuietWarned = true;
    await pollKills(client(body([], { feedAt: '2026-09-24T11:59:30.000Z' })), 's1', s, opts);
    expect(s.feedQuietWarned).toBe(false);
  });

  test('an unconfigured feed never warns', async () => {
    const s = emptyServerState();
    s.lastFeedAt = '2026-09-24T10:00:00.000Z';
    const events = await pollKills(
      client(body([], { configured: false, feedAt: null })),
      's1',
      s,
      opts
    );
    expect(events).toHaveLength(0);
  });

  test('an empty server with a long-stale feed does not warn', async () => {
    const s = emptyServerState();
    s.lastFeedAt = '2026-09-24T10:00:00.000Z'; // 120 minutes ago
    const stale = body([], { feedAt: '2026-09-24T10:00:00.000Z' });

    const events = await pollKills(client(stale), 's1', s, opts);
    expect(events.filter((e) => e.kind === 'feedQuiet')).toHaveLength(0);
    expect(s.lastEmptyAt).toBe(new Date(NOW).toISOString());
  });

  test('a server that was recently empty does not warn yet', async () => {
    const s = warmServerState();
    s.lastFeedAt = '2026-09-24T10:00:00.000Z'; // 120 minutes ago
    s.lastEmptyAt = new Date(NOW - 5 * 60_000).toISOString(); // 5 minutes ago
    s.presentSteamIds = ['765']; // now has players
    const stale = body([], { feedAt: '2026-09-24T10:00:00.000Z' });

    const events = await pollKills(client(stale), 's1', s, opts);
    expect(events.filter((e) => e.kind === 'feedQuiet')).toHaveLength(0);
  });

  test('a server empty for longer than FEED_QUIET_MINUTES does warn', async () => {
    const s = warmServerState();
    s.lastFeedAt = '2026-09-24T10:00:00.000Z'; // 120 minutes ago
    s.lastEmptyAt = new Date(NOW - 31 * 60_000).toISOString(); // 31 minutes ago
    s.presentSteamIds = ['765']; // now has players
    const stale = body([], { feedAt: '2026-09-24T10:00:00.000Z' });

    const events = await pollKills(client(stale), 's1', s, opts);
    expect(events.filter((e) => e.kind === 'feedQuiet')).toHaveLength(1);
  });

  test('a server that is not yet warm neither warns nor marks the warning outstanding', async () => {
    const s = emptyServerState(); // warm === false: its cycle posts nothing
    s.presentSteamIds = ['765'];
    s.lastFeedAt = '2026-09-24T11:00:00.000Z'; // 60 minutes ago
    const stale = body([], { feedAt: '2026-09-24T11:00:00.000Z' });

    const cold = await pollKills(client(stale), 's1', s, opts);
    expect(cold.filter((e) => e.kind === 'feedQuiet')).toHaveLength(0);
    expect(s.feedQuietWarned).toBe(false); // a warning nobody saw must not be "outstanding"

    // Once warm, the same quiet feed is reported.
    s.warm = true;
    const warm = await pollKills(client(stale), 's1', s, opts);
    expect(warm.filter((e) => e.kind === 'feedQuiet')).toHaveLength(1);
  });
});
