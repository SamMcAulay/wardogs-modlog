import { loadConfig } from './config.js';
import { RestPoster, serverLabel } from './discord.js';
import { BoardCache } from './board-cache.js';
import { startGateway } from './gateway.js';
import { consoleLogger } from './log.js';
import { runCycle } from './runner.js';
import { pollAudit } from './sources/audit.js';
import { pollKills } from './sources/kills.js';
import { pollKnown } from './sources/known.js';
import { pollPresence } from './sources/presence.js';
import { loadState, saveState } from './state.js';
import { SteamClient } from './steam.js';
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

  log.info(`pings: ${config.pingOn.size > 0 ? [...config.pingOn].join(', ') : 'off (PING_ON=none)'}`);

  const state = await loadState(config.statePath);
  const coldIds = config.serverIds.filter((id) => !state.servers[id]?.warm);
  if (coldIds.length > 0) {
    log.info(
      `cold start for ${coldIds.map((id) => serverLabel(id, config.serverLabels)).join(', ')}` +
        ' — recording position, reporting nothing until a clean cycle'
    );
  }

  const poster = new RestPoster(config.discordToken, config.discordChannelId);
  // The live connection that answers Kick buttons. Alerts still post over REST, so a
  // gateway that can't connect costs the buttons, not the alerts.
  const gateway = startGateway({
    token: config.discordToken,
    modRoleId: config.discordModRoleId,
    warcon: client,
    serverLabels: config.serverLabels,
    logger: log,
    lookup: {
      warcon: client,
      boards: new BoardCache(client, config.serverIds[0]!),
      steam: config.steamApiKey
        ? new SteamClient({ apiKey: config.steamApiKey, timeoutMs: config.requestTimeoutMs })
        : null,
      serverId: config.serverIds[0]!,
      wardogsAppId: config.wardogsAppId,
      links: { panelPublicUrl: config.panelPublicUrl, serverLabels: config.serverLabels }
    }
  });
  if (!config.steamApiKey) log.info('lookup: STEAM_API_KEY unset — Steam playtime reads "not configured"');
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
        joinAlertHours: config.joinAlertHours,
        pingOn: config.pingOn
      },
      links: { panelPublicUrl: config.panelPublicUrl, serverLabels: config.serverLabels },
      modRoleId: config.discordModRoleId,
      sources: {
        kills: (id, s) =>
          pollKills(client, id, s, { feedQuietMinutes: config.feedQuietMinutes, now }),
        audit: (id, s) => pollAudit(client, id, s),
        known: (id, s) =>
          pollKnown(
            client,
            id,
            s,
            {
              sweatPerHour: config.sweatPerHour,
              sweatRange: config.sweatRange,
              rateMinMinutes: config.rateMinMinutes,
              kdThreshold: config.kdThreshold,
              kdMinMatches: config.kdMinMatches,
              kdMinMinutes: config.kdMinMinutes,
              kdRange: config.kdRange
            },
            now
          ),
        presence: (id, s) =>
          pollPresence(
            client,
            id,
            s,
            {
              livePerHour: config.livePerHour,
              liveMinMinutes: config.liveMinMinutes,
              liveMinKills: config.liveMinKills
            },
            now
          )
      },
      poster,
      save: (s) => saveState(config.statePath, s)
    });
  };

  // Self-scheduling rather than setInterval: the next cycle is only queued once this
  // one has fully settled, so a slow cycle (6 servers x 4 sources, each up to
  // REQUEST_TIMEOUT_MS) can never overlap a still-running one and mutate the shared
  // state object concurrently. Every cycle — including the first — is error-contained
  // identically: log and keep going, never let a transient failure exit the process.
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  // The cycle currently running, if any — shutdown waits on it (see below).
  let inFlight: Promise<void> | undefined;

  const loop = async (): Promise<void> => {
    inFlight = cycle().catch((err: unknown) => {
      log.error(err instanceof Error ? err.message : String(err));
    });
    await inFlight;
    inFlight = undefined;
    if (!stopping) timer = setTimeout(() => void loop(), config.pollIntervalMs);
  };

  // Exiting mid-cycle would let posts go out without the state that records them being
  // saved, so every deploy would re-post them. Let the in-flight cycle finish, capped
  // well inside Docker's 10 s stop grace period so we still exit on our own terms.
  const SHUTDOWN_DRAIN_MS = 8_000;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return; // a second signal while draining changes nothing
    log.info(`${signal} received, shutting down`);
    stopping = true;
    if (timer) clearTimeout(timer);
    if (inFlight) {
      log.info('waiting for the in-flight cycle to finish');
      let cap: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        inFlight.then(() => false),
        new Promise<boolean>((resolve) => {
          cap = setTimeout(() => resolve(true), SHUTDOWN_DRAIN_MS);
        })
      ]);
      clearTimeout(cap);
      if (timedOut) log.warn(`in-flight cycle still running after ${SHUTDOWN_DRAIN_MS} ms, exiting anyway`);
    }
    await gateway.destroy().catch(() => undefined);
    process.exit(0);
  };
  // Registered before the first cycle runs, so a signal during that first cycle is
  // still handled rather than falling through to the default (immediate exit).
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await loop();
}

main().catch((err) => {
  consoleLogger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
