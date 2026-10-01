import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type { Decision, HotHistory, ModEvent, PlayerJoinedEvent } from './events.js';
import { actionRow, type ActionRow, type ButtonComponent } from './player-actions.js';

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
  /** the Kick and Watch buttons, on alerts about one player who may be on the server */
  components?: ActionRow<ButtonComponent>[];
}

/** The player the Kick and Watch buttons would act on, or null for alerts that aren't about one. */
function kickTarget(e: ModEvent): string | null {
  switch (e.kind) {
    case 'playerJoined':
    case 'hotPlayer':
      return e.steamId;
    case 'teamKill':
      return e.killer.steamId;
    case 'adminAction':
    case 'feedQuiet':
      return null;
  }
}

/** Tier colours (live-alerts spec §2); untiered alerts keep their own. */
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

/** A join's tags as staff read them, e.g. `watched · sweat` (live-alerts spec §5). */
export function joinTags(e: { watched: boolean; sweat: boolean; highKd: boolean; steamVeteran?: boolean }): string {
  const tags: string[] = [];
  if (e.watched) tags.push('watched');
  if (e.sweat) tags.push('sweat');
  if (e.highKd) tags.push('high K/D');
  if (e.steamVeteran) tags.push('Steam veteran');
  return tags.join(' · ');
}

/** 600 -> `10.0 h` */
const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)} h`;

/** 740000 -> `12,333 h`: Steam totals run to thousands, where a decimal is noise. */
const steamHours = (minutes: number): string => `${Math.floor(minutes / 60).toLocaleString('en-US')} h`;

/**
 * The numbers behind a known player's tags, one line each. Keyed off the tag, not the
 * stats: when the daily limit drops a tag, its numbers must not show on their own.
 */
function joinStatLines(e: PlayerJoinedEvent): string[] {
  const out: string[] = [];
  if (e.sweat && e.sweatStats) {
    const s = e.sweatStats;
    out.push(`Kills/hour (${s.range}): **${s.perHour.toFixed(1)}** · ${hours(s.minutes)} played`);
  }
  if (e.highKd && e.highKdStats) {
    const k = e.highKdStats;
    out.push(`K/D (${k.range}): **${k.kd.toFixed(2)}** · ${k.kills} / ${k.deaths} · ${k.matches} matches`);
  }
  if (e.steamVeteran && e.veteranStats) {
    const v = e.veteranStats;
    const parts = [
      ...(v.totalMinutes !== undefined ? [`**${steamHours(v.totalMinutes)}** all games`] : []),
      ...(v.game ? [`**${steamHours(v.game.minutes)}** ${v.game.name}`] : [])
    ];
    out.push(`Steam: ${parts.join(' · ')}`);
  }
  return out;
}

/** A hot player's record, as the line that says why their match stood out. */
function historyLine(h: HotHistory): string {
  switch (h.kind) {
    case 'regular':
      return `${hours(h.minutes)} · ${h.perHour.toFixed(1)} kills/h · K/D ${h.kd.toFixed(2)} — well above their usual`;
    case 'new':
      return h.minutes === null ? 'Not on record: new to our servers' : `Only ${hours(h.minutes)} on record`;
    case 'unavailable':
      return 'Unavailable (the board could not be read)';
  }
}

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

    case 'playerJoined': {
      // One post per connection, at the highest tier its tags reach (live-alerts spec §2).
      // Joins are the busiest alert, so the card is a few description lines, not fields.
      const known = e.sweat || e.highKd || e.steamVeteran;
      // The reason is readable when the key holds Notes & watchlist; without one on
      // record (or without that permission) point at the dossier instead.
      const reason = !e.watched
        ? []
        : e.watchReason
          ? [`> ${clamp(e.watchReason.replace(/\s+/g, ' '), 500)}`]
          : ['Open the dossier for the watch reason.'];
      return {
        title: `Joined — ${e.name}`,
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: known ? COLOR.tier2 : COLOR.tier1,
        timestamp: e.at,
        description: [`**${joinTags(e)}** · \`${e.steamId}\``, ...reason, ...joinStatLines(e)].join('\n'),
        footer: { text: known ? 'Tier 2 · known player' : 'Tier 1 · watchlist' }
      };
    }

    case 'hotPlayer':
      return {
        title: `Hot right now — ${e.name}`,
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.tier3,
        timestamp: e.at,
        fields: [
          field('Kills/hour', e.perHour.toFixed(1)),
          field('Measured', `${e.measuredKills} kills in ${Math.round(e.minutes)} min`),
          field('Scoreboard K / D', `${e.kills} / ${e.deaths}`),
          field('History (all time)', historyLine(e.history), false)
        ],
        footer: { text: 'Tier 3 · hot right now' }
      };
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
  // A join is a call to act only for a sweat or high K/D not yet watched. A watched
  // player's join is a heads-up, and Steam hours alone say nothing about play here.
  const quietJoin = d.event.kind === 'playerJoined' && (d.event.watched || (!d.event.sweat && !d.event.highKd));
  const target = quietJoin ? null : kickTarget(d.event);
  const components = target ? { components: [actionRow(d.event.serverId, target, { watch: true })] } : {};
  return d.ping
    ? {
        content: `<@&${modRoleId}> **${label}**`,
        embeds: [embed],
        allowed_mentions: { parse: [], roles: [modRoleId] },
        ...components
      }
    : { embeds: [embed], allowed_mentions: { parse: [] }, ...components };
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
