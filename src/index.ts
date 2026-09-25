import { loadConfig } from './config.js';
import { RestPoster } from './discord.js';
import { consoleLogger } from './log.js';
import { runCycle } from './runner.js';
import { pollAudit } from './sources/audit.js';
import { pollKd } from './sources/kd.js';
import { pollKills } from './sources/kills.js';
import { pollWatchlist } from './sources/watchlist.js';
import { loadState, saveState } from './state.js';
import { WarconClient } from './warcon.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = consoleLogger;

  if (config.serverIds.length === 0) {
    throw new Error('SERVER_IDS is empty — list the servers this bot should watch');
  }

  const client = new WarconClient({
    baseUrl: config.warconBaseUrl,
    token: config.warconToken,
    cfClientId: config.cfAccessClientId,
    cfClientSecret: config.cfAccessClientSecret,
    timeoutMs: config.requestTimeoutMs
  });

  const state = await loadState(config.statePath);
  if (state.cold) log.info('no usable state file — recording position, reporting nothing');

  const poster = new RestPoster(config.discordToken, config.discordChannelId);
  let lastKdAt = 0;

  const cycle = async (): Promise<void> => {
    const now = Date.now();
    const runKd = now - lastKdAt >= config.kdPollIntervalMs;
    if (runKd) lastKdAt = now;

    await runCycle({
      serverIds: config.serverIds,
      state,
      now,
      runKd,
      logger: log,
      escalateConfig: {
        teamKillPingAt: config.teamKillPingAt,
        kdCooldownDays: config.kdCooldownDays
      },
      links: { panelPublicUrl: config.panelPublicUrl, serverLabels: config.serverLabels },
      modRoleId: config.discordModRoleId,
      sources: {
        kills: (id, s) =>
          pollKills(client, id, s, { feedQuietMinutes: config.feedQuietMinutes, now }),
        audit: (id, s) => pollAudit(client, id, s),
        watchlist: (id, s) => pollWatchlist(client, id, s, now),
        kd: (id) =>
          pollKd(
            client,
            id,
            {
              threshold: config.kdThreshold,
              minMatches: config.kdMinMatches,
              minMinutes: config.kdMinMinutes,
              range: config.kdRange
            },
            now
          )
      },
      poster,
      save: (s) => saveState(config.statePath, s)
    });
  };

  await cycle();
  const timer = setInterval(() => {
    void cycle().catch((err) => log.error(err instanceof Error ? err.message : String(err)));
  }, config.pollIntervalMs);

  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  consoleLogger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
