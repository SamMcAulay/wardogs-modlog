import type { WarconClient } from './warcon.js';

/**
 * The Kick button on player alerts: the parts that don't need a live Discord connection,
 * so they can be tested as plain data. `gateway.ts` wires them to Discord's events.
 *
 * Flow: a mod presses Kick → a confirmation (with an optional reason) shown only to them →
 * on Submit the panel kicks the player → the button becomes "Kicked by <mod>" and a line in
 * the channel records who did it. The mod's name never goes into the kick sent to the game.
 */

/** What the game shows the kicked player when the mod leaves the reason empty. */
export const DEFAULT_KICK_REASON = 'Kicked by a moderator';

const BUTTON = 'kick';
const CONFIRM = 'kickc';
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

export interface KickModal {
  custom_id: string;
  title: string;
  components: ActionRow<TextInputComponent>[];
}

const clamp = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** The red Kick button for an alert about this player on this server. */
export function kickRow(serverId: string, steamId: string): ActionRow<ButtonComponent> {
  return {
    type: 1,
    components: [{ type: 2, style: 4, label: 'Kick', custom_id: `${BUTTON}:${serverId}:${steamId}` }]
  };
}

/** What the button turns into once the player is kicked: a disabled label naming the mod. */
export function kickedRow(modName: string): ActionRow<ButtonComponent> {
  return {
    type: 1,
    components: [
      { type: 2, style: 2, label: clamp(`Kicked by ${modName}`, 80), custom_id: 'kicked', disabled: true }
    ]
  };
}

/** The confirmation, shown only to the mod who pressed Kick. Submit kicks; Cancel does nothing. */
export function kickModal(serverId: string, steamId: string, playerName: string): KickModal {
  return {
    custom_id: `${CONFIRM}:${serverId}:${steamId}`,
    title: clamp(`Kick ${playerName}?`, 45),
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'reason',
            label: 'Reason (optional, shown to the player)',
            style: 2,
            required: false,
            max_length: 200,
            placeholder: DEFAULT_KICK_REASON
          }
        ]
      }
    ]
  };
}

/** A button or confirmation id of ours, or null for anything else. */
export function parseKickId(
  customId: string
): { step: 'button' | 'confirm'; serverId: string; steamId: string } | null {
  const [prefix, serverId, steamId, ...rest] = customId.split(':');
  if (rest.length > 0 || !serverId || !steamId || !STEAM_ID.test(steamId)) return null;
  if (prefix === BUTTON) return { step: 'button', serverId, steamId };
  if (prefix === CONFIRM) return { step: 'confirm', serverId, steamId };
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
