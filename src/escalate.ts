import type { Decision, ModEvent } from './events.js';
import { serverState, type State } from './state.js';

/** The alert kinds that can mention the mod role. Kicks, bans and feed warnings never do. */
export const PING_KINDS = ['teamKill', 'watchedJoin', 'highKd'] as const;
export type PingKind = (typeof PING_KINDS)[number];

export interface EscalateConfig {
  teamKillPingAt: number;
  kdCooldownDays: number;
  /** PING_ON: kinds left out still post, just without the mention. */
  pingOn: ReadonlySet<PingKind>;
}

/**
 * Decides which events ping the mod role, and stamps team kills with their running
 * count. Mutates `state` (counts, K/D cooldowns) but performs no I/O.
 *
 * Events must arrive in chronological order — see spec §8.1: the kills API returns
 * newest first, so the source reverses each page before calling this.
 */
export function escalate(
  events: ModEvent[],
  state: State,
  cfg: EscalateConfig,
  now: number
): Decision[] {
  const out: Decision[] = [];
  const cooldownMs = cfg.kdCooldownDays * 86_400_000;

  for (const event of events) {
    switch (event.kind) {
      case 'teamKill': {
        const s = serverState(state, event.serverId);
        // The match clock resets on a map change; matchId is per boot, not per match.
        if (event.eventTime < s.lastEventTime) s.teamKills = {};
        s.lastEventTime = event.eventTime;

        const count = (s.teamKills[event.killer.steamId] ?? 0) + 1;
        s.teamKills[event.killer.steamId] = count;
        out.push({
          event: { ...event, count },
          ping: count >= cfg.teamKillPingAt && cfg.pingOn.has('teamKill')
        });
        break;
      }

      case 'highKd': {
        const last = state.kdAlerted[event.steamId];
        if (last !== undefined && now - last < cooldownMs) break; // still cooling down
        state.kdAlerted[event.steamId] = now;
        out.push({ event, ping: cfg.pingOn.has('highKd') });
        break;
      }

      case 'watchedJoin':
        out.push({ event, ping: cfg.pingOn.has('watchedJoin') });
        break;

      case 'adminAction':
      case 'feedQuiet':
        out.push({ event, ping: false });
        break;
    }
  }

  return out;
}
