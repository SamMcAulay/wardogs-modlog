import { buildMessage, type DiscordPoster, type LinkConfig } from './discord.js';
import { escalate, type EscalateConfig } from './escalate.js';
import { eventKey, type ModEvent } from './events.js';
import type { Logger } from './log.js';
import { serverState, type ServerState, type State } from './state.js';

export interface CycleSources {
  kills(serverId: string, s: ServerState): Promise<ModEvent[]>;
  audit(serverId: string, s: ServerState): Promise<ModEvent[]>;
  watchlist(serverId: string, s: ServerState): Promise<ModEvent[]>;
  kd(serverId: string): Promise<ModEvent[]>;
}

export interface CycleDeps {
  serverIds: string[];
  state: State;
  now: number;
  /** the K/D board runs on its own, slower schedule */
  runKd: boolean;
  logger: Logger;
  escalateConfig: EscalateConfig;
  links: LinkConfig;
  modRoleId: string;
  sources: CycleSources;
  poster: DiscordPoster;
  save(state: State): Promise<void>;
}

/**
 * One pass over every server.
 *
 * Cursor safety (spec §9): sources advance their cursors inside the state object as
 * they read. If a post then fails we restore that server's pre-cycle snapshot, so the
 * next cycle re-reads and re-reports rather than silently dropping the event.
 */
export async function runCycle(deps: CycleDeps): Promise<void> {
  const cold = deps.state.cold;

  for (const serverId of deps.serverIds) {
    const s = serverState(deps.state, serverId);
    // escalate() writes to BOTH the server entry and the global kdAlerted map, so a
    // failed post has to roll back both — otherwise a K/D alert nobody received still
    // starts its cooldown and the player goes unreported for days. Snapshotting
    // kdAlerted per server (not once per cycle) preserves earlier servers' alerts.
    const snapshot = structuredClone(s);
    const kdSnapshot = { ...deps.state.kdAlerted };

    const collected: ModEvent[] = [];
    const run = async (name: string, fn: () => Promise<ModEvent[]>): Promise<void> => {
      try {
        collected.push(...(await fn()));
      } catch (err) {
        // One source failing must not stop the others, or one server the rest.
        deps.logger.warn(`[${serverId}] ${name}: ${err instanceof Error ? err.message : err}`);
      }
    };

    await run('kills', () => deps.sources.kills(serverId, s));
    await run('audit', () => deps.sources.audit(serverId, s));
    await run('watchlist', () => deps.sources.watchlist(serverId, s));
    if (deps.runKd) await run('kd', () => deps.sources.kd(serverId));

    // A cold start learns where it is and says nothing (spec §7).
    if (cold) continue;

    const decisions = escalate(collected, deps.state, deps.escalateConfig, deps.now);

    let failed = false;
    for (const d of decisions) {
      try {
        await deps.poster.post(buildMessage(d, deps.links, deps.modRoleId));
        deps.logger.info(`[${serverId}] posted ${eventKey(d.event)}${d.ping ? ' (ping)' : ''}`);
      } catch (err) {
        deps.logger.error(
          `[${serverId}] discord post failed: ${err instanceof Error ? err.message : err}`
        );
        failed = true;
        break;
      }
    }

    if (failed) {
      deps.state.servers[serverId] = snapshot;
      deps.state.kdAlerted = kdSnapshot;
    }
  }

  deps.state.cold = false;
  await deps.save(deps.state);
}
