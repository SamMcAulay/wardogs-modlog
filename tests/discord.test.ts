import { describe, expect, test } from 'vitest';
import { DiscordAPIError, HTTPError } from '@discordjs/rest';
import { buildMessage, permanentRejectionStatus, type LinkConfig } from '../src/discord.js';
import type { Decision, TeamKillEvent } from '../src/events.js';

const links: LinkConfig = {
  panelPublicUrl: 'https://panel.example.com',
  serverLabels: { s1: 'NA#3' }
};
const ROLE = '999';

// Typed as the concrete variant so tests can spread and override teamKill fields.
const teamKill: Decision & { event: TeamKillEvent } = {
  ping: true,
  event: {
    kind: 'teamKill',
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    eventId: 'e1',
    eventTime: 300,
    killer: { steamId: '765', name: 'Alpha', faction: 'Valkyra' },
    victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
    cause: 'Id.Item.AK74M',
    distanceM: 40.5,
    count: 3
  }
};

describe('buildMessage', () => {
  test('a pinging decision mentions the role and allows that one role', () => {
    const m = buildMessage(teamKill, links, ROLE);
    expect(m.content).toContain(`<@&${ROLE}>`);
    expect(m.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
  });

  test('a non-pinging decision mentions nothing at all', () => {
    const m = buildMessage({ ...teamKill, ping: false }, links, ROLE);
    expect(m.content ?? '').not.toContain('<@&');
    expect(m.allowed_mentions).toEqual({ parse: [] });
  });

  test('a team kill shows both factions, the evidence for the inference', () => {
    const text = JSON.stringify(buildMessage(teamKill, links, ROLE));
    expect(text).toContain('Valkyra');
  });

  test('a team kill links to the Kills tab filtered to that killer', () => {
    const text = JSON.stringify(buildMessage(teamKill, links, ROLE));
    expect(text).toContain(
      'https://panel.example.com/server/s1/kills?killer=765&kind=teamKill'
    );
  });

  test('links never use the internal container origin', () => {
    const text = JSON.stringify(buildMessage(teamKill, links, ROLE));
    expect(text).not.toContain('warcon:3000');
  });

  test('a watched join links to the dossier, since the reason is not readable', () => {
    const text = JSON.stringify(
      buildMessage(
        {
          ping: true,
          event: {
            kind: 'watchedJoin',
            serverId: 's1',
            at: '2026-09-24T12:00:00.000Z',
            steamId: '765',
            name: 'Alpha'
          }
        },
        links,
        ROLE
      )
    );
    expect(text).toContain('https://panel.example.com/server/s1/players/765');
  });

  test('an admin action names the actor, the target and the reason', () => {
    const text = JSON.stringify(
      buildMessage(
        {
          ping: false,
          event: {
            kind: 'adminAction',
            serverId: 's1',
            at: '2026-09-24T12:00:00.000Z',
            auditId: 7,
            action: 'rcon.ban',
            actorName: 'ModPerson',
            target: '765',
            reason: 'griefing'
          }
        },
        links,
        ROLE
      )
    );
    expect(text).toContain('ModPerson');
    expect(text).toContain('griefing');
  });

  test('every embed stays inside Discord field limits', () => {
    const long: Decision = {
      ping: false,
      event: {
        kind: 'adminAction',
        serverId: 's1',
        at: '2026-09-24T12:00:00.000Z',
        auditId: 7,
        action: 'rcon.ban',
        actorName: 'x'.repeat(500),
        target: '765',
        reason: 'y'.repeat(5000)
      }
    };
    const m = buildMessage(long, links, ROLE);
    expect(m.embeds[0]!.title!.length).toBeLessThanOrEqual(256);
    for (const f of m.embeds[0]!.fields ?? []) {
      expect(f.name.length).toBeLessThanOrEqual(256);
      expect(f.value.length).toBeLessThanOrEqual(1024);
    }
  });

  test('a team kill title is prefixed with the server label', () => {
    const m = buildMessage(teamKill, links, ROLE);
    expect(m.embeds[0]!.title).toMatch(/^NA#3 · Team kill — Alpha/);
  });

  test('the feed-quiet title is prefixed with the server label', () => {
    const m = buildMessage(
      {
        ping: false,
        event: {
          kind: 'feedQuiet',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          lastFeedAt: null
        }
      },
      links,
      ROLE
    );
    expect(m.embeds[0]!.title).toBe('NA#3 · Kill feed has gone quiet');
  });

  test('a pinging message names the server in the mention line', () => {
    const m = buildMessage(teamKill, links, ROLE);
    expect(m.content).toBe(`<@&${ROLE}> **NA#3**`);
  });

  test('a non-pinging message still has no content', () => {
    const m = buildMessage({ ...teamKill, ping: false }, links, ROLE);
    expect(m.content).toBeUndefined();
  });

  test('an unlabelled server falls back to the first eight characters of its id', () => {
    const m = buildMessage(
      {
        ping: false,
        event: { ...teamKill.event, serverId: 'c83bc8e1-ef6f-4d55-9398-b1a6f6faa2a8' }
      },
      links,
      ROLE
    );
    expect(m.embeds[0]!.title).toMatch(/^c83bc8e1 · /);
  });

  test('the 256-character title limit holds with a label prefix and a long name', () => {
    const long: Decision = {
      ping: false,
      event: { ...teamKill.event, killer: { ...teamKill.event.killer, name: 'z'.repeat(500) } }
    };
    const m = buildMessage(long, links, ROLE);
    expect(m.embeds[0]!.title!.length).toBeLessThanOrEqual(256);
  });
});

describe('permanentRejectionStatus', () => {
  const body = { body: undefined, files: undefined };

  test('a Discord API 4xx is permanent', () => {
    const err = new DiscordAPIError(
      { code: 50035, message: 'Invalid Form Body' },
      50035,
      400,
      'POST',
      '/channels/1/messages',
      body
    );
    expect(permanentRejectionStatus(err)).toBe(400);
    expect(permanentRejectionStatus(new HTTPError(403, 'Forbidden', 'POST', '/x', body))).toBe(403);
  });

  test('429, 5xx and errors without a status are retryable', () => {
    expect(permanentRejectionStatus(new HTTPError(429, 'Too Many Requests', 'POST', '/x', body))).toBeNull();
    expect(permanentRejectionStatus(new HTTPError(502, 'Bad Gateway', 'POST', '/x', body))).toBeNull();
    expect(permanentRejectionStatus(new Error('fetch failed'))).toBeNull();
    expect(permanentRejectionStatus('boom')).toBeNull();
  });
});
