import type { ModEvent, WatchedJoinEvent } from '../events.js';
import type { ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { MarksBody, SummaryBody } from '../warcon-types.js';

const MARKS_BATCH = 200;

/**
 * Watched players who have just appeared (spec §5.3).
 *
 * `marks` returns `watched` on server.view but blanks `reason` without staff
 * capability, so the embed links to the dossier instead of quoting a reason.
 */
export async function pollWatchlist(
  client: WarconClient,
  serverId: string,
  s: ServerState,
  now: number
): Promise<ModEvent[]> {
  const id = encodeURIComponent(serverId);
  const summary = await client.getJson<SummaryBody>(`/api/servers/${id}/summary`);
  const players = summary.live?.players ?? [];

  const previous = new Set(s.presentSteamIds);
  const current = players.map((p) => p.steamId);

  const arrivals = players.filter((p) => !previous.has(p.steamId));
  if (arrivals.length === 0) {
    s.presentSteamIds = current;
    return [];
  }

  const events: WatchedJoinEvent[] = [];
  for (let i = 0; i < arrivals.length; i += MARKS_BATCH) {
    const batch = arrivals.slice(i, i + MARKS_BATCH);
    const query = new URLSearchParams({
      ids: batch.map((p) => p.steamId).join(','),
      names: batch.map((p) => p.name).join('\n')
    });
    const body = await client.getJson<MarksBody>(`/api/servers/${id}/players/marks?${query}`);
    const watched = new Set(body.marks.filter((m) => m.watched).map((m) => m.steamId));
    for (const p of batch) {
      if (!watched.has(p.steamId)) continue;
      events.push({
        kind: 'watchedJoin',
        serverId,
        at: new Date(now).toISOString(),
        steamId: p.steamId,
        name: p.name
      });
    }
  }

  // Only now that every marks batch answered: recording the roster before the marks
  // calls would let a failed call mark a watched arrival as present, and it would
  // never alert.
  s.presentSteamIds = current;
  return events;
}
