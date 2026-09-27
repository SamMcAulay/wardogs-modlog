/** Every event a source can produce. `at` is ISO. */
export type ModEvent =
  | TeamKillEvent
  | AdminActionEvent
  | FeedQuietEvent
  | PlayerJoinedEvent
  | HotPlayerEvent;

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

export interface FeedQuietEvent {
  kind: 'feedQuiet';
  serverId: string;
  at: string;
  /** ISO time of the last batch, or null if none has ever arrived */
  lastFeedAt: string | null;
}

/**
 * A player carrying at least one tag has connected (live-alerts spec §4.2, §5). Tier 1
 * when only `watched`; tier 2 with any known tag. At least one flag is true.
 */
export interface PlayerJoinedEvent {
  kind: 'playerJoined';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
  watched: boolean;
  sweat: boolean;
  highKd: boolean;
}

/** Tier 3: a high kill rate in the current match (live-alerts spec §3). */
export interface HotPlayerEvent {
  kind: 'hotPlayer';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
  /** this match's scoreboard */
  kills: number;
  deaths: number;
  /** minutes since the bot first saw them this match */
  minutes: number;
  perHour: number;
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
    case 'feedQuiet':
      return `feedQuiet:${e.serverId}:${e.at}`;
    case 'playerJoined':
      return `playerJoined:${e.serverId}:${e.steamId}:${e.at}`;
    case 'hotPlayer':
      return `hotPlayer:${e.serverId}:${e.steamId}:${e.at}`;
  }
}
