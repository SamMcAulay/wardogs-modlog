import type { ModEvent, TeamKillEvent } from '../events.js';
import { rememberKillIds, type ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { KillsBody } from '../warcon-types.js';

export interface KillsPollOptions {
  feedQuietMinutes: number;
  now: number;
}

const PAGE_LIMIT = 200;

/**
 * Team kills since the last cycle, plus a feed-health warning.
 *
 * The API returns newest first and offers no "everything after X" parameter
 * (spec §5.1), so we take the newest page, walk back to the first id we already
 * know, and reverse what remains into chronological order — escalate() counts in
 * order, and a reversed page would attribute the third team kill to the wrong event.
 */
export async function pollKills(
  client: WarconClient,
  serverId: string,
  s: ServerState,
  opts: KillsPollOptions
): Promise<ModEvent[]> {
  const body = await client.getJson<KillsBody>(
    `/api/servers/${encodeURIComponent(serverId)}/kills?kind=teamKill&limit=${PAGE_LIMIT}`
  );

  const fresh: TeamKillEvent[] = [];
  for (const k of body.kills) {
    if (s.seenKillIds.includes(k.eventId)) break; // everything older is known
    if (!k.killer) continue; // the environment cannot team kill
    fresh.push({
      kind: 'teamKill',
      serverId,
      at: k.ts,
      eventId: k.eventId,
      eventTime: k.eventTime,
      killer: k.killer,
      victim: k.victim,
      cause: k.cause,
      distanceM: k.distanceM,
      count: 0 // escalate() replaces this
    });
  }

  rememberKillIds(s, body.kills.map((k) => k.eventId));

  const events: ModEvent[] = fresh.reverse();

  // Feed health (spec §8.4).
  const advanced = body.feedAt !== null && body.feedAt !== s.lastFeedAt;
  if (advanced) {
    s.lastFeedAt = body.feedAt;
    s.feedQuietWarned = false;
  } else if (s.presentSteamIds.length === 0) {
    // Server is empty; record when that happened, never warn.
    s.lastEmptyAt = new Date(opts.now).toISOString();
  } else if (body.configured && !s.feedQuietWarned) {
    // Players present, configured, not yet warned: measure quiet from the later of lastFeedAt and lastEmptyAt.
    const lastFeed = s.lastFeedAt ? Date.parse(s.lastFeedAt) : null;
    const lastEmpty = s.lastEmptyAt ? Date.parse(s.lastEmptyAt) : null;
    const quietFrom = lastFeed === null && lastEmpty === null ? null : Math.max(lastFeed ?? 0, lastEmpty ?? 0);
    const quietFor = quietFrom === null ? Infinity : opts.now - quietFrom;
    if (quietFor > opts.feedQuietMinutes * 60_000) {
      s.feedQuietWarned = true;
      events.push({
        kind: 'feedQuiet',
        serverId,
        at: new Date(opts.now).toISOString(),
        lastFeedAt: s.lastFeedAt
      });
    }
  }

  return events;
}
