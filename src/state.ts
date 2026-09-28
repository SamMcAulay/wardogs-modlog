import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { KdStats, SweatStats } from './events.js';

/** Per-server ring of recently seen kill event ids (spec §7). */
export const SEEN_KILL_CAP = 500;

/** The current match on one server, for the live "hot right now" check (live-alerts spec §3.3). */
export interface MatchState {
  /** newest `status.matchSeconds` seen; a decrease means a new match. null = none observed yet */
  lastMatchSeconds: number | null;
  /** steamId -> match clock when the bot first saw that player in this match */
  firstSeen: Record<string, number>;
  /** steamIds already posted as hot this match */
  alerted: string[];
}

export function emptyMatch(): MatchState {
  return { lastMatchSeconds: null, firstSeen: {}, alerted: [] };
}

export interface ServerState {
  /** newest first, capped at SEEN_KILL_CAP */
  seenKillIds: string[];
  /** high-water audit row id */
  lastAuditId: number;
  /** last observed player list, for join detection */
  presentSteamIds: string[];
  /** ISO time of the last kill-feed batch Warcon reported */
  lastFeedAt: string | null;
  /** newest match-clock value seen; a decrease means a new match */
  lastEventTime: number;
  /** steamId -> team kills in the current match */
  teamKills: Record<string, number>;
  /** whether a feed-quiet warning is currently outstanding */
  feedQuietWarned: boolean;
  /** ISO time the server last transitioned to empty, or null (spec §8.4) */
  lastEmptyAt: string | null;
  /**
   * Retry identities (runner.ts's `retryKey`) of decisions that posted successfully
   * earlier in a cycle that later failed. Scoped to a single retry: the runner clears
   * it once a cycle for this server completes with no post failure and every source
   * succeeding.
   */
  postedBeforeFailure: string[];
  /**
   * Whether this server has completed a cycle in which its cursored sources (kills,
   * audit, presence) all succeeded. Until then the runner records position and posts
   * nothing (spec §7). Persisted, and false by default, so a new server id and an
   * entry from an older state file both come up cold.
   */
  warm: boolean;
  /** The live check's view of the current match. Part of the entry, so a failed post
   *  rolls it back with everything else (live-alerts spec §3.3). */
  match: MatchState;
  /** steamIds over the sweat line, refreshed hourly by the known source (live-alerts spec §4.1) */
  knownSweats: string[];
  /** steamIds over the K/D line, refreshed with knownSweats */
  knownHighKd: string[];
  /** steamId -> the numbers that put them on either list, refreshed with both, so a join
   *  alert can show them */
  knownStats: Record<string, { sweat?: SweatStats; highKd?: KdStats }>;
  /** epoch ms of the last successful refresh of both lists, or null if never */
  knownAt: number | null;
}

export interface State {
  version: 1;
  servers: Record<string, ServerState>;
  /** steamId -> epoch ms of the last join alert that carried a sweat or high-K/D tag.
   *  Global across servers (live-alerts spec §4.3). */
  joinAlerted: Record<string, number>;
  startedAt: number;
}

export function emptyServerState(): ServerState {
  return {
    seenKillIds: [],
    lastAuditId: 0,
    presentSteamIds: [],
    lastFeedAt: null,
    lastEventTime: 0,
    teamKills: {},
    feedQuietWarned: false,
    lastEmptyAt: null,
    postedBeforeFailure: [],
    warm: false,
    match: emptyMatch(),
    knownSweats: [],
    knownHighKd: [],
    knownStats: {},
    knownAt: null
  };
}

export function emptyState(): State {
  return {
    version: 1,
    servers: {},
    joinAlerted: {},
    startedAt: Date.now()
  };
}

/** The entry for a server, created zeroed on first use. */
export function serverState(state: State, serverId: string): ServerState {
  const existing = state.servers[serverId];
  if (existing) return existing;
  const fresh = emptyServerState();
  state.servers[serverId] = fresh;
  return fresh;
}

/**
 * Prepend ids, preserving their order, skipping duplicates, evicting past the cap.
 *
 * `ids` arrives newest-first (the kills API's own order) and the ring is
 * newest-first, so the batch is prepended as a block. Unshifting one at a time in a
 * loop would reverse the batch and leave its OLDEST entry at the front.
 */
export function rememberKillIds(s: ServerState, ids: string[]): void {
  const known = new Set(s.seenKillIds);
  const fresh: string[] = [];
  for (const id of ids) {
    if (known.has(id)) continue;
    known.add(id);
    fresh.push(id);
  }
  s.seenKillIds = [...fresh, ...s.seenKillIds];
  if (s.seenKillIds.length > SEEN_KILL_CAP) s.seenKillIds.length = SEEN_KILL_CAP;
}

export async function loadState(path: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return emptyState();
  }

  try {
    // An older file may still carry kdAlerted, rateAlerted and baselines (retired by the
    // live-alerts spec §8); building the state field by field drops them.
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed.version !== 1) throw new Error(`unsupported state version ${parsed.version}`);
    return {
      version: 1,
      servers: Object.fromEntries(
        Object.entries(parsed.servers ?? {}).map(([id, s]) => [
          id,
          {
            ...emptyServerState(),
            ...s,
            match: { ...emptyMatch(), ...(s.match ?? {}) }
          }
        ])
      ),
      joinAlerted: parsed.joinAlerted ?? {},
      startedAt: parsed.startedAt ?? Date.now()
    };
  } catch {
    // Keep the bad file for diagnosis rather than overwriting it.
    await rename(path, `${path}.corrupt`).catch(() => undefined);
    return emptyState();
  }
}

/** Write to a temp file in the same directory, then rename — rename is atomic. */
export async function saveState(path: string, state: State): Promise<void> {
  const tmp = join(dirname(path), `${basename(path)}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);
}
