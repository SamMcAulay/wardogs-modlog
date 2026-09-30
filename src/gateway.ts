import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type Message,
  type ModalSubmitInteraction
} from 'discord.js';
import { serverLabel, type LinkConfig } from './discord.js';
import { LOOKUP_COMMAND, gatherLookup, lookupMessage, parsePlayerInput, type LookupDeps } from './lookup.js';
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
  /** `/lookup`'s data sources and links */
  lookup: LookupDeps & { links: LinkConfig };
}

/**
 * The bot's live Discord connection, for the Kick and Watch buttons and `/lookup`: alerts are
 * still posted over REST. It asks for the Guilds intent alone (no privileged intents),
 * which is all an interaction needs. A failed login is logged and the bot carries on
 * posting alerts; only the buttons and the command stop working.
 */
export function startGateway(deps: GatewayDeps): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (c) => {
    deps.logger.info(`discord: connected as ${c.user.tag}; Kick and Watch buttons are live`);
    for (const guild of c.guilds.cache.values()) void register(guild, deps.logger);
  });
  client.on(Events.GuildCreate, (guild) => void register(guild, deps.logger));
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

/**
 * `/lookup` per guild rather than globally: a guild command appears at once, a global one can
 * take an hour. `set` replaces the guild's commands, which are only ever this bot's own.
 */
async function register(guild: Guild, logger: Logger): Promise<void> {
  try {
    await guild.commands.set([LOOKUP_COMMAND]);
    logger.info(`discord: /lookup registered in ${guild.name}`);
  } catch (err) {
    logger.error(`discord: couldn't register /lookup in ${guild.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handle(interaction: Interaction, deps: GatewayDeps): Promise<void> {
  if (interaction.isChatInputCommand() && interaction.commandName === LOOKUP_COMMAND.name) {
    await onLookup(interaction, deps);
  } else if (interaction.isButton()) await onButton(interaction, deps);
  else if (interaction.isModalSubmit()) await onConfirm(interaction, deps);
}

/**
 * `/lookup`: mods only. The answer posts in the channel for the team to see; a refusal or a
 * malformed player is only shown to whoever typed it.
 */
async function onLookup(i: ChatInputCommandInteraction, deps: GatewayDeps): Promise<void> {
  if (!mayAct(i, deps.modRoleId)) {
    await refuse(i, deps.modRoleId, 'use /lookup');
    return;
  }
  const input = parsePlayerInput(i.options.getString('player', true));
  if (!input) {
    await i.reply({
      content:
        'Give a SteamID64 (`7656119…`, 17 digits) or a Steam profile link (`steamcommunity.com/profiles/…` or `/id/…`). In-game names aren\'t searched.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if ('vanity' in input && !deps.lookup.steam) {
    await i.reply({
      content: 'Custom profile links need STEAM_API_KEY to resolve. Use the SteamID64 or the `/profiles/` link.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  // Warcon and Steam together can take longer than the three seconds Discord allows.
  await i.deferReply();

  let steamId: string;
  if ('vanity' in input) {
    const resolved = await deps.lookup.steam!.resolveVanity(input.vanity).catch(() => undefined);
    if (!resolved) {
      await i.editReply(
        resolved === null
          ? `No Steam profile at steamcommunity.com/id/${input.vanity}.`
          : "Steam didn't answer, so that profile link couldn't be resolved. Try the SteamID64."
      );
      return;
    }
    steamId = resolved;
  } else steamId = input.steamId;

  let data;
  try {
    data = await gatherLookup(deps.lookup, steamId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn(`lookup of ${steamId}: ${message}`);
    await i.editReply(`Couldn't read the player's dossier from Warcon: ${message}`);
    return;
  }
  deps.logger.info(`${modName(i)} looked up ${steamId}`);
  const message = lookupMessage(data, deps.lookup.links, deps.lookup.serverId);
  await i.editReply({
    embeds: message.embeds,
    components: message.components,
    allowedMentions: { parse: [] }
  });
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

type Acted = ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction;

function mayAct(i: Acted, roleId: string): boolean {
  return hasRole(i.member?.roles as Parameters<typeof hasRole>[0], roleId);
}

async function refuse(i: Acted, roleId: string, what = 'use these buttons'): Promise<void> {
  await i.reply({
    content: `Only <@&${roleId}> can ${what}.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}

/** How staff know the mod: their server nickname, else their display name, else username. */
function modName(i: Acted): string {
  const member = i.member;
  if (member && 'displayName' in member) return member.displayName;
  if (member && 'nick' in member && member.nick) return member.nick;
  return i.user.globalName ?? i.user.username;
}
