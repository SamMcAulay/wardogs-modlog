import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction
} from 'discord.js';
import { serverLabel } from './discord.js';
import {
  actionModal,
  doneRows,
  hasRole,
  kick,
  kickLogLine,
  parseActionId,
  playerNameFromTitle,
  watch,
  watchLogLine,
  type ActionRow,
  type ButtonComponent
} from './player-actions.js';
import type { Logger } from './log.js';
import type { WarconClient } from './warcon.js';

export interface GatewayDeps {
  token: string;
  /** DISCORD_MOD_ROLE_ID: the role that may press Kick and Watch, the same one alerts ping */
  modRoleId: string;
  warcon: WarconClient;
  serverLabels: Record<string, string>;
  logger: Logger;
}

/**
 * The bot's live Discord connection, for the Kick and Watch buttons only: alerts are
 * still posted over REST. It asks for the Guilds intent alone (no privileged intents),
 * which is all an interaction needs. A failed login is logged and the bot carries on
 * posting alerts; only the buttons stop working.
 */
export function startGateway(deps: GatewayDeps): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (c) => {
    deps.logger.info(`discord: connected as ${c.user.tag}; Kick and Watch buttons are live`);
  });
  client.on(Events.Error, (err) => deps.logger.error(`discord: ${err.message}`));
  client.on(Events.InteractionCreate, (interaction) => {
    void handle(interaction, deps).catch((err: unknown) => {
      deps.logger.error(`button: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  client.login(deps.token).catch((err: unknown) => {
    deps.logger.error(
      `discord: gateway login failed — alerts still post, but the buttons won't work: ${
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

/** A button pressed: check the role, then ask for confirmation (visible only to the presser). */
async function onButton(i: ButtonInteraction, deps: GatewayDeps): Promise<void> {
  const id = parseActionId(i.customId);
  if (!id || id.step !== 'button') return;
  if (!mayAct(i, deps.modRoleId)) {
    await refuse(i, deps.modRoleId);
    return;
  }
  const name = playerNameFromTitle(i.message.embeds[0]?.title) ?? id.steamId;
  await i.showModal(
    actionModal(id.action, id.serverId, id.steamId, name) as Parameters<ButtonInteraction['showModal']>[0]
  );
}

/** Confirmed: check the role again, act, then record who did it in the channel. */
async function onConfirm(i: ModalSubmitInteraction, deps: GatewayDeps): Promise<void> {
  const id = parseActionId(i.customId);
  if (!id || id.step !== 'confirm') return;
  if (!mayAct(i, deps.modRoleId)) {
    await refuse(i, deps.modRoleId);
    return;
  }
  // The panel and the game can take a few seconds; Discord wants an answer within three.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const mod = modName(i);
  const reason = i.fields.getTextInputValue('reason') ?? '';
  const player = playerNameFromTitle(i.message?.embeds[0]?.title) ?? id.steamId;
  const where = serverLabel(id.serverId, deps.serverLabels);

  const result =
    id.action === 'kick'
      ? await kick(deps.warcon, id.serverId, id.steamId, reason)
      : await watch(deps.warcon, id.serverId, id.steamId, player, reason, mod);
  if (!result.ok) {
    await i.editReply(result.message);
    deps.logger.warn(`[${id.serverId}] ${id.action} of ${id.steamId} by ${mod}: ${result.message}`);
    return;
  }

  deps.logger.info(`[${id.serverId}] ${mod} ${id.action === 'kick' ? 'kicked' : 'watched'} ${id.steamId} via Discord`);
  // Only the pressed button changes: nobody does it twice, and the other button still works.
  if (i.message) {
    const done = id.action === 'kick' ? `Kicked by ${mod}` : `Watched by ${mod}`;
    await i.message.edit({ components: doneRows(rowsOf(i.message), `${id.action}:${id.serverId}:${id.steamId}`, done) });
  }
  if (i.channel && 'send' in i.channel) {
    await i.channel.send({
      content:
        id.action === 'kick'
          ? kickLogLine(mod, player, where, reason)
          : watchLogLine(mod, player, where, reason),
      allowedMentions: { parse: [] }
    });
  }
  await i.editReply(result.message);
}

/** The message's button rows as plain data, for `doneRows`. */
function rowsOf(message: Message): ActionRow<ButtonComponent>[] {
  return message.components.map((row) => row.toJSON()) as unknown as ActionRow<ButtonComponent>[];
}

function mayAct(i: ButtonInteraction | ModalSubmitInteraction, roleId: string): boolean {
  return hasRole(i.member?.roles as Parameters<typeof hasRole>[0], roleId);
}

async function refuse(i: ButtonInteraction | ModalSubmitInteraction, roleId: string): Promise<void> {
  await i.reply({
    content: `Only <@&${roleId}> can use these buttons.`,
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
