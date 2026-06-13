/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  NormalizedMessage,
  NormalizedSlashCommand,
  NormalizedComponent,
} from './dispatch.js';

/**
 * Pure normalization of discord.js event objects into the dispatcher's
 * transport-agnostic shapes (`add-discord-bridge`). This is the seam that keeps
 * discord.js out of the dispatcher and out of the tests: the functions below read
 * only a minimal structural slice of each discord.js object (declared inline), so
 * they're exercised with plain literals — no Client, no socket, no bot token.
 * The thin gateway shell (`gateway.ts`) does nothing but hand real discord.js
 * objects to these functions and route the result to dispatch.
 *
 * Every id is read as the STRING discord.js already provides (snowflakes), never
 * coerced. The invoking user is always read from `.user.id` (present in guilds
 * and DMs alike), avoiding the null-`member` case in DMs.
 */

/** The structural slice of a discord.js Message the bridge reads. */
export interface RawMessage {
  channelId: string;
  author: { id: string; bot: boolean };
  content: string;
}

/** The structural slice of a discord.js ChatInputCommandInteraction we read. */
export interface RawChatInput {
  id: string;
  token: string;
  channelId: string;
  guildId: string | null;
  commandName: string;
  user: { id: string };
  options: { getSubcommand(): string; getString(name: string): string | null };
}

/** The structural slice of a discord.js ButtonInteraction we read. */
export interface RawButton {
  id: string;
  token: string;
  channelId: string;
  customId: string;
  user: { id: string };
}

/** The slash command names the bridge handles. */
const SLASH_NAMES = new Set(['attach', 'detach', 'status']);

/** Discord application-command option type discriminators. */
const OPTION_TYPE = { subCommand: 1, string: 3 } as const;

/**
 * The `/qwen` slash command definition registered at boot (subcommands
 * attach/detach/status). Plain JSON so it can be PUT to Discord's REST command
 * registration endpoint without discord.js builders.
 */
export const QWEN_COMMAND = {
  name: 'qwen',
  description: 'Control the qwen session bound to this channel',
  options: [
    {
      type: OPTION_TYPE.subCommand,
      name: 'attach',
      description: 'Bind this channel to a qwen session',
      options: [
        {
          type: OPTION_TYPE.string,
          name: 'session',
          description: 'The session id to bind',
          required: true,
        },
      ],
    },
    {
      type: OPTION_TYPE.subCommand,
      name: 'detach',
      description: 'Unbind this channel',
    },
    {
      type: OPTION_TYPE.subCommand,
      name: 'status',
      description: 'Show the current binding and usage',
    },
  ],
} as const;

/** Normalize a discord.js Message into a dispatcher message. */
export function normalizeMessage(m: RawMessage): NormalizedMessage {
  return {
    channelId: m.channelId,
    authorId: m.author.id,
    isBot: m.author.bot,
    content: m.content,
  };
}

/**
 * Normalize a `/qwen <sub>` chat-input interaction, or null if it isn't one of
 * ours (foreign command name or unhandled subcommand). The attach session arg is
 * read from the `session` string option.
 */
export function normalizeChatInput(
  i: RawChatInput,
): NormalizedSlashCommand | null {
  if (i.commandName !== 'qwen') return null;
  let sub: string;
  try {
    sub = i.options.getSubcommand();
  } catch {
    return null; // no subcommand present
  }
  if (!SLASH_NAMES.has(sub)) return null;
  const name = sub as 'attach' | 'detach' | 'status';
  return {
    interactionId: i.id,
    interactionToken: i.token,
    channelId: i.channelId,
    guildId: i.guildId ?? '',
    userId: i.user.id,
    name,
    arg: name === 'attach' ? (i.options.getString('session') ?? '') : undefined,
  };
}

/** Normalize a button interaction into a dispatcher component event. */
export function normalizeButton(i: RawButton): NormalizedComponent {
  return {
    interactionId: i.id,
    interactionToken: i.token,
    channelId: i.channelId,
    userId: i.user.id,
    customId: i.customId,
  };
}
