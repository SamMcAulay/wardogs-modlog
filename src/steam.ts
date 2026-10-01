/**
 * The Steam Web API, for the three playtime figures Warcon doesn't keep: every hour on
 * record, the most-played game, and hours in Wardogs. A private profile's game list comes
 * back empty, which reads as hidden rather than as zero hours.
 */

const API = 'https://api.steampowered.com';

/**
 * Tools that run alongside a game rather than being played, so their hours would double-count:
 * crosshair overlays, upscalers, wallpaper, recording, soundboards, FPS overlays, desktop pets.
 * `STEAM_IGNORE_APP_IDS` replaces this list.
 */
export const DEFAULT_IGNORED_APP_IDS: readonly number[] = [
  1366800, // Crosshair X
  2641350, // YoloX - Crosshair Overlay
  1477830, // HudSight - crosshair overlay
  431960, // Wallpaper Engine
  993090, // Lossless Scaling
  1905180, // OBS Studio
  629520, // Soundpad
  966610, // FPS Monitor
  3301060 // Desktop Mate
];

/**
 * Competitive games whose hours alone make a player a Steam veteran on joining.
 * `STEAM_COMPETITIVE_APP_IDS` replaces this list.
 */
export const DEFAULT_COMPETITIVE_APP_IDS: readonly number[] = [
  730, // Counter-Strike 2
  359550, // Tom Clancy's Rainbow Six Siege
  252490, // Rust
  570, // Dota 2
  578080, // PUBG: Battlegrounds
  1172470, // Apex Legends
  393380, // Squad
  686810, // Hell Let Loose
  594650, // Hunt: Showdown
  581320, // Insurgency: Sandstorm
  107410, // Arma 3
  2357570, // Overwatch 2
  1422450, // Deadlock
  2073850, // THE FINALS
  2767030, // Marvel Rivals
  1517290 // Battlefield 2042
];

export interface OwnedGame {
  appid: number;
  name?: string;
  /** minutes */
  playtime_forever: number;
}

export interface Playtime {
  /** minutes across every owned game, the ignored tools left out */
  totalMinutes: number;
  /** minutes in the ignored tools, left out of the total and the top game */
  ignoredMinutes: number;
  top: { name: string; minutes: number } | null;
  /** null when Wardogs isn't in the list */
  wardogsMinutes: number | null;
}

/** null: the profile hides its games (Steam then sends no list at all). Wardogs is never ignored. */
export function playtimeOf(
  games: OwnedGame[] | undefined,
  wardogsAppId: number,
  ignored: ReadonlySet<number> = new Set()
): Playtime | null {
  if (!games) return null;
  let total = 0;
  let skipped = 0;
  let top: OwnedGame | null = null;
  let wardogs: number | null = null;
  for (const g of games) {
    if (g.appid === wardogsAppId) wardogs = g.playtime_forever;
    else if (ignored.has(g.appid)) {
      skipped += g.playtime_forever;
      continue;
    }
    total += g.playtime_forever;
    if (!top || g.playtime_forever > top.playtime_forever) top = g;
  }
  return {
    totalMinutes: total,
    ignoredMinutes: skipped,
    top: top && top.playtime_forever > 0 ? { name: top.name ?? `app ${top.appid}`, minutes: top.playtime_forever } : null,
    wardogsMinutes: wardogs
  };
}

export interface VeteranConfig {
  /** STEAM_TOTAL_HOURS: hours across every game, the ignored tools left out. 0 turns it off */
  totalHours: number;
  /** STEAM_GAME_HOURS: hours in any one of `competitive`. 0 turns it off */
  gameHours: number;
  competitive: ReadonlySet<number>;
  ignored: ReadonlySet<number>;
}

/** What made a player a Steam veteran: one or both of the lines they crossed. */
export interface VeteranStats {
  /** minutes across every game, set when over STEAM_TOTAL_HOURS */
  totalMinutes?: number;
  /** their most-played competitive game, set when over STEAM_GAME_HOURS */
  game?: { name: string; minutes: number };
}

/** The lines a game list crosses, or null for none (or a hidden list). */
export function veteranOf(games: OwnedGame[] | undefined, cfg: VeteranConfig): VeteranStats | null {
  if (!games) return null;
  let total = 0;
  let game: OwnedGame | null = null;
  for (const g of games) {
    if (cfg.ignored.has(g.appid)) continue;
    total += g.playtime_forever;
    if (cfg.competitive.has(g.appid) && (!game || g.playtime_forever > game.playtime_forever)) game = g;
  }
  const out: VeteranStats = {};
  if (cfg.totalHours > 0 && total >= cfg.totalHours * 60) out.totalMinutes = total;
  if (game && cfg.gameHours > 0 && game.playtime_forever >= cfg.gameHours * 60) {
    out.game = { name: game.name ?? `app ${game.appid}`, minutes: game.playtime_forever };
  }
  return out.totalMinutes === undefined && !out.game ? null : out;
}

/** Steam lookups at once when a crowd arrives together (a server filling after a restart). */
const VETERAN_CONCURRENCY = 4;

/**
 * Which arrivals are Steam veterans, remembered for `ttlMs` so a reconnect doesn't ask
 * Steam again. A lookup that fails reads as not a veteran and is not remembered, so the
 * next join asks again; it never holds up the rest of the join alert.
 */
export class VeteranChecker {
  private readonly cache = new Map<string, { at: number; stats: VeteranStats | null }>();

  constructor(
    private readonly steam: Pick<SteamClient, 'ownedGames'>,
    private readonly cfg: VeteranConfig,
    private readonly ttlMs: number,
    private readonly warn: (message: string) => void = () => undefined
  ) {}

  async check(steamIds: string[], now: number): Promise<Map<string, VeteranStats>> {
    for (const [id, hit] of this.cache) if (now - hit.at >= this.ttlMs) this.cache.delete(id);
    const out = new Map<string, VeteranStats>();
    const todo = steamIds.filter((id) => {
      const hit = this.cache.get(id);
      if (hit?.stats) out.set(id, hit.stats);
      return !hit;
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const id = todo[next++]!;
        try {
          const stats = veteranOf(await this.steam.ownedGames(id), this.cfg);
          this.cache.set(id, { at: now, stats });
          if (stats) out.set(id, stats);
        } catch (err) {
          this.warn(`steam veteran check for ${id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(VETERAN_CONCURRENCY, todo.length) }, worker));
    return out;
  }
}

export class SteamClient {
  constructor(
    private readonly opts: { apiKey: string; timeoutMs?: number; fetchImpl?: typeof fetch }
  ) {}

  /**
   * The key rides in the query string, so errors name the method and status only, never
   * the URL: they end up in Discord replies and the log.
   */
  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const query = new URLSearchParams({ key: this.opts.apiKey, format: 'json', ...params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await doFetch(`${API}/${method}/?${query}`, { signal: controller.signal });
    } catch {
      throw new Error(`steam ${method} did not answer`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new Error('steam rejected STEAM_API_KEY');
    if (!res.ok) throw new Error(`steam ${method} failed (${res.status})`);
    return (await res.json()) as T;
  }

  /** Every owned game with its playtime; undefined when the profile hides them. */
  async ownedGames(steamId: string): Promise<OwnedGame[] | undefined> {
    const body = await this.call<{ response?: { games?: OwnedGame[] } }>('IPlayerService/GetOwnedGames/v1', {
      steamid: steamId,
      include_appinfo: '1',
      include_played_free_games: '1'
    });
    return body.response?.games;
  }

  async playtime(steamId: string, wardogsAppId: number, ignored?: ReadonlySet<number>): Promise<Playtime | null> {
    return playtimeOf(await this.ownedGames(steamId), wardogsAppId, ignored);
  }

  /** A custom profile URL's name to its SteamID64, or null when no profile has it. */
  async resolveVanity(name: string): Promise<string | null> {
    const body = await this.call<{ response?: { success?: number; steamid?: string } }>(
      'ISteamUser/ResolveVanityURL/v1',
      { vanityurl: name }
    );
    return body.response?.success === 1 && body.response.steamid ? body.response.steamid : null;
  }
}
