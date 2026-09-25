import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type { Decision, ModEvent } from './events.js';

export interface LinkConfig {
  /** the origin a mod's browser opens — never WARCON_BASE_URL */
  panelPublicUrl: string;
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  fields?: EmbedField[];
}

export interface DiscordMessage {
  content?: string;
  embeds: Embed[];
  allowed_mentions: { parse: []; roles?: string[] };
}

const COLOR = {
  teamKill: 0xd9534f,
  adminAction: 0x6c757d,
  watchedJoin: 0xf0ad4e,
  highKd: 0x5bc0de,
  feedQuiet: 0x8a6d3b
} as const;

const clamp = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const field = (name: string, value: string, inline = true): EmbedField => ({
  name: clamp(name, 256),
  value: clamp(value || '—', 1024),
  inline
});

/** `Id.Item.AK74M` -> `AK74M`; Warcon labels these properly, we only shorten. */
const weapon = (cause: string | null): string => (cause ? (cause.split('.').pop() ?? cause) : '—');

function embedFor(e: ModEvent, links: LinkConfig): Embed {
  const base = `${links.panelPublicUrl}/server/${encodeURIComponent(e.serverId)}`;

  switch (e.kind) {
    case 'teamKill':
      return {
        title: clamp(`Team kill — ${e.killer.name} (${e.count})`, 256),
        url: `${base}/kills?killer=${encodeURIComponent(e.killer.steamId)}&kind=teamKill`,
        color: COLOR.teamKill,
        timestamp: e.at,
        fields: [
          field('Killer', `${e.killer.name} · ${e.killer.faction ?? 'unknown'}`),
          field('Victim', `${e.victim.name} · ${e.victim.faction ?? 'unknown'}`),
          field('Weapon', weapon(e.cause)),
          field('Distance', e.distanceM === null ? '—' : `${Math.round(e.distanceM)} m`),
          field('This match', String(e.count))
        ]
      };

    case 'adminAction': {
      const verb = { 'rcon.kick': 'Kick', 'rcon.ban': 'Ban', 'rcon.unban': 'Unban' }[e.action];
      return {
        title: clamp(`${verb} by ${e.actorName}`, 256),
        url: `${base}/players/${encodeURIComponent(e.target)}`,
        color: COLOR.adminAction,
        timestamp: e.at,
        fields: [field('Target', e.target), field('Reason', e.reason, false)]
      };
    }

    case 'watchedJoin':
      return {
        title: clamp(`Watched player joined — ${e.name}`, 256),
        // The reason needs players.notes, which this key does not hold (spec §5.3).
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.watchedJoin,
        timestamp: e.at,
        description: 'Open the dossier for the watch reason.',
        fields: [field('Steam ID', e.steamId)]
      };

    case 'highKd':
      return {
        title: clamp(`High K/D — ${e.name}`, 256),
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.highKd,
        timestamp: e.at,
        fields: [
          field('K/D', e.kd.toFixed(2)),
          field('Kills / deaths', `${e.kills} / ${e.deaths}`),
          field('Matches', String(e.matches)),
          field('Playtime', `${Math.round(e.minutes)} min`)
        ]
      };

    case 'feedQuiet':
      return {
        title: 'Kill feed has gone quiet',
        url: `${base}/config`,
        color: COLOR.feedQuiet,
        timestamp: e.at,
        description:
          'No kill batch has arrived recently. Check the feed Url on the Config tab — a config written before the /api/ingest/events suffix was known needs Configure again.',
        fields: [field('Last batch', e.lastFeedAt ?? 'never')]
      };
  }
}

export function buildMessage(
  d: Decision,
  links: LinkConfig,
  modRoleId: string
): DiscordMessage {
  const embed = embedFor(d.event, links);
  return d.ping
    ? {
        content: `<@&${modRoleId}>`,
        embeds: [embed],
        allowed_mentions: { parse: [], roles: [modRoleId] }
      }
    : { embeds: [embed], allowed_mentions: { parse: [] } };
}

export interface DiscordPoster {
  post(message: DiscordMessage): Promise<void>;
}

/** Posts over REST. No gateway connection: this bot never receives anything. */
export class RestPoster implements DiscordPoster {
  private readonly rest: REST;

  constructor(
    token: string,
    private readonly channelId: string
  ) {
    this.rest = new REST({ version: '10' }).setToken(token);
  }

  async post(message: DiscordMessage): Promise<void> {
    await this.rest.post(Routes.channelMessages(this.channelId), { body: message });
  }
}
