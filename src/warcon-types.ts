/** Mirrors Warcon's src/lib/types.ts for the fields we consume. */

export interface KillView {
  eventId: string;
  /** when Warcon received it (ISO) */
  ts: string;
  map: string;
  /** seconds on the match clock */
  eventTime: number;
  /** null: the environment killed them */
  killer: { steamId: string; name: string; faction: string | null } | null;
  victim: { steamId: string; name: string; faction: string | null };
  cause: string | null;
  distanceM: number | null;
  headshot: boolean;
  suicide: boolean;
  teamKill: boolean;
  tags: string[];
}

export interface KillsBody {
  ok: boolean;
  configured: boolean;
  /** ISO time the last feed batch arrived, or null */
  feedAt: string | null;
  kills: KillView[];
  total: number | null;
}

export interface AuditRow {
  id: number;
  createdAt: string;
  serverId: string | null;
  actorId: string | null;
  actorName: string;
  category: string;
  action: string;
  target: string | null;
  outcome: string;
  detail: unknown;
}

export interface AuditBody {
  ok: boolean;
  entries: AuditRow[];
  nextBefore: number | null;
}

export interface PlayerMark {
  steamId: string;
  watched: boolean;
  /** '' unless the key has staff capability — see spec §5.3 */
  reason: string;
  firstVisit: boolean;
}

export interface MarksBody {
  ok: boolean;
  marks: PlayerMark[];
}

export interface SummaryPlayer {
  name: string;
  steamId: string;
  faction: string | null;
  /** the current match's scoreboard */
  kills: number;
  deaths: number;
  cash: number;
  ping: number;
}

export interface SummaryStatus {
  serverName: string;
  /** the match clock in seconds; null on an idle server or a build that doesn't report it */
  matchSeconds: number | null;
}

export interface SummaryBody {
  ok: boolean;
  live: {
    serverId: string;
    ok: boolean;
    status: SummaryStatus | null;
    players: SummaryPlayer[];
  } | null;
}

export interface BoardRow {
  steamId: string;
  name: string;
  minutes: number;
  kills: number;
  deaths: number;
  matches: number;
  /**
   * Minutes of `minutes` spent seeding. Warcon's own `perHour` leaves them out:
   * kills / ((minutes - seedMinutes) / 60). Absent (the mock, older panels) reads as 0.
   */
  seedMinutes?: number;
}

export interface BoardBody {
  ok: boolean;
  rows: BoardRow[];
  /** the query Warcon actually ran; it falls back to another sort for one it doesn't know */
  query?: { sort?: string };
}
