import 'dotenv/config';

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
