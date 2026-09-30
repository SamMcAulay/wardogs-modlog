import type { BoardCache, BoardHit } from './board-cache.js';
import { serverLabel, type Embed, type EmbedField, type LinkConfig } from './discord.js';
import { actionRow, type ActionRow, type ButtonComponent } from './player-actions.js';
import type { Playtime, SteamClient } from './steam.js';
import type { WarconClient } from './warcon.js';
import type { Dossier, DossierBody } from './warcon-types.js';

/**
 * `/lookup`: everything staff want to know about one player, in one embed. The dossier is the
 * backbone (names, time on our servers, bans, risk, watchlist, team kills); the board export
 * adds 30-day and seed-excluded rates; Steam adds playtime outside our servers. Only the
 * dossier is essential: any other part that fails reads as unavailable, and the rest posts.
 */

/** The slash command, as Discord registers it: guild-only, one text option. */
export const LOOKUP_COMMAND = {
  name: 'lookup',
  description: 'Look up a player by SteamID or Steam profile link',
  contexts: [0],
  options: [
    {
      type: 3,
      name: 'player',
      description: 'SteamID64, or a steamcommunity.com/profiles/… or /id/… link',
      required: true,
      max_length: 200
    }
  ]
} as const;

export type PlayerInput = { steamId: string } | { vanity: string };

const STEAM_ID = /^7656119\d{10}$/;

/**
 * A SteamID64, a profile link, or a custom (vanity) profile link. A bare word is refused
 * rather than read as a vanity name: a mod typing an in-game name would otherwise get
 * whichever stranger owns that custom URL.
 */
export function parsePlayerInput(raw: string): PlayerInput | null {
  const text = raw.trim();
  if (STEAM_ID.test(text)) return { steamId: text };
  const profile = text.match(/steamcommunity\.com\/profiles\/(\d{17})(?:[/?#]|$)/i);
  if (profile && STEAM_ID.test(profile[1]!)) return { steamId: profile[1]! };
  const vanity = text.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})(?:[/?#]|$)/i);
  if (vanity) return { vanity: vanity[1]! };
  return null;
}

export type Part<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface LookupData {
  dossier: Dossier;
  thirty: Part<BoardHit>;
  lifetime: Part<BoardHit>;
  /** null: the profile hides its games */
  steam: Part<Playtime | null>;
}

export interface LookupDeps {
  warcon: WarconClient;
  boards: BoardCache;
  /** null without STEAM_API_KEY */
  steam: SteamClient | null;
  /** the server the dossier is read through; it covers every org server the key sees */
  serverId: string;
  wardogsAppId: number;
  /** Steam apps left out of the total and the top game */
  ignoredAppIds: ReadonlySet<number>;
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function part<T>(p: Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, reason: why(err) };
  }
}

/** Reads every part at once. Throws only when the dossier can't be read. */
export async function gatherLookup(deps: LookupDeps, steamId: string): Promise<LookupData> {
  const [dossier, thirty, lifetime, steam] = await Promise.all([
    deps.warcon.getJson<DossierBody>(
      `/api/servers/${encodeURIComponent(deps.serverId)}/players/${encodeURIComponent(steamId)}`
    ),
    part(deps.boards.row('30d', steamId)),
    part(deps.boards.row('all', steamId)),
    deps.steam
      ? part(deps.steam.playtime(steamId, deps.wardogsAppId, deps.ignoredAppIds))
      : Promise.resolve<Part<Playtime | null>>({ ok: false, reason: 'not configured' })
  ]);
  return { dossier: dossier.dossier, thirty, lifetime, steam };
}

// ---- the embed ----------------------------------------------------------------------------------

const COLOR = { banned: 0xe74c3c, watched: 0x3498db, risky: 0xe67e22, plain: 0x95a5a6 } as const;

const clamp = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const field = (name: string, value: string, inline = false): EmbedField => ({
  name: clamp(name, 256),
  value: clamp(value || '—', 1024),
  inline
});

/** Player-chosen text, shown as typed rather than as Discord markdown. */
export const escapeMd = (s: string): string => s.replace(/([\\*_`~|>[\]()#-])/g, '\\$1');

/** Minutes as hours: `4.5 h` under ten, `1,234 h` from there. */
export function hours(minutes: number): string {
  const h = minutes / 60;
  return h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h).toLocaleString('en-GB')} h`;
}

/** Kills per death; kills alone with no deaths; nothing with neither (Warcon's rule). */
export const kd = (kills: number, deaths: number): number | null =>
  deaths > 0 ? kills / deaths : kills > 0 ? kills : null;

/** Kills an hour of play, seeding left out as the panel does. */
export const perHour = (kills: number, minutes: number, seedMinutes = 0): number | null =>
  minutes - seedMinutes > 0 ? kills / ((minutes - seedMinutes) / 60) : null;

const fixed = (v: number | null, digits: number): string => (v === null ? '—' : v.toFixed(digits));
const count = (n: number): string => n.toLocaleString('en-GB');
const when = (iso: string, style: 'R' | 'D' | 'd'): string => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;

function hoursField(d: Dossier, steam: LookupData['steam']): EmbedField {
  const lines = [`Our servers: **${hours(d.summary.minutes)}** (${count(d.summary.sessions)} sessions)`];
  if (!steam.ok) {
    lines.push(
      steam.reason === 'not configured'
        ? 'Steam: not configured (set STEAM_API_KEY)'
        : `Steam: unavailable (${steam.reason})`
    );
  } else if (steam.value === null) {
    lines.push('Steam: hidden (game details are private)');
  } else {
    const p = steam.value;
    lines.push(`Wardogs total: ${p.wardogsMinutes === null ? 'not in their library' : `**${hours(p.wardogsMinutes)}**`}`);
    lines.push(
      `All Steam games: **${hours(p.totalMinutes)}**${p.ignoredMinutes > 0 ? ` (overlay tools left out: ${hours(p.ignoredMinutes)})` : ''}`
    );
    if (p.top) lines.push(`Most played: ${escapeMd(p.top.name)} (**${hours(p.top.minutes)}**)`);
  }
  return field('Hours', lines.join('\n'));
}

function lifetimeField(d: Dossier, lifetime: LookupData['lifetime']): EmbedField {
  const { kills, deaths, minutes, sessions } = d.summary;
  if (sessions === 0) return field('Lifetime', 'No play', true);
  // The export's rate leaves seeding out, as the panel's does. The dossier can't, so its rate is
  // only the fallback, and says so.
  const row = lifetime.ok ? lifetime.value.row : null;
  const rate = row
    ? `**${fixed(perHour(row.kills, row.minutes, row.seedMinutes), 1)}** kills/h`
    : `**${fixed(perHour(kills, minutes), 1)}** kills/h (seeding included)`;
  return field(
    'Lifetime',
    [`K/D **${fixed(kd(kills, deaths), 2)}**`, rate, `${count(kills)} kills / ${count(deaths)} deaths`].join('\n'),
    true
  );
}

function thirtyField(thirty: LookupData['thirty']): EmbedField {
  if (!thirty.ok) return field('Last 30 days', 'unavailable', true);
  const { row: r, cutMinutes } = thirty.value;
  if (!r) {
    // Warcon's export stops at ten thousand players, least-played last: missing from a full one
    // means little play, not none.
    return field(
      'Last 30 days',
      cutMinutes === null ? 'No play' : `Under ${hours(cutMinutes)} played, too little for Warcon's export`,
      true
    );
  }
  return field(
    'Last 30 days',
    [
      `K/D **${fixed(kd(r.kills, r.deaths), 2)}**`,
      `**${fixed(perHour(r.kills, r.minutes, r.seedMinutes), 1)}** kills/h`,
      `${hours(r.minutes)} · ${count(r.matches)} matches`
    ].join('\n'),
    true
  );
}

function teamKillField(d: Dossier): EmbedField {
  if (!d.combat) return field('Team kills', 'No kill feed yet', true);
  return field('Team kills', `**${count(d.combat.teamKills)}** given\n${count(d.combat.teamKilled)} received`, true);
}

function riskField(d: Dossier): EmbedField {
  const level = d.risk.level[0]!.toUpperCase() + d.risk.level.slice(1);
  const reasons = [...d.risk.reasons].sort((a, b) => b.weight - a.weight).map((r) => r.text);
  return field('Risk', `**${level}** (${d.risk.score})${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
}

function steamAccountField(d: Dossier): EmbedField {
  const s = d.steam;
  if (!s) return field('Steam account', 'No Steam data', true);
  const age = s.accountAgeDays === null ? 'age hidden' : `${(s.accountAgeDays / 365).toFixed(1)} yrs old`;
  const bans = `VAC ${s.vacBans} · game ${s.gameBans}${s.daysSinceLastBan !== null && s.vacBans + s.gameBans > 0 ? ` (last ${s.daysSinceLastBan} d ago)` : ''}`;
  const lines = [age, bans];
  if (s.communityBanned) lines.push('**Community banned**');
  if (s.profileUrl) lines.push(`[Profile](${s.profileUrl})`);
  return field('Steam account', lines.join('\n'), true);
}

export interface LookupMessage {
  embeds: Embed[];
  components: ActionRow<ButtonComponent>[];
}

/**
 * The reply. Its title keeps the alerts' `… — <name>` shape, so the Kick and Watch buttons
 * read the player's name from it the way they do on an alert.
 */
export function lookupMessage(
  data: LookupData,
  links: LinkConfig,
  /** where the dossier link and Watch point when the player isn't online */
  fallbackServerId: string
): LookupMessage {
  const d = data.dossier;
  const serverId = d.online?.serverId ?? fallbackServerId;
  const label = (id: string, fallback: string): string => links.serverLabels[id] ?? (fallback || serverLabel(id, {}));
  const seen = d.summary.sessions > 0;

  const description: string[] = [`\`${d.steamId}\``];
  if (d.online) description.push(`🟢 Online now on **${label(d.online.serverId, d.online.serverName)}**`);
  else if (d.summary.lastSeen) description.push(`Last seen ${when(d.summary.lastSeen, 'R')}`);
  if (!seen) description.push('Never seen on our servers.');
  else if (d.summary.firstSeen) description.push(`First seen ${when(d.summary.firstSeen, 'D')}`);
  if (d.watch.watched) {
    description.push(
      d.watch.reason
        ? `👁️ **Watched:** ${escapeMd(d.watch.reason)}`
        : '👁️ **Watched** (the reason needs the key to hold Notes & watchlist)'
    );
  }
  if (d.bannedOn.length) description.push(`⛔ **Banned on ${d.bannedOn.length} of our servers**`);

  const others = d.names.filter((n) => n !== d.name);
  const fields: EmbedField[] = [
    field('Also known as', others.length ? others.map(escapeMd).join(' · ') : 'No other names'),
    hoursField(d, data.steam),
    lifetimeField(d, data.lifetime),
    thirtyField(data.thirty),
    teamKillField(d)
  ];
  if (d.perServer.length) {
    fields.push(
      field(
        'Time per server',
        [...d.perServer]
          .sort((a, b) => b.minutes - a.minutes)
          .map((s) => `${label(s.serverId, s.serverName)} ${hours(s.minutes)}`)
          .join(' · ')
      )
    );
  }
  fields.push(riskField(d), steamAccountField(d));
  if (d.bannedOn.length) {
    fields.push(
      field(
        'Banned on',
        d.bannedOn
          .map((b) => `${label(b.serverId, b.serverName)}: ${escapeMd(b.reason || 'no reason')}${b.bannedBy ? ` (by ${escapeMd(b.bannedBy)})` : ''}`)
          .join('\n')
      )
    );
  }
  if (d.notes.length) {
    fields.push(
      field(
        `Staff notes (${d.notes.length})`,
        d.notes
          .slice(0, 3)
          .map((n) => `“${escapeMd(clamp(n.body, 200))}” (${escapeMd(n.authorName)}, ${when(n.createdAt, 'd')})`)
          .join('\n')
      )
    );
  }

  const embed: Embed = {
    title: clamp(`Lookup — ${d.name}`, 256),
    url: `${links.panelPublicUrl}/server/${encodeURIComponent(serverId)}/players/${encodeURIComponent(d.steamId)}`,
    color: d.bannedOn.length
      ? COLOR.banned
      : d.watch.watched
        ? COLOR.watched
        : d.risk.level === 'high'
          ? COLOR.risky
          : COLOR.plain,
    description: description.join('\n'),
    fields,
    timestamp: new Date().toISOString()
  };

  // Kick only while they're on a server, where the kick would land; Watch unless already watched.
  const row = actionRow(serverId, d.steamId, { kick: !!d.online, watch: !d.watch.watched });
  return { embeds: [embed], components: row.components.length ? [row] : [] };
}
