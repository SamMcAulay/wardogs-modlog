import { describe, expect, test } from 'vitest';
import { escalate, PING_KINDS, type EscalateConfig } from '../src/escalate.js';
import { emptyState, serverState } from '../src/state.js';
import type { ModEvent, TeamKillEvent } from '../src/events.js';

const cfg: EscalateConfig = { teamKillPingAt: 3, kdCooldownDays: 7, pingOn: new Set(PING_KINDS) };
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

const tk = (eventId: string, eventTime: number, killer = '765'): TeamKillEvent => ({
  kind: 'teamKill',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  eventId,
  eventTime,
  killer: { steamId: killer, name: 'Alpha', faction: 'Valkyra' },
  victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
  cause: 'Id.Item.AK74M',
  distanceM: 40,
  count: 0
});

describe('team kill escalation', () => {
  test('the first two do not ping and the third does', () => {
    const state = emptyState();
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30)], state, cfg, NOW);
    expect(out.map((d) => d.ping)).toEqual([false, false, true]);
  });

  test('the running count is stamped onto the event', () => {
    const state = emptyState();
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30)], state, cfg, NOW);
    expect(out.map((d) => (d.event as TeamKillEvent).count)).toEqual([1, 2, 3]);
  });

  test('every kill past the threshold also pings', () => {
    const state = emptyState();
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30), tk('d', 40)], state, cfg, NOW);
    expect(out[3]!.ping).toBe(true);
  });

  test('counts are kept per killer, not per server', () => {
    const state = emptyState();
    const out = escalate(
      [tk('a', 10, 'X'), tk('b', 20, 'Y'), tk('c', 30, 'X')],
      state,
      cfg,
      NOW
    );
    expect(out.every((d) => d.ping === false)).toBe(true);
  });

  test('the count survives across cycles via state', () => {
    const state = emptyState();
    escalate([tk('a', 10), tk('b', 20)], state, cfg, NOW);
    const out = escalate([tk('c', 30)], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
  });

  test('a match boundary resets the count', () => {
    const state = emptyState();
    escalate([tk('a', 300), tk('b', 310)], state, cfg, NOW);
    // eventTime going backwards means the match clock reset.
    const out = escalate([tk('c', 5)], state, cfg, NOW);
    expect(out[0]!.ping).toBe(false);
    expect((out[0]!.event as TeamKillEvent).count).toBe(1);
  });
});

describe('high K/D escalation', () => {
  const kd = (steamId = '765'): ModEvent => ({
    kind: 'highKd',
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    steamId,
    name: 'Alpha',
    kd: 5.2,
    kills: 52,
    deaths: 10,
    matches: 9,
    minutes: 400
  });

  test('a first flag pings and records the time', () => {
    const state = emptyState();
    const out = escalate([kd()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
    expect(state.kdAlerted['765']).toBe(NOW);
  });

  test('a re-flag inside the cooldown is dropped entirely', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 2 * 86_400_000;
    expect(escalate([kd()], state, cfg, NOW)).toHaveLength(0);
  });

  test('a re-flag after the cooldown pings again', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 8 * 86_400_000;
    const out = escalate([kd()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
    expect(state.kdAlerted['765']).toBe(NOW);
  });
});

describe('other kinds', () => {
  test('a watched join pings', () => {
    const out = escalate(
      [
        {
          kind: 'watchedJoin',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          steamId: '765',
          name: 'Alpha'
        }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out[0]!.ping).toBe(true);
  });

  test('admin actions are a record and never ping', () => {
    const out = escalate(
      [
        {
          kind: 'adminAction',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          auditId: 1,
          action: 'rcon.ban',
          actorName: 'mod',
          target: '765',
          reason: 'griefing'
        }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out[0]!.ping).toBe(false);
  });

  test('a quiet feed is a warning, not an alarm', () => {
    const out = escalate(
      [
        {
          kind: 'feedQuiet',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          lastFeedAt: null
        }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out[0]!.ping).toBe(false);
  });
});

describe('ping toggle', () => {
  const watched: ModEvent = {
    kind: 'watchedJoin',
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    steamId: '900',
    name: 'Watched'
  };
  const highKd: ModEvent = {
    kind: 'highKd',
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    steamId: '901',
    name: 'Sharp',
    kd: 6,
    kills: 60,
    deaths: 10,
    matches: 8,
    minutes: 300
  };

  test('with pings off every alert still posts, just without a ping', () => {
    const state = emptyState();
    const off: EscalateConfig = { ...cfg, pingOn: new Set() };
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30), watched, highKd], state, off, NOW);
    expect(out).toHaveLength(5);
    expect(out.every((d) => d.ping === false)).toBe(true);
  });

  test('with pings off the counts and cooldowns still advance', () => {
    const state = emptyState();
    const off: EscalateConfig = { ...cfg, pingOn: new Set() };
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30), highKd], state, off, NOW);
    expect((out[2]!.event as TeamKillEvent).count).toBe(3);
    expect(state.kdAlerted['901']).toBe(NOW);
  });

  test('only the listed kinds ping', () => {
    const state = emptyState();
    const some: EscalateConfig = { ...cfg, pingOn: new Set(['watchedJoin'] as const) };
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30), watched, highKd], state, some, NOW);
    expect(out.map((d) => d.ping)).toEqual([false, false, false, true, false]);
  });
});
