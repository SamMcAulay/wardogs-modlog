import 'dotenv/config';
import { PING_KINDS, type PingKind } from './escalate.js';

export interface Config {
  warconBaseUrl: string;
  panelPublicUrl: string;
  warconToken: string;
  cfAccessClientId: string | null;
  cfAccessClientSecret: string | null;
  discordToken: string;
  discordChannelId: string;
  discordModRoleId: string;
  serverIds: string[];
  serverLabels: Record<string, string>;
  pingOn: ReadonlySet<PingKind>;
  pollIntervalMs: number;
  kdPollIntervalMs: number;
  requestTimeoutMs: number;
  statePath: string;
  teamKillPingAt: number;
  kdThreshold: number;
  kdMinMatches: number;
  kdMinMinutes: number;
  kdRange: string;
  kdCooldownDays: number;
  feedQuietMinutes: number;
}

function parseServerLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const rawEntry of raw.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const id = eq === -1 ? '' : entry.slice(0, eq).trim();
    const label = eq === -1 ? '' : entry.slice(eq + 1).trim();
    if (eq === -1 || !id || !label) {
      throw new Error(`SERVER_LABELS entry "${entry}" is not serverId=Label`);
    }
    labels[id] = label;
  }
  return labels;
}

/** Unset or blank keeps every ping; `none` turns them all off; otherwise a comma list of kinds. */
function parsePingOn(raw: string): ReadonlySet<PingKind> {
  const value = raw.trim();
  if (value === '') return new Set(PING_KINDS);
  if (value.toLowerCase() === 'none') return new Set();
  const kinds = new Set<PingKind>();
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (!(PING_KINDS as readonly string[]).includes(entry)) {
      throw new Error(
        `PING_ON entry "${entry}" is not one of ${PING_KINDS.join(', ')} (or use PING_ON=none)`
      );
    }
    kinds.add(entry as PingKind);
  }
  return kinds;
}

function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];

  const req = (key: string): string => {
    const value = (env[key] ?? '').trim();
    if (!value) missing.push(key);
    return value;
  };
  const opt = (key: string): string | null => {
    const value = (env[key] ?? '').trim();
    return value === '' ? null : value;
  };
  const num = (key: string, fallback: number): number => {
    const raw = (env[key] ?? '').trim();
    if (raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${key} must be a positive number, got: ${raw}`);
    }
    return parsed;
  };

  const warconBaseUrl = req('WARCON_BASE_URL').replace(/\/+$/, '');
  const panelPublicUrl = req('PANEL_PUBLIC_URL').replace(/\/+$/, '');
  const warconToken = req('WARCON_TOKEN');
  const discordToken = req('DISCORD_TOKEN');
  const discordChannelId = req('DISCORD_CHANNEL_ID');
  const discordModRoleId = req('DISCORD_MOD_ROLE_ID');

  const cfAccessClientId = opt('CF_ACCESS_CLIENT_ID');
  const cfAccessClientSecret = opt('CF_ACCESS_CLIENT_SECRET');
  if (cfAccessClientId && !cfAccessClientSecret) missing.push('CF_ACCESS_CLIENT_SECRET');
  if (cfAccessClientSecret && !cfAccessClientId) missing.push('CF_ACCESS_CLIENT_ID');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  }

  // Every embed link is built from this origin, and Discord rejects an embed whose url
  // is not absolute — a bad value would fail every post, so refuse it at boot.
  if (!isHttpUrl(panelPublicUrl)) {
    throw new Error(`PANEL_PUBLIC_URL must be an absolute http(s) URL, got: ${panelPublicUrl}`);
  }

  return {
    warconBaseUrl,
    panelPublicUrl,
    warconToken,
    cfAccessClientId,
    cfAccessClientSecret,
    discordToken,
    discordChannelId,
    discordModRoleId,
    serverIds: (env.SERVER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    serverLabels: parseServerLabels(env.SERVER_LABELS ?? ''),
    pingOn: parsePingOn(env.PING_ON ?? ''),
    pollIntervalMs: num('POLL_INTERVAL_MS', 30_000),
    kdPollIntervalMs: num('KD_POLL_INTERVAL_MS', 3_600_000),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 10_000),
    statePath: (env.STATE_PATH ?? '').trim() || '/data/state.json',
    teamKillPingAt: num('TEAM_KILL_PING_AT', 3),
    kdThreshold: num('KD_THRESHOLD', 4.0),
    kdMinMatches: num('KD_MIN_MATCHES', 5),
    kdMinMinutes: num('KD_MIN_MINUTES', 60),
    kdRange: (env.KD_RANGE ?? '').trim() || '30d',
    kdCooldownDays: num('KD_COOLDOWN_DAYS', 7),
    feedQuietMinutes: num('FEED_QUIET_MINUTES', 30)
  };
}
