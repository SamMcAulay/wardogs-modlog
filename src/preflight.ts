import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXPORT_CAP, parseExport } from './board-cache.js';
import { loadConfig, type Config } from './config.js';
import { serverLabel } from './discord.js';
import { CloudflareBlockedError, WarconAuthError, WarconClient } from './warcon.js';
import { SteamClient } from './steam.js';
import type { BoardBody, DossierBody, SummaryBody } from './warcon-types.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Classifies a failure so a missing capability never looks like an empty result. */
function explain(path: string, err: unknown): string {
  if (err instanceof CloudflareBlockedError) return `Cloudflare Access blocked it: ${err.message}`;
  if (err instanceof WarconAuthError) {
    return path.startsWith('/api/audit')
      ? `rejected — this key is missing audit.read, without which kicks and bans silently read as zero rows (${err.message})`
      : `rejected — check the key has server.view on this server (${err.message})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Any real account does: a dossier answers for players never seen, and Steam for public profiles. */
const PROBE_STEAM_ID = '76561197960287930';

export async function checkAll(
  client: WarconClient,
  config: Config,
  discordFetch: (url: string, init: RequestInit) => Promise<Response>,
  steamFetch: typeof fetch = fetch
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const res = await discordFetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${config.discordToken}` }
  }).catch(() => null);
  results.push({
    name: 'discord token',
    ok: !!res?.ok,
    detail: res?.ok ? 'accepted' : `GET /users/@me returned ${res?.status ?? 'no response'}`
  });

  // Existence and visibility only, never permission arithmetic — a channel the
  // bot can't see, or a mod role that no longer exists, both make posting fail
  // silently later (spec §10).
  const channelRes = await discordFetch(`https://discord.com/api/v10/channels/${config.discordChannelId}`, {
    headers: { Authorization: `Bot ${config.discordToken}` }
  }).catch(() => null);

  let channelOk = false;
  let guildId: string | undefined;

  if (channelRes?.ok) {
    const channelBody = (await channelRes.json()) as { name?: string; guild_id?: string };
    guildId = channelBody.guild_id;
    channelOk = true;
    results.push({ name: 'discord channel', ok: true, detail: `visible (#${channelBody.name})` });
  } else {
    results.push({
      name: 'discord channel',
      ok: false,
      detail: `GET /channels/${config.discordChannelId} returned ${channelRes?.status ?? 'no response'} — the bot cannot see that channel`
    });
  }

  if (!channelOk) {
    results.push({ name: 'discord mod role', ok: false, detail: 'skipped — channel not visible' });
  } else {
    const rolesRes = await discordFetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${config.discordToken}` }
    }).catch(() => null);

    if (!rolesRes?.ok) {
      results.push({
        name: 'discord mod role',
        ok: false,
        detail: `GET guild roles returned ${rolesRes?.status ?? 'no response'}`
      });
    } else {
      const roles = (await rolesRes.json()) as Array<{ id: string; name: string }>;
      const role = roles.find((r) => r.id === config.discordModRoleId);
      results.push(
        role
          ? { name: 'discord mod role', ok: true, detail: `found (@${role.name})` }
          : {
              name: 'discord mod role',
              ok: false,
              detail: `role ${config.discordModRoleId} not found in the channel's guild`
            }
      );
    }
  }

  for (const id of config.serverIds) {
    const paths = [
      [`kills (${id})`, `/api/servers/${id}/kills?kind=teamKill&limit=1`],
      [`audit (${id})`, `/api/audit?category=rcon&server=${id}&limit=1`],
      [`summary (${id})`, `/api/servers/${id}/summary`],
      [
        `leaderboard (${id})`,
        `/api/servers/${id}/leaderboard?scope=server&range=${config.kdRange}&sort=kd&dir=desc&minMinutes=${config.kdMinMinutes}`
      ]
    ] as const;

    let summary: SummaryBody | undefined;
    let summaryAnswered = false;
    for (const [name, path] of paths) {
      try {
        if (path.endsWith('/summary')) {
          summary = await client.getJson<SummaryBody>(path);
          summaryAnswered = true;
        } else {
          await client.getJson<unknown>(path);
        }
        results.push({ name, ok: true, detail: 'answered' });
      } catch (err) {
        results.push({ name, ok: false, detail: explain(path, err) });
      }
    }

    // The sweat list (live-alerts spec §4.1). Warcon silently falls back to another
    // sort for one it doesn't know, which would make every sweat read wrong without an
    // error, so the echoed query must say perHour.
    const boardName = `perHour board (${id})`;
    const boardPath =
      `/api/servers/${id}/leaderboard?scope=server&range=${config.sweatRange}` +
      `&sort=perHour&dir=desc&minMinutes=${config.rateMinMinutes}&page=1`;
    try {
      const board = await client.getJson<BoardBody>(boardPath);
      const sort = board.query?.sort;
      results.push(
        sort === 'perHour'
          ? { name: boardName, ok: true, detail: 'answered, sorted by perHour' }
          : {
              name: boardName,
              ok: false,
              detail: `the panel sorted by ${sort ?? 'an unreported sort'}, not perHour — this Warcon is too old for the sweat list`
            }
      );
    } catch (err) {
      results.push({ name: boardName, ok: false, detail: explain(boardPath, err) });
    }

    // The live check (live-alerts spec §9). Never fails a deploy: an empty server
    // legitimately has no match clock, and a summary that did not answer has already
    // failed its own check above.
    const clock = summary?.live?.status?.matchSeconds;
    results.push({
      name: `live data (${id})`,
      ok: true,
      detail: !summaryAnswered
        ? 'skipped — summary did not answer'
        : typeof clock === 'number'
          ? 'live check active'
          : 'no match clock — live alerts inactive until the server reports one'
    });

    // A missing label must never fail a deploy — every alert names its server first
    // (spec §8.5), but the fallback (first 8 chars of the id) is always available.
    const label = config.serverLabels[id];
    const liveName = summary?.live?.status?.serverName ?? 'unknown';
    results.push({
      name: `label (${id})`,
      ok: true,
      detail: label
        ? `${label} (Warcon calls it "${liveName}")`
        : `none — alerts will show "${serverLabel(id, config.serverLabels)}"; add it to SERVER_LABELS`
    });
  }

  results.push(...(await checkLookup(client, config, steamFetch)));
  return results;
}

/** `/lookup`'s three sources: the dossier, the org board export, and Steam when it's set up. */
async function checkLookup(client: WarconClient, config: Config, steamFetch: typeof fetch): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const serverId = config.serverIds[0];
  if (!serverId) return results;

  const dossierPath = `/api/servers/${serverId}/players/${PROBE_STEAM_ID}`;
  try {
    const body = await client.getJson<DossierBody>(dossierPath);
    results.push(
      Array.isArray(body.dossier?.names) && body.dossier.summary
        ? { name: 'lookup dossier', ok: true, detail: 'answered' }
        : { name: 'lookup dossier', ok: false, detail: 'answered without names or summary — this Warcon is too old for /lookup' }
    );
  } catch (err) {
    results.push({ name: 'lookup dossier', ok: false, detail: explain(dossierPath, err) });
  }

  const exportPath = `/api/servers/${serverId}/leaderboard/export?scope=org&range=30d&sort=playtime&dir=desc&minMinutes=0`;
  try {
    const rows = parseExport(await client.getCsv(exportPath));
    results.push({
      name: 'lookup 30-day board',
      ok: true,
      detail: `answered, ${rows.size} players${rows.size >= EXPORT_CAP ? ' (full: the least-played read as "under N h")' : ''}`
    });
  } catch (err) {
    results.push({ name: 'lookup 30-day board', ok: false, detail: explain(exportPath, err) });
  }

  if (!config.steamApiKey) {
    results.push({ name: 'steam key', ok: true, detail: 'unset — /lookup shows Steam playtime as not configured' });
  } else {
    try {
      const steam = new SteamClient({ apiKey: config.steamApiKey, timeoutMs: config.requestTimeoutMs, fetchImpl: steamFetch });
      await steam.playtime(PROBE_STEAM_ID, config.wardogsAppId);
      results.push({ name: 'steam key', ok: true, detail: 'accepted' });
    } catch (err) {
      results.push({ name: 'steam key', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new WarconClient({
    baseUrl: config.warconBaseUrl,
    token: config.warconToken,
    cfClientId: config.cfAccessClientId,
    cfClientSecret: config.cfAccessClientSecret,
    timeoutMs: config.requestTimeoutMs
  });

  const results = await checkAll(client, config, fetch);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}: ${r.detail}`);

  const failures = results.filter((r) => !r.ok).length;
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

// Only run as a CLI, so the tests can import checkAll without side effects.
// Compare resolved paths: matching on the basename alone would also fire when a
// test runner's argv happened to end the same way.
const invokedDirectly = (): boolean => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
