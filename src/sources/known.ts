import type { ModEvent } from '../events.js';
import type { ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { BoardBody, BoardRow } from '../warcon-types.js';

export interface KnownConfig {
  /** SWEAT_PER_HOUR, over SWEAT_RANGE with RATE_MIN_MINUTES played */
  sweatPerHour: number;
  sweatRange: string;
  rateMinMinutes: number;
  /** KD_THRESHOLD, over KD_RANGE with KD_MIN_MATCHES and KD_MIN_MINUTES */
  kdThreshold: number;
  kdMinMatches: number;
  kdMinMinutes: number;
  kdRange: string;
}

/** Rows per leaderboard page; Warcon serves fifty. */
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4;

/** Kills per hour, computed here so thresholds never depend on the panel's rounding. */
const perHour = (kills: number, minutes: number): number => (minutes > 0 ? kills / (minutes / 60) : 0);

/**
 * Warcon's own `perHour`, seeding time left out: what the panel shows and sorts by
 * (tiered-alerts spec §3).
 */
export const panelRate = (r: BoardRow): number => perHour(r.kills, r.minutes - (r.seedMinutes ?? 0));

/**
 * Refreshes the server's known-player lists (live-alerts spec §4.1): the sweats and the
 * high K/Ds that tag a join. Posts nothing. Both boards are read before either list is
 * replaced, so a failed read throws with the old lists (and `knownAt`) intact.
 */
export async function pollKnown(
  client: WarconClient,
  serverId: string,
  s: ServerState,
  cfg: KnownConfig,
  now: number
): Promise<ModEvent[]> {
  const sweats = await sweatRows(client, serverId, cfg);
  const highKd = await highKdRows(client, serverId, cfg);
  s.knownSweats = sweats.map((r) => r.steamId);
  s.knownHighKd = highKd.map((r) => r.steamId);
  // The numbers behind each listing, so a join alert can show why the player is known.
  const stats: ServerState['knownStats'] = {};
  for (const r of sweats) {
    stats[r.steamId] = {
      sweat: { perHour: panelRate(r), kills: r.kills, minutes: r.minutes, range: cfg.sweatRange }
    };
  }
  for (const r of highKd) {
    stats[r.steamId] = {
      ...stats[r.steamId],
      highKd: {
        kd: r.kills / r.deaths,
        kills: r.kills,
        deaths: r.deaths,
        matches: r.matches,
        range: cfg.kdRange
      }
    };
  }
  s.knownStats = stats;
  s.knownAt = now;
  return [];
}

/**
 * Rows at or above the sweat line, by the panel's seed-excluded rate.
 *
 * Pages follow Warcon's sort, so the stop test uses that same rate: a page whose last
 * row is still at or above the line may be followed by more rows that are, and paging
 * on any other rate could stop early.
 */
async function sweatRows(client: WarconClient, serverId: string, cfg: KnownConfig): Promise<BoardRow[]> {
  const out: BoardRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      scope: 'server',
      range: cfg.sweatRange,
      sort: 'perHour',
      dir: 'desc',
      minMinutes: String(cfg.rateMinMinutes),
      page: String(page)
    });
    const { rows } = await client.getJson<BoardBody>(
      `/api/servers/${encodeURIComponent(serverId)}/leaderboard?${query}`
    );
    out.push(...rows.filter((r) => panelRate(r) >= cfg.sweatPerHour));
    const last = rows[rows.length - 1];
    if (rows.length < PAGE_SIZE || !last || panelRate(last) < cfg.sweatPerHour) break;
  }
  return out;
}

/**
 * Rows over the K/D line (base spec §5.4).
 *
 * `matches`, not sessions: the board carries no session count, and a Warcon session
 * is one join-to-leave stay, so reconnects would inflate it. Zero deaths is not
 * treated as infinite — one lucky kill on a fresh account must not count.
 */
async function highKdRows(client: WarconClient, serverId: string, cfg: KnownConfig): Promise<BoardRow[]> {
  const query = new URLSearchParams({
    scope: 'server',
    range: cfg.kdRange,
    sort: 'kd',
    dir: 'desc',
    minMinutes: String(cfg.kdMinMinutes)
  });
  const { rows } = await client.getJson<BoardBody>(
    `/api/servers/${encodeURIComponent(serverId)}/leaderboard?${query}`
  );
  return rows.filter((r) => r.deaths > 0 && r.kills / r.deaths >= cfg.kdThreshold && r.matches >= cfg.kdMinMatches);
}
