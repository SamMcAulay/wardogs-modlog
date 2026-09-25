import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Per-server ring of recently seen kill event ids (spec §7). */
export const SEEN_KILL_CAP = 500;

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
}

export interface State {
  version: 1;
  servers: Record<string, ServerState>;
  /** steamId -> epoch ms of the last K/D alert */
  kdAlerted: Record<string, number>;
  startedAt: number;
  /** true when no usable state file was found: report nothing this cycle */
  cold: boolean;
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
    lastEmptyAt: null
  };
}

export function emptyState(): State {
  return { version: 1, servers: {}, kdAlerted: {}, startedAt: Date.now(), cold: true };
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
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed.version !== 1) throw new Error(`unsupported state version ${parsed.version}`);
    return {
      version: 1,
      servers: Object.fromEntries(
        Object.entries(parsed.servers ?? {}).map(([id, s]) => [
          id,
          { ...emptyServerState(), ...s }
        ])
      ),
      kdAlerted: parsed.kdAlerted ?? {},
      startedAt: parsed.startedAt ?? Date.now(),
      cold: false
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
  await writeFile(tmp, JSON.stringify({ ...state, cold: undefined }, null, 2), 'utf8');
  await rename(tmp, path);
}
