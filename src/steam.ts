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

  async playtime(steamId: string, wardogsAppId: number, ignored?: ReadonlySet<number>): Promise<Playtime | null> {
    const body = await this.call<{ response?: { games?: OwnedGame[] } }>('IPlayerService/GetOwnedGames/v1', {
      steamid: steamId,
      include_appinfo: '1',
      include_played_free_games: '1'
    });
    return playtimeOf(body.response?.games, wardogsAppId, ignored);
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
