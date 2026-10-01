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
          ping: false,
          event: {
            kind: 'playerJoined',
            serverId: 's1',
            at: '2026-09-24T12:00:00.000Z',
            steamId: '765',
            name: 'Alpha',
            watched: true,
            sweat: false,
            highKd: false
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

describe('join embed', () => {
  const join = (tags: { watched?: boolean; sweat?: boolean; highKd?: boolean }) =>
    buildMessage(
      {
        ping: false,
        event: {
          kind: 'playerJoined',
          serverId: 's1',
          at: '2026-09-27T12:00:00.000Z',
          steamId: '765',
          name: 'Alpha',
          watched: false,
          sweat: false,
          highKd: false,
          ...tags
        }
      },
      links,
      ROLE
    ).embeds[0]!;
  const lines = (e: ReturnType<typeof join>) => e.description!.split('\n');
  const tagsOf = (e: ReturnType<typeof join>) => /^\*\*(.*)\*\*/.exec(lines(e)[0]!)![1];

  test('watched only: tier 1, blue, with the dossier hint', () => {
    const e = join({ watched: true });
    expect(e.title).toBe('NA#3 · Joined — Alpha');
    expect(tagsOf(e)).toBe('watched');
    expect(e.color).toBe(0x3498db);
    expect(e.footer).toEqual({ text: 'Tier 1 · watchlist' });
    expect(lines(e)).toEqual(['**watched** · `765`', 'Open the dossier for the watch reason.']);
    expect(e.url).toBe('https://panel.example.com/server/s1/players/765');
  });

  test('a join card is description only: no field grid to stretch the channel', () => {
    expect(join({ watched: true }).fields).toBeUndefined();
    expect(join({ sweat: true }).fields).toBeUndefined();
  });

  test.each([
    [{ sweat: true }, 'sweat'],
    [{ highKd: true }, 'high K/D'],
    [{ sweat: true, highKd: true }, 'sweat · high K/D'],
    [{ watched: true, sweat: true }, 'watched · sweat'],
    [{ watched: true, highKd: true }, 'watched · high K/D'],
    [{ watched: true, sweat: true, highKd: true }, 'watched · sweat · high K/D']
  ])('any known tag %o: tier 2, orange, tags "%s"', (tags, text) => {
    const e = join(tags);
    expect(e.title).toBe('NA#3 · Joined — Alpha');
    expect(tagsOf(e)).toBe(text);
    expect(e.color).toBe(0xe67e22);
    expect(e.footer).toEqual({ text: 'Tier 2 · known player' });
    expect(e.url).toBe('https://panel.example.com/server/s1/players/765');
  });

  test('a known join without the watched tag carries no watch-reason hint', () => {
    expect(lines(join({ sweat: true }))).toEqual(['**sweat** · `765`']);
    expect(lines(join({ watched: true, sweat: true }))).toContain('Open the dossier for the watch reason.');
  });
});

describe('hot embed', () => {
  const hot: Decision = {
    ping: true,
    event: {
      kind: 'hotPlayer',
      serverId: 's1',
      at: '2026-09-27T12:00:00.000Z',
      steamId: '765',
      name: 'Alpha',
      kills: 14,
      deaths: 3,
      minutes: 32.5,
      perHour: 25.846
    }
  };

  test('tier 3, red, titled Hot right now, with the match figures', () => {
    const m = buildMessage(hot, links, ROLE);
    const e = m.embeds[0]!;
    expect(e.title).toBe('NA#3 · Hot right now — Alpha');
    expect(e.color).toBe(0xe74c3c);
    expect(e.footer).toEqual({ text: 'Tier 3 · hot right now' });
    expect(e.url).toBe('https://panel.example.com/server/s1/players/765');
    expect(e.fields).toEqual([
      { name: 'Kills / deaths', value: '14 / 3', inline: true },
      { name: 'Minutes this match', value: '33', inline: true },
      { name: 'Kills/hour', value: '25.8', inline: true }
    ]);
    expect(m.content).toBe(`<@&${ROLE}> **NA#3**`);
  });
});

describe('untiered', () => {
  const at = '2026-09-24T12:00:00.000Z';
  const msg = (event: import('../src/events.js').ModEvent) =>
    buildMessage({ event, ping: false }, links, ROLE).embeds[0]!;

  test('untiered alerts have no footer, and a team kill is purple', () => {
    const tkEmbed = msg({
      kind: 'teamKill', serverId: 's1', at, eventId: 'e', eventTime: 1,
      killer: { steamId: '1', name: 'A', faction: 'V' },
      victim: { steamId: '2', name: 'B', faction: 'V' },
      cause: null, distanceM: null, count: 1
    });
    expect(tkEmbed.color).toBe(0x9b59b6);
    expect(tkEmbed.footer).toBeUndefined();
    expect(msg({ kind: 'feedQuiet', serverId: 's1', at, lastFeedAt: null }).footer).toBeUndefined();
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

describe('join embed stats', () => {
  const sweatStats = { perHour: 17.96, kills: 180, minutes: 601, range: '30d' };
  const highKdStats = { kd: 5.2, kills: 52, deaths: 10, matches: 9, range: '30d' };
  const embed = (over: Partial<import('../src/events.js').PlayerJoinedEvent>) =>
    buildMessage(
      {
        ping: false,
        event: {
          kind: 'playerJoined',
          serverId: 's1',
          at: '2026-09-27T12:00:00.000Z',
          steamId: '765',
          name: 'Alpha',
          watched: false,
          sweat: false,
          highKd: false,
          ...over
        }
      },
      links,
      ROLE
    ).embeds[0]!;

  test("a known sweat's join shows their 30-day rate and playtime", () => {
    const e = embed({ sweat: true, sweatStats });
    expect(e.description).toContain('Kills/hour (30d): **18.0** · 10.0 h played');
  });

  test("a known high K/D's join shows their K/D, kills and deaths, and matches", () => {
    const e = embed({ highKd: true, highKdStats });
    expect(e.description).toContain('K/D (30d): **5.20** · 52 / 10 · 9 matches');
  });

  test('both sets show on one embed, and the tags stay as the summary line', () => {
    const e = embed({ sweat: true, highKd: true, sweatStats, highKdStats });
    expect(e.description!.split('\n')).toEqual([
      '**sweat · high K/D** · `765`',
      'Kills/hour (30d): **18.0** · 10.0 h played',
      'K/D (30d): **5.20** · 52 / 10 · 9 matches'
    ]);
  });

  test('a tag dropped by the daily limit shows no numbers for it', () => {
    // escalate() clears sweat when it is still quiet; the stats alone must not show.
    const e = embed({ watched: true, sweat: false, sweatStats });
    expect(e.description).not.toContain('Kills/hour');
  });
});

describe('the Kick button', () => {
  const at = '2026-09-27T12:00:00.000Z';
  const msg = (event: import('../src/events.js').ModEvent) => buildMessage({ event, ping: false }, links, ROLE);
  const buttonId = (m: ReturnType<typeof msg>) => m.components?.[0]?.components[0]?.custom_id;

  test('a join, a hot player and a team kill each carry a Kick button for that player', () => {
    expect(
      buttonId(msg({ kind: 'playerJoined', serverId: 's1', at, steamId: '76561198000000001', name: 'A', watched: false, sweat: true, highKd: false }))
    ).toBe('kick:s1:76561198000000001');
    expect(
      buttonId(msg({ kind: 'hotPlayer', serverId: 's1', at, steamId: '76561198000000002', name: 'B', kills: 10, deaths: 1, minutes: 20, perHour: 30 }))
    ).toBe('kick:s1:76561198000000002');
    expect(
      buttonId(
        msg({
          kind: 'teamKill', serverId: 's1', at, eventId: 'e', eventTime: 1,
          killer: { steamId: '76561198000000003', name: 'K', faction: 'V' },
          victim: { steamId: '76561198000000004', name: 'V', faction: 'V' },
          cause: null, distanceM: null, count: 1
        })
      )
    ).toBe('kick:s1:76561198000000003'); // the killer, not the victim
  });

  test('kicks, bans and feed warnings carry no button', () => {
    expect(
      msg({ kind: 'adminAction', serverId: 's1', at, auditId: 1, action: 'rcon.ban', actorName: 'm', target: '765', reason: '' }).components
    ).toBeUndefined();
    expect(msg({ kind: 'feedQuiet', serverId: 's1', at, lastFeedAt: null }).components).toBeUndefined();
  });
});

describe('watch reason on joins', () => {
  const join = (over: Partial<import('../src/events.js').PlayerJoinedEvent>) =>
    buildMessage(
      {
        ping: false,
        event: {
          kind: 'playerJoined', serverId: 's1', at: '2026-09-27T12:00:00.000Z', steamId: '765',
          name: 'Alpha', watched: true, sweat: false, highKd: false, ...over
        }
      },
      links,
      ROLE
    ).embeds[0]!;

  test('a watched join shows why they are watched, straight after the tags', () => {
    const e = join({ watchReason: 'aimbot suspicion' });
    expect(e.description).toBe('**watched** · `765`\n> aimbot suspicion');
  });

  test('without a reason on record it still points at the dossier', () => {
    const e = join({});
    expect(e.description).toMatch(/dossier/);
  });

  test('a multi-line reason stays on one quoted line', () => {
    expect(join({ watchReason: 'aimbot\n\nsuspicion' }).description).toBe('**watched** · `765`\n> aimbot suspicion');
  });
});

describe('the Watch button', () => {
  const at = '2026-09-27T12:00:00.000Z';
  const labels = (event: import('../src/events.js').ModEvent) =>
    buildMessage({ event, ping: false }, links, ROLE).components?.[0]?.components.map((b) => b.label);

  test('sits beside Kick on alerts about a player who may not be watched yet', () => {
    expect(labels({ kind: 'playerJoined', serverId: 's1', at, steamId: '76561198000000001', name: 'A', watched: false, sweat: true, highKd: false })).toEqual(['Kick', 'Watch']);
    expect(labels({ kind: 'hotPlayer', serverId: 's1', at, steamId: '76561198000000002', name: 'B', kills: 10, deaths: 1, minutes: 20, perHour: 30 })).toEqual(['Kick', 'Watch']);
  });

  test('a join by someone already on the watchlist carries no buttons at all', () => {
    expect(labels({ kind: 'playerJoined', serverId: 's1', at, steamId: '76561198000000001', name: 'A', watched: true, sweat: false, highKd: false })).toBeUndefined();
    expect(labels({ kind: 'playerJoined', serverId: 's1', at, steamId: '76561198000000001', name: 'A', watched: true, sweat: true, highKd: false })).toBeUndefined();
  });
});
