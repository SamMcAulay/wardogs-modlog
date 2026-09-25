import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { serverLabel } from './discord.js';
import { CloudflareBlockedError, WarconAuthError, WarconClient } from './warcon.js';
import type { SummaryBody } from './warcon-types.js';

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

export async function checkAll(
  client: WarconClient,
  config: Config,
  discordFetch: (url: string, init: RequestInit) => Promise<Response>
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
    for (const [name, path] of paths) {
      try {
        const body = await client.getJson<unknown>(path);
        if (path.endsWith('/summary')) summary = body as SummaryBody;
        results.push({ name, ok: true, detail: 'answered' });
      } catch (err) {
        results.push({ name, ok: false, detail: explain(path, err) });
      }
    }

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
