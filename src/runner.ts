import {
  buildMessage,
  permanentRejectionStatus,
  type DiscordPoster,
  type LinkConfig
} from './discord.js';
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
 * A retry identity for a decision's event — `eventKey` minus the cycle timestamp.
 *
 * `watchedJoin`/`highKd`/`feedQuiet` eventKeys embed `at`, which differs when the same
 * underlying event is re-read a cycle later (after a rollback). A retry identity must
 * stay the same across that re-read so `postedBeforeFailure` can recognise it.
 */
export function retryKey(e: ModEvent): string {
  switch (e.kind) {
    case 'teamKill':
      return `teamKill:${e.eventId}`;
    case 'adminAction':
      return `adminAction:${e.auditId}`;
    case 'watchedJoin':
      return `watchedJoin:${e.serverId}:${e.steamId}`;
    case 'highKd':
      return `highKd:${e.serverId}:${e.steamId}`;
    case 'feedQuiet':
      return `feedQuiet:${e.serverId}`;
  }
}

/**
 * One pass over every server.
 *
 * Cursor safety (spec §9): sources advance their cursors inside the state object as
 * they read. If a post then fails we restore that server's pre-cycle snapshot, so the
 * next cycle re-reads and re-reports rather than silently dropping the event.
 *
 * That whole-server rollback is per-cycle, not per-event: if event A posts and event B
 * (read in the same batch) then fails to post, rolling back naively would re-post A
 * next cycle too. `postedBeforeFailure` remembers A's retry identity across the
 * rollback so the retry cycle skips it — scoped to one retry: a server that completes
 * a cycle with no post failure and every source succeeding clears the list, so a
 * genuine later recurrence (e.g. the same player rejoining) still alerts.
 *
 * A post Discord rejects outright (4xx other than 429) is not a failure in this sense:
 * it is logged, counted as delivered, and the cycle carries on (spec §9).
 */
export async function runCycle(deps: CycleDeps): Promise<void> {
  for (const serverId of deps.serverIds) {
    const s = serverState(deps.state, serverId);
    // Cold start is per server and persisted (spec §7): a server that has never
    // completed a clean cycle — first boot, or a server id newly added to SERVER_IDS —
    // learns where it is and says nothing, so its history is not reported as new.
    const warm = s.warm;
    // escalate() writes to BOTH the server entry and the global kdAlerted map, so a
    // failed post has to roll back both — otherwise a K/D alert nobody received still
    // starts its cooldown and the player goes unreported for days. Snapshotting
    // kdAlerted per server (not once per cycle) preserves earlier servers' alerts.
    const snapshot = structuredClone(s);
    const kdSnapshot = { ...deps.state.kdAlerted };

    const collected: ModEvent[] = [];
    // Only the sources that keep a cursor decide warmth: the K/D board has none, so
    // it failing leaves nothing un-recorded.
    let cursorSourceFailed = false;
    let anySourceFailed = false;
    const run = async (
      name: string,
      fn: () => Promise<ModEvent[]>,
      hasCursor = true
    ): Promise<void> => {
      try {
        collected.push(...(await fn()));
      } catch (err) {
        // One source failing must not stop the others, or one server the rest.
        deps.logger.warn(`[${serverId}] ${name}: ${err instanceof Error ? err.message : err}`);
        anySourceFailed = true;
        if (hasCursor) cursorSourceFailed = true;
      }
    };

    await run('kills', () => deps.sources.kills(serverId, s));
    await run('audit', () => deps.sources.audit(serverId, s));
    await run('watchlist', () => deps.sources.watchlist(serverId, s));
    if (deps.runKd) await run('kd', () => deps.sources.kd(serverId), false);

    if (!warm) {
      // A cold cycle in which a cursored source failed must not report that source's
      // backlog as new once it recovers — stay cold until one fully clean cycle.
      if (!cursorSourceFailed) {
        s.warm = true;
        deps.logger.info(`[${serverId}] now warm: position recorded, reporting from the next cycle`);
      }
      continue;
    }

    const decisions = escalate(collected, deps.state, deps.escalateConfig, deps.now);

    // What this server had already delivered before the start of this cycle (i.e. a
    // pending retry from a failure last cycle) — read off the pre-cycle snapshot, not
    // the live entry, though sources never touch this field either way.
    const initialPosted = new Set(snapshot.postedBeforeFailure);
    const delivered = new Set(initialPosted);

    let failed = false;
    for (const d of decisions) {
      const key = retryKey(d.event);
      if (initialPosted.has(key)) {
        // Already delivered before a prior failure in this same retry — count it as
        // delivered again without posting it a second time.
        deps.logger.info(`[${serverId}] ${key} already posted before a failure, skipping`);
        continue;
      }
      try {
        await deps.poster.post(buildMessage(d, deps.links, deps.modRoleId));
        delivered.add(key);
        deps.logger.info(`[${serverId}] posted ${eventKey(d.event)}${d.ping ? ' (ping)' : ''}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = permanentRejectionStatus(err);
        if (status !== null) {
          // Discord refused this message itself (e.g. an invalid embed); retrying the
          // same body can only fail again, and rolling back would block this server
          // forever. Log it loudly, count it as delivered, and carry on.
          deps.logger.error(
            `[${serverId}] discord rejected ${eventKey(d.event)} (HTTP ${status}): ${message} — dropped, not retried`
          );
          delivered.add(key);
          continue;
        }
        deps.logger.error(`[${serverId}] discord post failed: ${message}`);
        failed = true;
        break;
      }
    }

    if (failed) {
      deps.state.servers[serverId] = { ...snapshot, postedBeforeFailure: Array.from(delivered) };
      deps.state.kdAlerted = kdSnapshot;
      // The snapshot also erased the cooldowns of K/D alerts that DID go out this
      // cycle; without them the next K/D run would ping those players again.
      for (const d of decisions) {
        if (d.event.kind === 'highKd' && delivered.has(retryKey(d.event))) {
          deps.state.kdAlerted[d.event.steamId] = deps.now;
        }
      }
    } else if (!anySourceFailed) {
      // A clean cycle closes out the retry: one-cycle scope only. "Clean" includes
      // every source: one that threw has not re-read its events yet, and clearing the
      // list now would let the next cycle post them a second time.
      s.postedBeforeFailure = [];
    }
  }

  // Cooldowns past their expiry no longer suppress anything; drop them so the state
  // file does not grow with every player ever flagged.
  const cooldownMs = deps.escalateConfig.kdCooldownDays * 86_400_000;
  for (const [steamId, at] of Object.entries(deps.state.kdAlerted)) {
    if (deps.now - at >= cooldownMs) delete deps.state.kdAlerted[steamId];
  }

  await deps.save(deps.state);
}
