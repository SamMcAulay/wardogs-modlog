import type { HotPlayerEvent, ModEvent, PlayerJoinedEvent } from '../events.js';
import type { Baseline, MatchState, ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { MarksBody, SummaryBody, SummaryPlayer } from '../warcon-types.js';

/** Players per `players/marks` call. */
export const MARKS_BATCH = 200;

/**
 * A longer gap between observations than this (an outage, a restart, a run of failed
 * reads) starts the live check over: whatever happened in it can't be timed.
 */
export const LIVE_STALE_MS = 10 * 60_000;

export interface PresenceConfig {
  /** LIVE_PER_HOUR */
  livePerHour: number;
  /** LIVE_MIN_MINUTES */
  liveMinMinutes: number;
  /** LIVE_MIN_KILLS */
  liveMinKills: number;
}

/**
 * Who is on the server now (live-alerts spec §3, §4.2, §6): one summary read per cycle
 * yields both the join alerts and the "hot right now" check.
 *
 * Nothing in the server entry changes until every read has answered: a failed marks
 * call throws with the roster and the match state untouched, so the next cycle sees the
 * same arrivals and the same hot players again rather than losing them.
 */
export async function pollPresence(
  client: WarconClient,
  serverId: string,
  s: ServerState,
  cfg: PresenceConfig,
  now: number
): Promise<ModEvent[]> {
  const id = encodeURIComponent(serverId);
  const summary = await client.getJson<SummaryBody>(`/api/servers/${id}/summary`);
  // No live data, or a live read the panel itself marks failed, says nothing about who is
  // on the server. Treating it as an empty roster would re-report everyone as joining on
  // the next good read, so leave the roster and the match exactly as they were.
  if (!summary.live || !summary.live.ok) return [];
  const players = summary.live.players ?? [];
  const at = new Date(now).toISOString();

  const joins = await joinEvents(client, serverId, s, players, at);

  const next = advanceMatch(s.match, players, summary.live.status?.map ?? null, now);
  // A cold server posts nothing (base spec §7), so it must not mark anyone alerted
  // either: a player already hot when the bot starts is reported on the first warm cycle.
  const hot = s.warm ? hotPlayers(serverId, next, players, cfg, now, at) : [];
  s.match = next;

  // Only now that every marks batch answered: recording the roster before the marks
  // calls would let a failed call mark an arrival as present, and it would never alert.
  s.presentSteamIds = players.map((p) => p.steamId);
  return [...joins, ...hot];
}

/** Arrivals since the last roster, tagged by the watchlist and the known lists (spec §4.2). */
async function joinEvents(
  client: WarconClient,
  serverId: string,
  s: ServerState,
  players: SummaryPlayer[],
  at: string
): Promise<PlayerJoinedEvent[]> {
  const previous = new Set(s.presentSteamIds);
  const arrivals = players.filter((p) => !previous.has(p.steamId));
  const sweats = new Set(s.knownSweats);
  const highKd = new Set(s.knownHighKd);
  const id = encodeURIComponent(serverId);

  const events: PlayerJoinedEvent[] = [];
  for (let i = 0; i < arrivals.length; i += MARKS_BATCH) {
    const batch = arrivals.slice(i, i + MARKS_BATCH);
    const query = new URLSearchParams({
      ids: batch.map((p) => p.steamId).join(','),
      names: batch.map((p) => p.name).join('\n')
    });
    const body = await client.getJson<MarksBody>(`/api/servers/${id}/players/marks?${query}`);
    // steamId -> watch reason ('' when none is recorded, or the key can't read it)
    const watched = new Map(body.marks.filter((m) => m.watched).map((m) => [m.steamId, m.reason ?? '']));
    for (const p of batch) {
      const tags = {
        watched: watched.has(p.steamId),
        sweat: sweats.has(p.steamId),
        highKd: highKd.has(p.steamId)
      };
      if (!tags.watched && !tags.sweat && !tags.highKd) continue;
      // The numbers that put them on each list, for the embed. Only for a tag they carry.
      const known = s.knownStats[p.steamId];
      events.push({
        kind: 'playerJoined',
        serverId,
        at,
        steamId: p.steamId,
        name: p.name,
        ...tags,
        ...(watched.get(p.steamId) ? { watchReason: watched.get(p.steamId) } : {}),
        ...(tags.sweat && known?.sweat ? { sweatStats: known.sweat } : {}),
        ...(tags.highKd && known?.highKd ? { highKdStats: known.highKd } : {})
      });
    }
  }
  return events;
}

/** Whether the scoreboard gives a kill count to judge; some builds leave it out. */
const hasKills = (p: SummaryPlayer): boolean => typeof p.kills === 'number' && Number.isFinite(p.kills);

/**
 * The match state after this cycle's observation (live-alerts spec §3.1, §3.2). Pure:
 * the caller commits it only once every read has answered.
 *
 * Every baseline is chosen so a rate can only be understated, never overstated:
 * - With nothing recent to go on (the first observation, or a gap over LIVE_STALE_MS)
 *   nobody's kills can be dated, so counting starts now, from the kills they have.
 * - A count that began since the last observation (a newcomer, a scoreboard that went
 *   down, a new map) is dated from that observation, from zero. They began some time
 *   after it, so their time can only be longer than it really was.
 * - Otherwise a player keeps the baseline they had, even across a disconnect: a
 *   reconnect whose kills were kept must not be re-dated with those kills counted.
 */
function advanceMatch(
  m: MatchState,
  players: SummaryPlayer[],
  map: string | null,
  now: number
): MatchState {
  const counted = players.filter(hasKills);
  const fresh = m.lastSeenAt === null || now - m.lastSeenAt > LIVE_STALE_MS;
  if (fresh) {
    const baselines: Record<string, Baseline> = {};
    for (const p of counted) baselines[p.steamId] = { at: now, kills: p.kills, last: p.kills };
    return { lastSeenAt: now, map, baselines, alerted: [] };
  }

  const since = m.lastSeenAt!;
  // A new match: the map changed, or most of those still here went down on the scoreboard.
  const continuing = counted.filter((p) => p.steamId in m.baselines);
  const dropped = continuing.filter((p) => p.kills < m.baselines[p.steamId]!.last);
  const newMatch =
    (map !== null && m.map !== null && map !== m.map) || (dropped.length > 0 && dropped.length * 2 > continuing.length);

  const baselines: Record<string, Baseline> = newMatch ? {} : { ...m.baselines };
  const alerted = new Set(newMatch ? [] : m.alerted);
  for (const p of counted) {
    const prev = baselines[p.steamId];
    if (prev && p.kills >= prev.last) {
      baselines[p.steamId] = { ...prev, last: p.kills };
    } else {
      // A reset scoreboard on its own (a reconnect that lost its kills) is a fresh count,
      // so that player can be reported again.
      if (prev) alerted.delete(p.steamId);
      baselines[p.steamId] = { at: since, kills: 0, last: p.kills };
    }
  }
  return { lastSeenAt: now, map: map ?? m.map, baselines, alerted: [...alerted] };
}

/** Players over all three live thresholds, once per match (spec §3). Adds them to `m.alerted`. */
function hotPlayers(
  serverId: string,
  m: MatchState,
  players: SummaryPlayer[],
  cfg: PresenceConfig,
  now: number,
  at: string
): HotPlayerEvent[] {
  const events: HotPlayerEvent[] = [];
  for (const p of players) {
    if (m.alerted.includes(p.steamId) || !hasKills(p)) continue;
    const b = m.baselines[p.steamId];
    if (!b) continue;
    const minutes = (now - b.at) / 60_000;
    if (minutes <= 0 || minutes < cfg.liveMinMinutes) continue;
    const measuredKills = p.kills - b.kills;
    if (measuredKills < cfg.liveMinKills) continue;
    const perHour = measuredKills / (minutes / 60);
    if (perHour < cfg.livePerHour) continue;
    m.alerted.push(p.steamId);
    events.push({
      kind: 'hotPlayer',
      serverId,
      at,
      steamId: p.steamId,
      name: p.name,
      kills: p.kills,
      deaths: typeof p.deaths === 'number' ? p.deaths : 0,
      measuredKills,
      minutes,
      perHour
    });
  }
  return events;
}
