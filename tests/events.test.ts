import { describe, expect, test } from 'vitest';
import { eventKey, type ModEvent } from '../src/events.js';

const teamKill: ModEvent = {
  kind: 'teamKill',
  serverId: 's1',
  at: '2026-09-24T10:00:00.000Z',
  eventId: 'e1',
  eventTime: 120,
  killer: { steamId: '765', name: 'Alpha', faction: 'Valkyra' },
  victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
  cause: 'Id.Item.AK74M',
  distanceM: 40,
  count: 0
};

describe('eventKey', () => {
  test('a team kill is keyed by its event id', () => {
    expect(eventKey(teamKill)).toBe('teamKill:e1');
  });

  test('an admin action is keyed by its audit row id', () => {
    expect(
      eventKey({
        kind: 'adminAction',
        serverId: 's1',
        at: '2026-09-24T10:00:00.000Z',
        auditId: 42,
        action: 'rcon.ban',
        actorName: 'mod',
        target: '765',
        reason: 'griefing'
      })
    ).toBe('adminAction:42');
  });

  test('keys of different kinds never collide', () => {
    const watched = eventKey({
      kind: 'watchedJoin',
      serverId: 's1',
      at: '2026-09-24T10:00:00.000Z',
      steamId: '765',
      name: 'Alpha'
    });
    expect(watched).not.toBe(eventKey(teamKill));
  });
});
