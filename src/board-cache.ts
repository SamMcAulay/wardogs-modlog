import type { WarconClient } from './warcon.js';

/**
 * Warcon has no per-player board, so a lookup's 30-day and seed-excluded lifetime rates come
 * from the organisation's board export: every player in one CSV, read at most once an hour
 * per range and kept in memory. The export is rate-limited (ten a minute per key), which an
 * hour's cache never approaches.
 */

export type ExportRange = '30d' | 'all';

export interface ExportRow {
  minutes: number;
  seedMinutes: number;
  kills: number;
  deaths: number;
  matches: number;
}

/** RFC 4180 rows: quoted cells may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The export's rows by Steam ID. Columns are found by header name, so a reordered export still reads. */
export function parseExport(text: string): Map<string, ExportRow> {
  const [header, ...rows] = parseCsv(text);
  const out = new Map<string, ExportRow>();
  if (!header) return out;
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`board export has no ${name} column`);
    return i;
  };
  const at = {
    steamId: col('steam_id'),
    minutes: col('playtime_min'),
    seedMinutes: col('seeded_min'),
    kills: col('kills'),
    deaths: col('deaths'),
    matches: col('matches')
  };
  const n = (row: string[], i: number): number => Number(row[i]) || 0;
  for (const row of rows) {
    const steamId = row[at.steamId];
    if (!steamId) continue;
    out.set(steamId, {
      minutes: n(row, at.minutes),
      seedMinutes: n(row, at.seedMinutes),
      kills: n(row, at.kills),
      deaths: n(row, at.deaths),
      matches: n(row, at.matches)
    });
  }
  return out;
}

const TTL_MS = 60 * 60 * 1000;

/** Warcon's export stops here (EXPORT_ROWS); a full one has cut off the least-played. */
export const EXPORT_CAP = 10_000;

export interface BoardHit {
  /** null: not in the export */
  row: ExportRow | null;
  /**
   * When the export was full: the least playtime (minutes, seeding included) of anyone in it.
   * Anyone missing played at most this much. null: the export held everyone, so missing means
   * no play in the range.
   */
  cutMinutes: number | null;
}

interface Held {
  at: number;
  rows: Map<string, ExportRow>;
  cutMinutes: number | null;
}

/** The playtime sort puts the least-played last; a full export cuts at the smallest there. */
function heldFrom(rows: Map<string, ExportRow>, at: number): Held {
  let cutMinutes: number | null = null;
  if (rows.size >= EXPORT_CAP) {
    for (const r of rows.values()) cutMinutes = cutMinutes === null ? r.minutes : Math.min(cutMinutes, r.minutes);
  }
  return { at, rows, cutMinutes };
}

const hit = (held: Held, steamId: string): BoardHit => ({
  row: held.rows.get(steamId) ?? null,
  cutMinutes: held.cutMinutes
});

export class BoardCache {
  private readonly held = new Map<ExportRange, Held>();
  private readonly loading = new Map<ExportRange, Promise<Held>>();

  constructor(
    private readonly client: WarconClient,
    /** any server of the organisation: the org scope covers every one the key can see */
    private readonly serverId: string,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The player's row over the range, if the export has one. Sorted by playtime, so the
   * export's ten-thousand-row cap drops the least-played, never a regular, and says how
   * little they played. A failed refresh keeps serving the last copy; with none, it throws.
   */
  async row(range: ExportRange, steamId: string): Promise<BoardHit> {
    const held = this.held.get(range);
    if (held && this.now() - held.at < TTL_MS) return hit(held, steamId);
    try {
      return hit(await this.refresh(range), steamId);
    } catch (err) {
      if (held) return hit(held, steamId);
      throw err;
    }
  }

  /** One download at a time per range, however many lookups arrive while it runs. */
  private refresh(range: ExportRange): Promise<Held> {
    const running = this.loading.get(range);
    if (running) return running;
    const query = new URLSearchParams({ scope: 'org', range, sort: 'playtime', dir: 'desc', minMinutes: '0' });
    const load = this.client
      .getCsv(`/api/servers/${encodeURIComponent(this.serverId)}/leaderboard/export?${query}`)
      .then((text) => {
        const held = heldFrom(parseExport(text), this.now());
        this.held.set(range, held);
        return held;
      })
      .finally(() => this.loading.delete(range));
    this.loading.set(range, load);
    return load;
  }
}
