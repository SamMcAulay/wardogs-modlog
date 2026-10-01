import type { Decision, ModEvent } from './events.js';
import { serverState, type State } from './state.js';

/**
 * The alert kinds that can mention the mod role: only the live "hot right now" alert
 * (live-alerts spec §7). Everything else posts without a ping.
 */
export const PING_KINDS = ['live'] as const;
export type PingKind = (typeof PING_KINDS)[number];

export interface EscalateConfig {
  /** JOIN_ALERT_HOURS: how long a posted sweat / high-K/D / Steam veteran tag stays quiet (live-alerts spec §4.3) */
  joinAlertHours: number;
  /** PING_ON: when `live` is left out the hot alert still posts, just without the mention. */
  pingOn: ReadonlySet<PingKind>;
}

/**
 * Decides which events post and which ping, stamps team kills with their running count,
 * and applies the once-a-day limit to known-player join tags. Mutates `state` but
 * performs no I/O.
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
  const limitMs = cfg.joinAlertHours * 3_600_000;

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

      case 'playerJoined': {
        // The limit covers the known tags only; a watched player alerts on every
        // connect (live-alerts spec §4.3).
        const last = state.joinAlerted[event.steamId];
        const quiet = last !== undefined && now - last < limitMs;
        const sweat = event.sweat && !quiet;
        const highKd = event.highKd && !quiet;
        const steamVeteran = (event.steamVeteran ?? false) && !quiet;
        if (!event.watched && !sweat && !highKd && !steamVeteran) break; // no tag left
        if (sweat || highKd || steamVeteran) state.joinAlerted[event.steamId] = now;
        out.push({ event: { ...event, sweat, highKd, steamVeteran }, ping: false });
        break;
      }

      case 'hotPlayer':
        out.push({ event, ping: cfg.pingOn.has('live') });
        break;

      case 'adminAction':
      case 'feedQuiet':
        out.push({ event, ping: false });
        break;
    }
  }

  return out;
}
