import { describe, expect, test } from 'vitest';
import { escalate, PING_KINDS, type EscalateConfig } from '../src/escalate.js';
import { emptyState } from '../src/state.js';
import type { HotPlayerEvent, PlayerJoinedEvent, TeamKillEvent } from '../src/events.js';

const cfg: EscalateConfig = { joinAlertHours: 24, pingOn: new Set(PING_KINDS), teamKillMinCount: 1 };
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const HOUR = 3_600_000;

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

const join = (over: Partial<PlayerJoinedEvent> = {}): PlayerJoinedEvent => ({
  kind: 'playerJoined',
  serverId: 's1',
  at: '2026-09-27T12:00:00.000Z',
  steamId: '765',
  name: 'Alpha',
  watched: false,
  sweat: false,
  highKd: false,
  ...over
});

const hot = (over: Partial<HotPlayerEvent> = {}): HotPlayerEvent => ({
  kind: 'hotPlayer',
  serverId: 's1',
  at: '2026-09-27T12:00:00.000Z',
  steamId: '765',
  name: 'Alpha',
  kills: 12,
  deaths: 3,
  measuredKills: 10,
  minutes: 30,
  perHour: 24,
  history: { kind: 'unavailable' },
  ...over
});

describe('team kills', () => {
  test('never ping, however many there are', () => {
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30), tk('d', 40)], emptyState(), cfg, NOW);
    expect(out.every((d) => d.ping === false)).toBe(true);
  });

  test('the running count is stamped onto the event', () => {
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30)], emptyState(), cfg, NOW);
    expect(out.map((d) => (d.event as TeamKillEvent).count)).toEqual([1, 2, 3]);
  });

  test('counts are kept per killer', () => {
    const out = escalate([tk('a', 10, 'X'), tk('b', 20, 'Y'), tk('c', 30, 'X')], emptyState(), cfg, NOW);
    expect(out.map((d) => (d.event as TeamKillEvent).count)).toEqual([1, 1, 2]);
  });

  test('the count survives across cycles via state', () => {
    const state = emptyState();
    escalate([tk('a', 10), tk('b', 20)], state, cfg, NOW);
    const out = escalate([tk('c', 30)], state, cfg, NOW);
    expect((out[0]!.event as TeamKillEvent).count).toBe(3);
  });

  test('a match boundary resets the count', () => {
    const state = emptyState();
    escalate([tk('a', 300), tk('b', 310)], state, cfg, NOW);
    const out = escalate([tk('c', 5)], state, cfg, NOW);
    expect((out[0]!.event as TeamKillEvent).count).toBe(1);
  });
});

describe('team kill threshold', () => {
  const two: EscalateConfig = { ...cfg, teamKillMinCount: 2 };
  const counts = (out: ReturnType<typeof escalate>) => out.map((d) => (d.event as TeamKillEvent).count);

  test('a team kill below the threshold is counted but not posted', () => {
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30)], emptyState(), two, NOW);
    expect(counts(out)).toEqual([2, 3]);
  });

  test('each killer must reach the threshold on their own', () => {
    const out = escalate([tk('a', 10, 'X'), tk('b', 20, 'Y'), tk('c', 30, 'X')], emptyState(), two, NOW);
    expect(out.map((d) => (d.event as TeamKillEvent).eventId)).toEqual(['c']);
  });

  test('a held-back first kill still counts towards the next cycle', () => {
    const state = emptyState();
    expect(escalate([tk('a', 10)], state, two, NOW)).toEqual([]);
    expect(counts(escalate([tk('b', 20)], state, two, NOW))).toEqual([2]);
  });

  test('a match boundary resets the count, so the threshold applies again', () => {
    const state = emptyState();
    escalate([tk('a', 300), tk('b', 310)], state, two, NOW);
    expect(escalate([tk('c', 5)], state, two, NOW)).toEqual([]);
  });
});

describe('join alerts', () => {
  test('a watched-only join posts without a ping and stamps nothing', () => {
    const state = emptyState();
    const out = escalate([join({ watched: true })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(false);
    expect(state.joinAlerted).toEqual({});
  });

  test('a known join posts without a ping and stamps joinAlerted', () => {
    const state = emptyState();
    const out = escalate([join({ sweat: true, highKd: true })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(false);
    expect(state.joinAlerted['765']).toBe(NOW);
  });

  test('known tags are dropped within JOIN_ALERT_HOURS; the watched tag never is', () => {
    const state = emptyState();
    state.joinAlerted['765'] = NOW - 23 * HOUR;
    const out = escalate([join({ watched: true, sweat: true, highKd: true })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toMatchObject({ watched: true, sweat: false, highKd: false });
    expect(state.joinAlerted['765']).toBe(NOW - 23 * HOUR); // not re-stamped
  });

  test('nothing posts when no tag is left', () => {
    const state = emptyState();
    state.joinAlerted['765'] = NOW - HOUR;
    expect(escalate([join({ sweat: true })], state, cfg, NOW)).toEqual([]);
  });

  test('known tags post again once JOIN_ALERT_HOURS has passed', () => {
    const state = emptyState();
    state.joinAlerted['765'] = NOW - 24 * HOUR;
    const out = escalate([join({ highKd: true })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    expect(state.joinAlerted['765']).toBe(NOW);
  });

  test('the limit is global: a known tag posted on one server is quiet on another', () => {
    const state = emptyState();
    escalate([join({ sweat: true })], state, cfg, NOW);
    expect(escalate([join({ serverId: 's2', sweat: true })], state, cfg, NOW + HOUR)).toEqual([]);
  });

  test('the Steam veteran tag is a known tag: it stamps, and is dropped within JOIN_ALERT_HOURS', () => {
    const state = emptyState();
    expect(escalate([join({ steamVeteran: true })], state, cfg, NOW)).toHaveLength(1);
    expect(state.joinAlerted['765']).toBe(NOW);
    expect(escalate([join({ steamVeteran: true })], state, cfg, NOW + HOUR)).toEqual([]);
    const watched = escalate([join({ watched: true, steamVeteran: true })], state, cfg, NOW + HOUR);
    expect(watched[0]!.event).toMatchObject({ watched: true, steamVeteran: false });
  });

  test('a join with no tag at all posts nothing', () => {
    expect(escalate([join()], emptyState(), cfg, NOW)).toEqual([]);
  });
});

describe('hot right now', () => {
  test('pings by default', () => {
    const out = escalate([hot()], emptyState(), cfg, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(true);
  });

  test('PING_ON=none posts it without a ping', () => {
    const out = escalate([hot()], emptyState(), { ...cfg, pingOn: new Set() }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(false);
  });

  test('only the hot alert pings: joins, team kills and the rest never do', () => {
    const out = escalate(
      [join({ watched: true, sweat: true }), tk('a', 10), tk('b', 20), tk('c', 30), hot()],
      emptyState(),
      cfg,
      NOW
    );
    expect(out.map((d) => [d.event.kind, d.ping])).toEqual([
      ['playerJoined', false],
      ['teamKill', false],
      ['teamKill', false],
      ['teamKill', false],
      ['hotPlayer', true]
    ]);
  });
});

describe('untiered alerts never ping', () => {
  test('admin actions and a quiet feed', () => {
    const out = escalate(
      [
        {
          kind: 'adminAction',
          serverId: 's1',
          at: '2026-09-27T12:00:00.000Z',
          auditId: 1,
          action: 'rcon.ban',
          actorName: 'mod',
          target: '765',
          reason: 'griefing'
        },
        { kind: 'feedQuiet', serverId: 's1', at: '2026-09-27T12:00:00.000Z', lastFeedAt: null }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out.map((d) => d.ping)).toEqual([false, false]);
  });
});

