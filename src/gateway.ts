import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type ModalSubmitInteraction
} from 'discord.js';
import { serverLabel } from './discord.js';
import {
  hasRole,
  kick,
  kickLogLine,
  kickModal,
  kickedRow,
  parseKickId,
  playerNameFromTitle
} from './kick.js';
import type { Logger } from './log.js';
import type { WarconClient } from './warcon.js';

export interface GatewayDeps {
  token: string;
  /** DISCORD_MOD_ROLE_ID: the role that may press Kick, the same one alerts ping */
  modRoleId: string;
  warcon: WarconClient;
  serverLabels: Record<string, string>;
  logger: Logger;
}

/**
 * The bot's live Discord connection, for the Kick buttons only: alerts are still posted
 * over REST. It asks for the Guilds intent alone (no privileged intents), which is all an
 * interaction needs. A failed login is logged and the bot carries on posting alerts; only
 * the buttons stop working.
 */
export function startGateway(deps: GatewayDeps): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (c) => {
    deps.logger.info(`discord: connected as ${c.user.tag}; Kick buttons are live`);
  });
  client.on(Events.Error, (err) => deps.logger.error(`discord: ${err.message}`));
  client.on(Events.InteractionCreate, (interaction) => {
    void handle(interaction, deps).catch((err: unknown) => {
      deps.logger.error(`kick button: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  client.login(deps.token).catch((err: unknown) => {
    deps.logger.error(
      `discord: gateway login failed — alerts still post, but Kick buttons won't work: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });
  return client;
}

async function handle(interaction: Interaction, deps: GatewayDeps): Promise<void> {
  if (interaction.isButton()) await onButton(interaction, deps);
  else if (interaction.isModalSubmit()) await onConfirm(interaction, deps);
}

/** Kick pressed: check the role, then ask for confirmation (visible only to the presser). */
async function onButton(i: ButtonInteraction, deps: GatewayDeps): Promise<void> {
  const id = parseKickId(i.customId);
  if (!id || id.step !== 'button') return;
  if (!mayKick(i, deps.modRoleId)) {
    await refuse(i, deps.modRoleId);
    return;
  }
  const name = playerNameFromTitle(i.message.embeds[0]?.title) ?? id.steamId;
  await i.showModal(kickModal(id.serverId, id.steamId, name) as Parameters<ButtonInteraction['showModal']>[0]);
}

/** Confirmed: check the role again, kick, then record who did it in the channel. */
async function onConfirm(i: ModalSubmitInteraction, deps: GatewayDeps): Promise<void> {
  const id = parseKickId(i.customId);
  if (!id || id.step !== 'confirm') return;
  if (!mayKick(i, deps.modRoleId)) {
    await refuse(i, deps.modRoleId);
    return;
  }
  // The panel and the game can take a few seconds; Discord wants an answer within three.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = i.fields.getTextInputValue('reason') ?? '';
  const result = await kick(deps.warcon, id.serverId, id.steamId, reason);
  if (!result.ok) {
    await i.editReply(result.message);
    deps.logger.warn(`[${id.serverId}] kick of ${id.steamId} by ${modName(i)} failed: ${result.message}`);
    return;
  }

  const mod = modName(i);
  const player = playerNameFromTitle(i.message?.embeds[0]?.title) ?? id.steamId;
  deps.logger.info(`[${id.serverId}] ${mod} kicked ${id.steamId} via Discord`);
  // Nobody kicks twice: the button becomes a disabled "Kicked by <mod>" label.
  if (i.message) await i.message.edit({ components: [kickedRow(mod)] });
  if (i.channel && 'send' in i.channel) {
    await i.channel.send({
      content: kickLogLine(mod, player, serverLabel(id.serverId, deps.serverLabels), reason),
      allowedMentions: { parse: [] }
    });
  }
  await i.editReply('Kicked.');
}

function mayKick(i: ButtonInteraction | ModalSubmitInteraction, roleId: string): boolean {
  const roles = i.member?.roles;
  return hasRole(roles as Parameters<typeof hasRole>[0], roleId);
}

async function refuse(i: ButtonInteraction | ModalSubmitInteraction, roleId: string): Promise<void> {
  await i.reply({
    content: `Only <@&${roleId}> can kick from here.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}

/** How staff know the mod: their server nickname, else their display name, else username. */
function modName(i: ButtonInteraction | ModalSubmitInteraction): string {
  const member = i.member;
  if (member && 'displayName' in member) return member.displayName;
  if (member && 'nick' in member && member.nick) return member.nick;
  return i.user.globalName ?? i.user.username;
}
