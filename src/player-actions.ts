import type { WarconClient } from './warcon.js';
import type { MarksBody } from './warcon-types.js';

/**
 * The Kick and Watch buttons on player alerts: the parts that don't need a live Discord
 * connection, so they can be tested as plain data. `gateway.ts` wires them to Discord.
 *
 * Flow, for either button: a mod presses it → a confirmation (with an optional reason)
 * shown only to them → on Submit the panel acts → the pressed button becomes a disabled
 * "Kicked by <mod>" / "Watched by <mod>" label, and a line in the channel records who did
 * it. The mod's name is never sent to the game; the watchlist (staff-only) keeps it in the
 * stored reason, because Warcon credits every entry to the API key.
 */

export type PlayerAction = 'kick' | 'watch';

/** What the game shows the kicked player when the mod leaves the reason empty. */
export const DEFAULT_KICK_REASON = 'Kicked by a moderator';

/** Warcon keeps at most this much of a watch reason. */
const WATCH_REASON_MAX = 300;

const IDS: Record<PlayerAction, { button: string; confirm: string }> = {
  kick: { button: 'kick', confirm: 'kickc' },
  watch: { button: 'watch', confirm: 'watchc' }
};
const STEAM_ID = /^\d{17}$/;

export interface ButtonComponent {
  type: 2;
  style: number;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface TextInputComponent {
  type: 4;
  custom_id: string;
  label: string;
  style: number;
  required: boolean;
  max_length: number;
  placeholder?: string;
}

export interface ActionRow<C> {
  type: 1;
  components: C[];
}

export interface ActionModal {
  custom_id: string;
  title: string;
  components: ActionRow<TextInputComponent>[];
}

const clamp = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const buttonId = (action: PlayerAction, serverId: string, steamId: string): string =>
  `${IDS[action].button}:${serverId}:${steamId}`;

/**
 * The buttons for an alert about this player on this server: Kick (unless they're known to be
 * off it), and Watch unless they are already on the watchlist.
 */
export function actionRow(
  serverId: string,
  steamId: string,
  opts: { watch: boolean; kick?: boolean }
): ActionRow<ButtonComponent> {
  const components: ButtonComponent[] = [];
  if (opts.kick ?? true) {
    components.push({ type: 2, style: 4, label: 'Kick', custom_id: buttonId('kick', serverId, steamId) });
  }
  if (opts.watch) {
    components.push({ type: 2, style: 1, label: 'Watch', custom_id: buttonId('watch', serverId, steamId) });
  }
  return { type: 1, components };
}

/**
 * The message's rows with the pressed button replaced by a disabled label naming the mod.
 * Only that button changes, so after a watch the Kick button still works, and vice versa.
 */
export function doneRows(
  rows: ActionRow<ButtonComponent>[],
  pressedId: string,
  label: string
): ActionRow<ButtonComponent>[] {
  return rows.map((row) => ({
    ...row,
    components: row.components.map((b) =>
      b.custom_id === pressedId ? { ...b, style: 2, label: clamp(label, 80), disabled: true } : b
    )
  }));
}

/** The confirmation, shown only to the mod who pressed the button. Submit acts; Cancel does nothing. */
export function actionModal(
  action: PlayerAction,
  serverId: string,
  steamId: string,
  playerName: string
): ActionModal {
  const input: TextInputComponent =
    action === 'kick'
      ? {
          type: 4,
          custom_id: 'reason',
          label: 'Reason (optional, shown to the player)',
          style: 2,
          required: false,
          max_length: 200,
          placeholder: DEFAULT_KICK_REASON
        }
      : {
          type: 4,
          custom_id: 'reason',
          label: 'Reason (optional, staff only)',
          style: 2,
          required: false,
          max_length: 250,
          placeholder: 'Why should staff keep an eye on them?'
        };
  return {
    custom_id: `${IDS[action].confirm}:${serverId}:${steamId}`,
    title: clamp(`${action === 'kick' ? 'Kick' : 'Watch'} ${playerName}?`, 45),
    components: [{ type: 1, components: [input] }]
  };
}

/** A button or confirmation id of ours, or null for anything else. */
export function parseActionId(
  customId: string
): { action: PlayerAction; step: 'button' | 'confirm'; serverId: string; steamId: string } | null {
  const [prefix, serverId, steamId, ...rest] = customId.split(':');
  if (rest.length > 0 || !serverId || !steamId || !STEAM_ID.test(steamId)) return null;
  for (const action of ['kick', 'watch'] as const) {
    if (prefix === IDS[action].button) return { action, step: 'button', serverId, steamId };
    if (prefix === IDS[action].confirm) return { action, step: 'confirm', serverId, steamId };
  }
  return null;
}

/**
 * The player's name from an alert's title (`NA#3 · Joined — Alpha`,
 * `NA#3 · Team kill — Alpha (3)`), or null. Everything after the first ` — ` is the name,
 * less a team kill's trailing count.
 */
export function playerNameFromTitle(title: string | undefined | null): string | null {
  if (!title) return null;
  const at = title.indexOf(' — ');
  if (at === -1) return null;
  const name = title.slice(at + 3).replace(/ \(\d+\)$/, '').trim();
  return name || null;
}

/**
 * Whether a member holds the role. Discord hands the bot either a cached member (roles in
 * a `cache` map) or a raw one (an array of role ids); no member at all means a DM.
 */
export function hasRole(
  roles: readonly string[] | { cache: { has(id: string): boolean } } | undefined | null,
  roleId: string
): boolean {
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(roleId);
  return (roles as { cache: { has(id: string): boolean } }).cache.has(roleId);
}

/** The line posted in the channel after a kick: who kicked whom, where, and why. */
export function kickLogLine(modName: string, playerName: string, serverLabel: string, reason: string): string {
  const why = reason.trim();
  return `🔨 **${modName}** kicked **${playerName}** from **${serverLabel}**${why ? ` — ${why}` : ''}`;
}

/** The line posted in the channel after a watch. The watchlist is org-wide; the server is where they were seen. */
export function watchLogLine(modName: string, playerName: string, serverLabel: string, reason: string): string {
  const why = reason.trim();
  return `👁️ **${modName}** added **${playerName}** to the watchlist (seen on **${serverLabel}**)${why ? ` — ${why}` : ''}`;
}

/**
 * The reason stored on the watchlist: the mod's words plus who added it, since Warcon
 * credits the entry to the API key. Trimmed to fit Warcon's limit without losing the name.
 */
export function storedWatchReason(reason: string, modName: string): string {
  const why = reason.trim();
  if (!why) return clamp(`Added via Discord by ${modName}`, WATCH_REASON_MAX);
  const suffix = ` — added via Discord by ${modName}`;
  return `${clamp(why, Math.max(1, WATCH_REASON_MAX - suffix.length))}${suffix}`;
}

/**
 * Kicks through the panel (`players.moderate`). The reason is the mod's typed one, or the
 * generic one; the mod's name is recorded in Discord, not here.
 */
export async function kick(
  client: WarconClient,
  serverId: string,
  steamId: string,
  reason: string
): Promise<{ ok: boolean; message: string }> {
  const result = await client.postAction(`/api/servers/${encodeURIComponent(serverId)}/rcon/kick`, {
    steamId,
    reason: reason.trim() || DEFAULT_KICK_REASON
  });
  if (result.ok) return { ok: true, message: 'Kicked.' };
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      message:
        "The bot's Warcon key isn't allowed to kick on this server. Add the **Kick, kill, move** permission to the modlog key."
    };
  }
  return { ok: false, message: `Kick failed: ${result.message}` };
}

/**
 * Puts the player on the org's watchlist (`players.notes`). Warcon's call replaces any
 * existing entry, reason and all, so the watchlist is checked first: a player already on
 * it is left exactly as they are, and the mod is told why they're already watched.
 */
export async function watch(
  client: WarconClient,
  serverId: string,
  steamId: string,
  playerName: string,
  reason: string,
  modName: string
): Promise<{ ok: boolean; message: string }> {
  const id = encodeURIComponent(serverId);
  let existing: { watched: boolean; reason: string } | undefined;
  try {
    const query = new URLSearchParams({ ids: steamId, names: playerName });
    const body = await client.getJson<MarksBody>(`/api/servers/${id}/players/marks?${query}`);
    existing = body.marks.find((m) => m.steamId === steamId);
  } catch (err) {
    return {
      ok: false,
      message: `Couldn't check the watchlist, so nothing was changed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (existing?.watched) {
    return {
      ok: false,
      message: `Already on the watchlist${existing.reason ? `: ${existing.reason}` : ''}. Nothing changed.`
    };
  }

  const result = await client.postAction(
    `/api/servers/${id}/players/${encodeURIComponent(steamId)}/watch`,
    { watched: true, reason: storedWatchReason(reason, modName) },
    'PUT'
  );
  if (result.ok) return { ok: true, message: 'Added to the watchlist.' };
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      message:
        "The bot's Warcon key isn't allowed to edit the watchlist. Add the **Notes & watchlist** permission to the modlog key."
    };
  }
  return { ok: false, message: `Watch failed: ${result.message}` };
}
