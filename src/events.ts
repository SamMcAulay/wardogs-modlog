/** Every event a source can produce. `at` is ISO. */
export type ModEvent =
  | TeamKillEvent
  | AdminActionEvent
  | WatchedJoinEvent
  | HighKdEvent
  | FeedQuietEvent
  | KillRateEvent;

export interface TeamKillEvent {
  kind: 'teamKill';
  serverId: string;
  at: string;
  eventId: string;
  /** match clock seconds; a decrease means a new match (spec §8.1) */
  eventTime: number;
  killer: { steamId: string; name: string; faction: string | null };
  victim: { steamId: string; name: string; faction: string | null };
  cause: string | null;
  distanceM: number | null;
  /** this killer's running count in the current match. Sources emit 0;
   *  escalate() replaces it with the real count. */
  count: number;
}

export interface AdminActionEvent {
  kind: 'adminAction';
  serverId: string;
  at: string;
  auditId: number;
  action: 'rcon.kick' | 'rcon.ban' | 'rcon.unban';
  actorName: string;
  target: string;
  reason: string;
}

export interface WatchedJoinEvent {
  kind: 'watchedJoin';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
}

export interface HighKdEvent {
  kind: 'highKd';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
  kd: number;
  kills: number;
  deaths: number;
  matches: number;
  minutes: number;
}

export interface FeedQuietEvent {
  kind: 'feedQuiet';
  serverId: string;
  at: string;
  /** ISO time of the last batch, or null if none has ever arrived */
  lastFeedAt: string | null;
}

/** Sustained high kill rate over SWEAT_RANGE (tiered-alerts spec §3). */
export interface SweatPart {
  perHour: number;
  kills: number;
  minutes: number;
  range: string;
}

/** Recent rate well above the player's own usual on this server (tiered-alerts spec §4). */
export interface SurgePart {
  /** over `range` */
  perHour: number;
  /** played over `range` */
  minutes: number;
  /** all-time on this server */
  usualPerHour: number;
  usualMinutes: number;
  /** perHour / usualPerHour; Infinity when usualPerHour is 0 */
  ratio: number;
  range: string;
}

/** Tier 3: one per player, carrying a sweat part, a surge part, or both (spec §5). */
export interface KillRateEvent {
  kind: 'killRate';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
  sweat: SweatPart | null;
  surge: SurgePart | null;
}

/** An event plus whether posting it should mention the mod role. */
export interface Decision {
  event: ModEvent;
  ping: boolean;
}

/** A stable identity for logging and de-duplication within one cycle. */
export function eventKey(e: ModEvent): string {
  switch (e.kind) {
    case 'teamKill':
      return `teamKill:${e.eventId}`;
    case 'adminAction':
      return `adminAction:${e.auditId}`;
    case 'watchedJoin':
      return `watchedJoin:${e.serverId}:${e.steamId}:${e.at}`;
    case 'highKd':
      return `highKd:${e.serverId}:${e.steamId}:${e.at}`;
    case 'feedQuiet':
      return `feedQuiet:${e.serverId}:${e.at}`;
    case 'killRate':
      return `killRate:${e.serverId}:${e.steamId}:${e.at}`;
  }
}
