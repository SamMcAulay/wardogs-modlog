import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type { Decision, ModEvent } from './events.js';

export interface LinkConfig {
  /** the origin a mod's browser opens — never WARCON_BASE_URL */
  panelPublicUrl: string;
  serverLabels: Record<string, string>;
}

/** The short name staff know a server by; falls back to its id's first 8 chars (spec §8.5). */
export function serverLabel(serverId: string, labels: Record<string, string>): string {
  return labels[serverId] ?? serverId.slice(0, 8);
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
  footer?: { text: string };
}

export interface DiscordMessage {
  content?: string;
  embeds: Embed[];
  allowed_mentions: { parse: []; roles?: string[] };
}

/** Tier colours (tiered-alerts spec §2); untiered alerts keep their own. */
const COLOR = {
  tier1: 0x3498db,
  tier2: 0xe67e22,
  tier3: 0xe74c3c,
  teamKill: 0x9b59b6,
  adminAction: 0x6c757d,
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

/** 600 -> `10.0 h` */
const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)} h`;

function embedFor(e: ModEvent, links: LinkConfig): Embed {
  const base = `${links.panelPublicUrl}/server/${encodeURIComponent(e.serverId)}`;

  switch (e.kind) {
    case 'teamKill':
      return {
        title: `Team kill — ${e.killer.name} (${e.count})`,
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
        title: `${verb} by ${e.actorName}`,
        url: `${base}/players/${encodeURIComponent(e.target)}`,
        color: COLOR.adminAction,
        timestamp: e.at,
        fields: [field('Target', e.target), field('Reason', e.reason, false)]
      };
    }

    case 'watchedJoin':
      return {
        title: `Watched player joined — ${e.name}`,
        // The reason needs players.notes, which this key does not hold (spec §5.3).
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.tier1,
        timestamp: e.at,
        description: 'Open the dossier for the watch reason.',
        fields: [field('Steam ID', e.steamId)],
        footer: { text: 'Tier 1 · watchlist' }
      };

    case 'highKd':
      return {
        title: `High K/D — ${e.name}`,
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.tier2,
        timestamp: e.at,
        fields: [
          field('K/D', e.kd.toFixed(2)),
          field('Kills / deaths', `${e.kills} / ${e.deaths}`),
          field('Matches', String(e.matches)),
          field('Playtime', `${Math.round(e.minutes)} min`)
        ],
        footer: { text: 'Tier 2 · high K/D' }
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

    case 'killRate': {
      const what = e.sweat && e.surge ? 'Sweat + surge' : e.sweat ? 'Sweat' : 'Surge';
      const fields: EmbedField[] = [];
      if (e.sweat) {
        fields.push(field(`Kills/hour (${e.sweat.range})`, e.sweat.perHour.toFixed(1)));
        fields.push(field(`Playtime (${e.sweat.range})`, hours(e.sweat.minutes)));
      }
      if (e.surge) {
        fields.push(field(`Kills/hour (${e.surge.range})`, e.surge.perHour.toFixed(1)));
        fields.push(
          field('Usual kills/hour', `${e.surge.usualPerHour.toFixed(1)} over ${hours(e.surge.usualMinutes)}`)
        );
        fields.push(
          field('Vs usual', Number.isFinite(e.surge.ratio) ? `${e.surge.ratio.toFixed(1)}×` : 'new')
        );
      }
      return {
        title: `${what} — ${e.name}`,
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.tier3,
        timestamp: e.at,
        fields,
        footer: { text: `Tier 3 · ${what.toLowerCase()}` }
      };
    }
  }
}

export function buildMessage(
  d: Decision,
  links: LinkConfig,
  modRoleId: string
): DiscordMessage {
  const embed = embedFor(d.event, links);
  const label = serverLabel(d.event.serverId, links.serverLabels);
  embed.title = clamp(`${label} · ${embed.title ?? ''}`, 256);
  return d.ping
    ? {
        content: `<@&${modRoleId}> **${label}**`,
        embeds: [embed],
        allowed_mentions: { parse: [], roles: [modRoleId] }
      }
    : { embeds: [embed], allowed_mentions: { parse: [] } };
}

/**
 * The HTTP status of a post Discord rejected permanently — a 4xx other than 429 — or
 * null for anything worth retrying (429, 5xx, a timeout or network error).
 *
 * @discordjs/rest throws `DiscordAPIError` (JSON error body) or `HTTPError` (anything
 * else), and both carry a numeric `status`; rate-limit and network failures do not.
 * Read structurally so the poster interface stays free of @discordjs/rest types.
 */
export function permanentRejectionStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('status' in err)) return null;
  const status = (err as { status: unknown }).status;
  if (typeof status !== 'number') return null;
  return status >= 400 && status < 500 && status !== 429 ? status : null;
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
