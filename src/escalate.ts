import type { Decision, ModEvent } from './events.js';
import { serverState, type State } from './state.js';

/**
 * The alert kinds that can mention the mod role: only the live "hot right now" alert
 * (live-alerts spec §7). Everything else posts without a ping.
 */
export const PING_KINDS = ['live'] as const;
export type PingKind = (typeof PING_KINDS)[number];

export interface EscalateConfig {
  /** governs the K/D, sweat and surge cooldowns alike */
  kdCooldownDays: number;
  /** PING_ON: tier-3 kinds left out still post, just without the mention. */
  pingOn: ReadonlySet<PingKind>;
}

/**
 * Decides which events post and which ping, stamps team kills with their running count,
 * and applies the K/D and kill-rate cooldowns. Mutates `state` but performs no I/O.
 *
 * Events must arrive in chronological order — see base spec §8.1: the kills API returns
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
  const cooling = (at: number | undefined): boolean => at !== undefined && now - at < cooldownMs;

  for (const event of events) {
    switch (event.kind) {
      case 'teamKill': {
        const s = serverState(state, event.serverId);
        // The match clock resets on a map change; matchId is per boot, not per match.
        if (event.eventTime < s.lastEventTime) s.teamKills = {};
        s.lastEventTime = event.eventTime;

        const count = (s.teamKills[event.killer.steamId] ?? 0) + 1;
        s.teamKills[event.killer.steamId] = count;
        out.push({ event: { ...event, count }, ping: false });
        break;
      }

      case 'highKd': {
        if (cooling(state.kdAlerted[event.steamId])) break;
        state.kdAlerted[event.steamId] = now;
        out.push({ event, ping: false });
        break;
      }

      case 'killRate': {
        const sweatKey = `sweat:${event.steamId}`;
        const surgeKey = `surge:${event.steamId}`;
        const sweat = event.sweat && !cooling(state.rateAlerted[sweatKey]) ? event.sweat : null;
        const surge = event.surge && !cooling(state.rateAlerted[surgeKey]) ? event.surge : null;
        if (!sweat && !surge) break; // both parts still cooling
        if (sweat) state.rateAlerted[sweatKey] = now;
        if (surge) state.rateAlerted[surgeKey] = now;
        out.push({
          event: { ...event, sweat, surge },
          ping: (!!sweat && cfg.pingOn.has('sweat')) || (!!surge && cfg.pingOn.has('surge'))
        });
        break;
      }

      case 'watchedJoin':
      case 'adminAction':
      case 'feedQuiet':
        out.push({ event, ping: false });
        break;
    }
  }

  return out;
}
