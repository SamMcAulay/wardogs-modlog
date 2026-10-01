import type { BoardHit } from '../board-cache.js';
import type { HotHistory, HotPlayerEvent, ModEvent, PlayerJoinedEvent } from '../events.js';
import type { Baseline, MatchState, ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { MarksBody, SummaryBody, SummaryPlayer } from '../warcon-types.js';
import type { VeteranChecker } from '../steam.js';

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
  /** LIVE_ESTABLISHED_HOURS: on record for this long, a player is judged against their own history */
  liveEstablishedHours: number;
  /** LIVE_SPIKE_RATIO: how far over their own kills/hour and K/D a regular must be */
  liveSpikeRatio: number;
  /** a player's all-time record; unset, every hot player alerts unjudged */
  history?: (steamId: string) => Promise<BoardHit>;
  /** tags arrivals who are Steam veterans; unset (no STEAM_API_KEY) tags nobody */
  veterans?: Pick<VeteranChecker, 'check'>;
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

  const joins = await joinEvents(client, serverId, s, players, at, cfg.veterans, now);

  const next = advanceMatch(s.match, players, summary.live.status?.map ?? null, now);
  // A cold server posts nothing (base spec §7), so it must not mark anyone alerted
  // either: a player already hot when the bot starts is reported on the first warm cycle.
  const hot = s.warm ? await hotPlayers(serverId, next, players, cfg, now, at) : [];
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
  at: string,
  veteranChecker: PresenceConfig['veterans'],
  now: number
): Promise<PlayerJoinedEvent[]> {
  const previous = new Set(s.presentSteamIds);
  const arrivals = players.filter((p) => !previous.has(p.steamId));
  const sweats = new Set(s.knownSweats);
  const highKd = new Set(s.knownHighKd);
  const id = encodeURIComponent(serverId);

  // Never throws: a Steam lookup that fails just leaves that arrival untagged.
  const veterans = veteranChecker && arrivals.length > 0
    ? await veteranChecker.check(arrivals.map((p) => p.steamId), now)
    : new Map();

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
        highKd: highKd.has(p.steamId),
        steamVeteran: veterans.has(p.steamId)
      };
      if (!tags.watched && !tags.sweat && !tags.highKd && !tags.steamVeteran) continue;
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
        ...(tags.highKd && known?.highKd ? { highKdStats: known.highKd } : {}),
        ...(tags.steamVeteran ? { veteranStats: veterans.get(p.steamId) } : {})
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

/**
 * Whether a player over the live thresholds stands out from their own record (spec §3.4),
 * and the record to show. null: a regular doing what they usually do, or close enough —
 * a good run, not an alert. Anyone new or off the record always alerts.
 */
export function judgeHot(
  match: { perHour: number; kills: number; deaths: number },
  hit: BoardHit,
  cfg: Pick<PresenceConfig, 'liveEstablishedHours' | 'liveSpikeRatio'>
): HotHistory | null {
  const row = hit.row;
  if (!row) return { kind: 'new', minutes: null };
  // Seeding is left out, as the panel's own rate does.
  const played = row.minutes - row.seedMinutes;
  if (played <= 0 || played < cfg.liveEstablishedHours * 60) return { kind: 'new', minutes: Math.max(played, 0) };
  const perHour = row.kills / (played / 60);
  const kd = row.kills / Math.max(row.deaths, 1);
  const matchKd = match.kills / Math.max(match.deaths, 1);
  // Both, not either: a streak lifts one easily, and a regular's K/D swings with every death.
  const spike = match.perHour >= cfg.liveSpikeRatio * perHour && matchKd >= cfg.liveSpikeRatio * kd;
  return spike ? { kind: 'regular', minutes: played, perHour, kd } : null;
}

/**
 * Players over all three live thresholds who also stand out from their own record, once
 * per match (spec §3). Adds them to `m.alerted`. A regular judged ordinary is not marked,
 * so a run that keeps climbing is judged again next cycle; the board is cached, so that
 * costs no request.
 */
async function hotPlayers(
  serverId: string,
  m: MatchState,
  players: SummaryPlayer[],
  cfg: PresenceConfig,
  now: number,
  at: string
): Promise<HotPlayerEvent[]> {
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
    const deaths = typeof p.deaths === 'number' ? p.deaths : 0;
    let history: HotHistory | null;
    try {
      history = cfg.history
        ? judgeHot({ perHour, kills: p.kills, deaths }, await cfg.history(p.steamId), cfg)
        : { kind: 'unavailable' };
    } catch {
      // An unreadable board must not silence the alert it was meant to qualify.
      history = { kind: 'unavailable' };
    }
    if (!history) continue;
    m.alerted.push(p.steamId);
    events.push({
      kind: 'hotPlayer',
      serverId,
      at,
      steamId: p.steamId,
      name: p.name,
      kills: p.kills,
      deaths,
      measuredKills,
      minutes,
      perHour,
      history
    });
  }
  return events;
}
