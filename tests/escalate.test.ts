import { describe, expect, test } from 'vitest';
import { escalate, PING_KINDS, type EscalateConfig } from '../src/escalate.js';
import { emptyState } from '../src/state.js';
import type { KillRateEvent, ModEvent, TeamKillEvent } from '../src/events.js';

const cfg: EscalateConfig = { kdCooldownDays: 7, pingOn: new Set(PING_KINDS) };
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const DAY = 86_400_000;

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

const sweat = { perHour: 17, kills: 170, minutes: 600, range: '30d' };
const surge = {
  perHour: 21,
  minutes: 300,
  usualPerHour: 12,
  usualMinutes: 6000,
  ratio: 1.75,
  range: '7d'
};

const rate = (over: Partial<KillRateEvent> = {}): KillRateEvent => ({
  kind: 'killRate',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  steamId: '765',
  name: 'Alpha',
  sweat,
  surge: null,
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

describe('tiers 1 and 2 never ping', () => {
  test('a watched join posts without a ping', () => {
    const out = escalate(
      [{ kind: 'watchedJoin', serverId: 's1', at: '2026-09-24T12:00:00.000Z', steamId: '9', name: 'W' }],
      emptyState(),
      cfg,
      NOW
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(false);
  });

  test('a K/D flag posts without a ping and starts its cooldown', () => {
    const state = emptyState();
    const out = escalate([kd()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(false);
    expect(state.kdAlerted['765']).toBe(NOW);
  });

  test('a K/D re-flag inside the cooldown is dropped', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 2 * DAY;
    expect(escalate([kd()], state, cfg, NOW)).toHaveLength(0);
  });

  test('a K/D re-flag after the cooldown posts again', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 8 * DAY;
    expect(escalate([kd()], state, cfg, NOW)).toHaveLength(1);
  });
});

describe('untiered alerts never ping', () => {
  test('admin actions and a quiet feed', () => {
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
        },
        { kind: 'feedQuiet', serverId: 's1', at: '2026-09-24T12:00:00.000Z', lastFeedAt: null }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out.map((d) => d.ping)).toEqual([false, false]);
  });
});

describe('tier 3: kill rate', () => {
  test('a sweat pings and starts its own cooldown', () => {
    const state = emptyState();
    const out = escalate([rate()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
    expect(state.rateAlerted['sweat:765']).toBe(NOW);
    expect(state.rateAlerted['surge:765']).toBeUndefined();
  });

  test('a sweat that is also surging is one decision with one ping, both parts stamped', () => {
    const state = emptyState();
    const out = escalate([rate({ surge })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.ping).toBe(true);
    expect(state.rateAlerted['sweat:765']).toBe(NOW);
    expect(state.rateAlerted['surge:765']).toBe(NOW);
  });

  test('a part still cooling is removed from the event; the other still posts', () => {
    const state = emptyState();
    state.rateAlerted['sweat:765'] = NOW - 2 * DAY;
    const out = escalate([rate({ surge })], state, cfg, NOW);
    expect(out).toHaveLength(1);
    const e = out[0]!.event as KillRateEvent;
    expect(e.sweat).toBeNull();
    expect(e.surge).toEqual(surge);
    expect(state.rateAlerted['sweat:765']).toBe(NOW - 2 * DAY);
  });

  test('both parts cooling posts nothing', () => {
    const state = emptyState();
    state.rateAlerted['sweat:765'] = NOW - DAY;
    state.rateAlerted['surge:765'] = NOW - DAY;
    expect(escalate([rate({ surge })], state, cfg, NOW)).toHaveLength(0);
  });

  test('a cooldown past KD_COOLDOWN_DAYS no longer suppresses', () => {
    const state = emptyState();
    state.rateAlerted['sweat:765'] = NOW - 8 * DAY;
    expect(escalate([rate()], state, cfg, NOW)).toHaveLength(1);
  });

  test('PING_ON=none posts tier 3 without a ping but still stamps the cooldown', () => {
    const state = emptyState();
    const off: EscalateConfig = { ...cfg, pingOn: new Set() };
    const out = escalate([rate()], state, off, NOW);
    expect(out[0]!.ping).toBe(false);
    expect(state.rateAlerted['sweat:765']).toBe(NOW);
  });

  test('PING_ON=surge pings a surge but not a sweat on its own', () => {
    const onlySurge: EscalateConfig = { ...cfg, pingOn: new Set(['surge'] as const) };
    const sweatOnly = escalate([rate()], emptyState(), onlySurge, NOW);
    const both = escalate([rate({ surge })], emptyState(), onlySurge, NOW);
    expect(sweatOnly[0]!.ping).toBe(false);
    expect(both[0]!.ping).toBe(true);
  });
});
