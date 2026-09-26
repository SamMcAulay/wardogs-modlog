import type { KillRateEvent, ModEvent } from '../events.js';
import { BASELINE_TTL_MS, type State } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { BoardBody, BoardRow, DossierBody } from '../warcon-types.js';

export interface KillRateConfig {
  sweatPerHour: number;
  sweatRange: string;
  surgeRange: string;
  surgePerHour: number;
  surgeRatio: number;
  surgeHistoryMinutes: number;
  /** RATE_MIN_MINUTES: playtime needed inside each range */
  minMinutes: number;
}

/** Rows per leaderboard page; Warcon serves fifty. */
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4;
/** Dossier reads per server per run — keeps the bot inside Warcon's 120/min (spec §4). */
export const LOOKUPS_PER_RUN = 10;

/** Kills per hour, computed here so thresholds never depend on the panel's rounding. */
export const perHour = (kills: number, minutes: number): number =>
  minutes > 0 ? kills / (minutes / 60) : 0;

/**
 * Warcon's own `perHour`, seeding time left out: what the panel shows and sorts by.
 * Sweats use it (tiered-alerts spec §3).
 */
export const panelRate = (r: BoardRow): number => perHour(r.kills, r.minutes - (r.seedMinutes ?? 0));

/**
 * The rate with seeding left in. Surges use it, because the dossier's usual rate includes
 * seeding and a ratio must compare like with like (spec §4). Never above `panelRate`.
 */
const inclusiveRate = (r: BoardRow): number => perHour(r.kills, r.minutes);

/**
 * Leaderboard rows whose panel rate is at or above `floor`.
 *
 * Pages follow Warcon's sort, so the stop test uses the same seed-excluded rate: a page
 * whose last row is still at or above the floor by the panel's figure may be followed by
 * more rows that are, and paging on any other rate could stop early.
 */
async function hotRows(
  client: WarconClient,
  serverId: string,
  range: string,
  minMinutes: number,
  floor: number
): Promise<BoardRow[]> {
  const out: BoardRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      scope: 'server',
      range,
      sort: 'perHour',
      dir: 'desc',
      minMinutes: String(minMinutes),
      page: String(page)
    });
    const { rows } = await client.getJson<BoardBody>(
      `/api/servers/${encodeURIComponent(serverId)}/leaderboard?${query}`
    );
    out.push(...rows.filter((r) => panelRate(r) >= floor));
    const last = rows[rows.length - 1];
    if (rows.length < PAGE_SIZE || !last || panelRate(last) < floor) break;
  }
  return out;
}

/**
 * Tier 3: sweats (a sustained high rate) and surges (a recent rate well above the
 * player's own usual on this server), merged into one event per player
 * (tiered-alerts spec §3–§5).
 *
 * Usual rates come from the player's dossier and are cached in `state.baselines` for a
 * day; a run reads at most LOOKUPS_PER_RUN uncached ones, highest recent rate first, so
 * a busy server's later candidates are reached on the following runs. Any failed read
 * fails the whole source: the runner logs it and the next hourly run retries.
 */
export async function pollKillRate(
  client: WarconClient,
  serverId: string,
  state: State,
  cfg: KillRateConfig,
  now: number
): Promise<ModEvent[]> {
  const at = new Date(now).toISOString();
  const sweats = (
    await hotRows(client, serverId, cfg.sweatRange, cfg.minMinutes, cfg.sweatPerHour)
  ).sort((a, b) => panelRate(b) - panelRate(a));
  // Paged on the panel's rate (never below the inclusive one), then held to the floor
  // by the seed-inclusive rate the surge itself compares.
  const recent = (await hotRows(client, serverId, cfg.surgeRange, cfg.minMinutes, cfg.surgePerHour))
    .filter((r) => inclusiveRate(r) >= cfg.surgePerHour)
    .sort((a, b) => inclusiveRate(b) - inclusiveRate(a));

  const byPlayer = new Map<string, KillRateEvent>();
  const eventFor = (r: BoardRow): KillRateEvent => {
    let e = byPlayer.get(r.steamId);
    if (!e) {
      e = { kind: 'killRate', serverId, at, steamId: r.steamId, name: r.name, sweat: null, surge: null };
      byPlayer.set(r.steamId, e);
    }
    return e;
  };

  for (const r of sweats) {
    eventFor(r).sweat = { perHour: panelRate(r), kills: r.kills, minutes: r.minutes, range: cfg.sweatRange };
  }

  let lookups = 0;
  for (const r of recent) {
    const key = `${serverId}:${r.steamId}`;
    let usual = state.baselines[key];
    if (!usual || now - usual.at >= BASELINE_TTL_MS) {
      if (lookups >= LOOKUPS_PER_RUN) continue; // reached on a later run
      lookups++;
      const { dossier } = await client.getJson<DossierBody>(
        `/api/servers/${encodeURIComponent(serverId)}/players/${encodeURIComponent(r.steamId)}`
      );
      const here = dossier.perServer.find((p) => p.serverId === serverId);
      usual = {
        perHour: here ? perHour(here.kills, here.minutes) : 0,
        minutes: here?.minutes ?? 0,
        at: now
      };
      state.baselines[key] = usual;
    }

    if (usual.minutes < cfg.surgeHistoryMinutes) continue; // too little history to compare
    const recentRate = inclusiveRate(r);
    const ratio = usual.perHour > 0 ? recentRate / usual.perHour : Infinity;
    if (ratio < cfg.surgeRatio) continue;
    eventFor(r).surge = {
      perHour: recentRate,
      minutes: r.minutes,
      usualPerHour: usual.perHour,
      usualMinutes: usual.minutes,
      ratio,
      range: cfg.surgeRange
    };
  }

  return [...byPlayer.values()];
}
