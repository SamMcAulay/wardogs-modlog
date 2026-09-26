import type { HighKdEvent, ModEvent } from '../events.js';
import type { WarconClient } from '../warcon.js';
import type { BoardBody } from '../warcon-types.js';

export interface KdPollConfig {
  threshold: number;
  minMatches: number;
  minMinutes: number;
  range: string;
}

/**
 * Players over the K/D threshold (spec §5.4).
 *
 * `matches`, not sessions: the board carries no session count, and a Warcon session
 * is one join-to-leave stay, so reconnects would inflate it. Zero deaths is not
 * treated as infinite — one lucky kill on a fresh account must not alert.
 */
export async function pollKd(
  client: WarconClient,
  serverId: string,
  cfg: KdPollConfig,
  now: number
): Promise<ModEvent[]> {
  const query = new URLSearchParams({
    scope: 'server',
    range: cfg.range,
    sort: 'kd',
    dir: 'desc',
    minMinutes: String(cfg.minMinutes)
  });
  const body = await client.getJson<BoardBody>(
    `/api/servers/${encodeURIComponent(serverId)}/leaderboard?${query}`
  );

  const events: HighKdEvent[] = [];
  for (const r of body.rows) {
    if (r.deaths <= 0) continue; // not infinite — see above
    const kd = r.kills / r.deaths;
    if (kd < cfg.threshold) continue;
    if (r.matches < cfg.minMatches) continue;
    events.push({
      kind: 'highKd',
      serverId,
      at: new Date(now).toISOString(),
      steamId: r.steamId,
      name: r.name,
      kd,
      kills: r.kills,
      deaths: r.deaths,
      matches: r.matches,
      minutes: r.minutes
    });
  }
  return events;
}
