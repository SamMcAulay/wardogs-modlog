import type { HotPlayerEvent, ModEvent, PlayerJoinedEvent } from '../events.js';
import type { MatchState, ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { MarksBody, SummaryBody, SummaryPlayer } from '../warcon-types.js';

/** Players per `players/marks` call. */
export const MARKS_BATCH = 200;

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

  const clock = summary.live.status?.matchSeconds;
  let hot: HotPlayerEvent[] = [];
  if (typeof clock === 'number' && Number.isFinite(clock)) {
    const next = advanceMatch(s.match, players, clock);
    // A cold server posts nothing (base spec §7), so it must not mark anyone alerted
    // either: a player already hot when the bot starts is reported on the first warm cycle.
    if (s.warm) hot = hotPlayers(serverId, next, players, clock, cfg, at);
    s.match = next;
  }
  // A null clock (an idle server, or a build that doesn't report one) means no live
  // check this cycle, and the match state is neither advanced nor cleared (spec §3.2).

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
    const watched = new Set(body.marks.filter((m) => m.watched).map((m) => m.steamId));
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
        ...(tags.sweat && known?.sweat ? { sweatStats: known.sweat } : {}),
        ...(tags.highKd && known?.highKd ? { highKdStats: known.highKd } : {})
      });
    }
  }
  return events;
}

/**
 * The match state after this cycle's observation (spec §3.1, §3.2). Pure: the caller
 * commits it only once every read has answered.
 */
function advanceMatch(m: MatchState, players: SummaryPlayer[], clock: number): MatchState {
  // A lower clock than last seen is a new match; no match seen yet is also a first
  // observation. Either way, everyone present is assumed to have been there from the
  // start, which can only make their time longer and their rate lower.
  const newMatch = m.lastMatchSeconds !== null && clock < m.lastMatchSeconds;
  const firstObservation = m.lastMatchSeconds === null || newMatch;
  const firstSeen = newMatch ? {} : { ...m.firstSeen };
  // A newcomer in a match already observed joined some time after the last observation,
  // and their scoreboard kills cover their whole stay. Dating them from that observation,
  // not from now, keeps a gap (an outage, a restart, a run of failed reads) from
  // shortening their time and overstating their rate.
  const joinedBy = firstObservation ? 0 : (m.lastMatchSeconds ?? clock);
  for (const p of players) {
    // A reconnect keeps its original firstSeen.
    if (!(p.steamId in firstSeen)) firstSeen[p.steamId] = joinedBy;
  }
  return { lastMatchSeconds: clock, firstSeen, alerted: newMatch ? [] : [...m.alerted] };
}

/** Players over all three live thresholds, once per match (spec §3). Adds them to `m.alerted`. */
function hotPlayers(
  serverId: string,
  m: MatchState,
  players: SummaryPlayer[],
  clock: number,
  cfg: PresenceConfig,
  at: string
): HotPlayerEvent[] {
  const events: HotPlayerEvent[] = [];
  for (const p of players) {
    if (m.alerted.includes(p.steamId)) continue;
    // A build whose scoreboard lacks the counts gives nothing to judge.
    if (typeof p.kills !== 'number' || !Number.isFinite(p.kills)) continue;
    const minutes = (clock - (m.firstSeen[p.steamId] ?? clock)) / 60;
    if (minutes <= 0 || minutes < cfg.liveMinMinutes) continue;
    if (p.kills < cfg.liveMinKills) continue;
    const perHour = p.kills / (minutes / 60);
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
      minutes,
      perHour
    });
  }
  return events;
}
