/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import {
  QWEN_COMMAND,
  normalizeMessage,
  normalizeChatInput,
  normalizeButton,
} from './normalize.js';
import type { GatewayController, GatewayHandlers } from './runner.js';

/**
 * The thin discord.js connection shell (`add-discord-bridge`). Per the operator's
 * choice (spec design D2), discord.js owns the stateful gateway protocol —
 * HELLO/heartbeat, IDENTIFY, RESUME/reconnect, sequence tracking — that would be
 * error-prone to hand-roll and that cannot be verified in this environment. This
 * module does NOTHING but: register the `/qwen` slash command, log in, and hand
 * each inbound discord.js event to the pure {@link normalizeMessage} /
 * {@link normalizeChatInput} / {@link normalizeButton} functions, routing the
 * result to the runner's handlers. All event callbacks self-catch so one bad
 * event can't tear down the connection.
 *
 * VERIFICATION CEILING: this is the one module that is NOT unit-tested — it is a
 * straight-line adapter over discord.js, exercised only by a live connection
 * (no real Discord here). Everything it routes TO (normalize, dispatch, render,
 * the runner) IS tested.
 */
export interface DiscordGatewayConfig {
  botToken: string;
  applicationId: string;
  /** When set, register the command guild-scoped (fast); else globally. */
  guildId?: string;
  log?: (msg: string) => void;
}

export class DiscordGateway implements GatewayController {
  private readonly cfg: DiscordGatewayConfig;
  private readonly log: (msg: string) => void;

  constructor(cfg: DiscordGatewayConfig) {
    this.cfg = cfg;
    this.log = cfg.log ?? (() => {});
  }

  async start(signal: AbortSignal): Promise<void> {
    // Register the slash command before logging in so it's available promptly.
    await this.registerCommands();

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    client.once(Events.ClientReady, (c) => {
      this.log(`discord bridge: logged in as ${c.user.tag}`);
    });
    client.on(Events.Error, (e) => {
      this.log(
        `discord bridge: client error (${e.name}); discord.js will retry`,
      );
    });

    return new Promise<void>((resolve) => {
      // handlers wired below by the caller via the runner; see makeGateway().
      this.handlers = this.handlers ?? noopHandlers;

      client.on(Events.MessageCreate, (m) => {
        try {
          this.handlers.onMessage(normalizeMessage(m));
        } catch {
          // one bad message must not kill the connection
        }
      });
      client.on(Events.InteractionCreate, (i) => {
        try {
          if (i.isChatInputCommand()) {
            const c = normalizeChatInput(i);
            if (c) this.handlers.onSlash(c);
          } else if (i.isButton()) {
            this.handlers.onButton(normalizeButton(i));
          }
        } catch {
          // one bad interaction must not kill the connection
        }
      });

      const onAbort = () => {
        void client.destroy();
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      void client.login(this.cfg.botToken).catch((e: unknown) => {
        this.log(
          `discord bridge: login failed (${(e as Error)?.name ?? 'error'})`,
        );
        resolve();
      });
    });
  }

  /** Set by {@link makeDiscordGateway} so the runner can inject its handlers. */
  private handlers: GatewayHandlers = noopHandlers;
  setHandlers(handlers: GatewayHandlers): void {
    this.handlers = handlers;
  }

  private async registerCommands(): Promise<void> {
    try {
      const rest = new REST({ version: '10' }).setToken(this.cfg.botToken);
      const route = this.cfg.guildId
        ? Routes.applicationGuildCommands(
            this.cfg.applicationId,
            this.cfg.guildId,
          )
        : Routes.applicationCommands(this.cfg.applicationId);
      await rest.put(route, { body: [QWEN_COMMAND] });
      this.log(
        `discord bridge: registered /qwen command${this.cfg.guildId ? ` (guild ${this.cfg.guildId})` : ' (global)'}`,
      );
    } catch (e) {
      this.log(
        `discord bridge: command registration failed (${(e as Error)?.name ?? 'error'}); continuing`,
      );
    }
  }
}

const noopHandlers: GatewayHandlers = {
  onMessage: () => {},
  onSlash: () => {},
  onButton: () => {},
};

/**
 * Adapt a {@link DiscordGateway} to the runner's `makeGateway` factory: the
 * runner passes its handlers in, we set them on the gateway, and return the
 * gateway as the {@link GatewayController}.
 */
export function makeDiscordGateway(
  cfg: DiscordGatewayConfig,
): (handlers: GatewayHandlers) => GatewayController {
  const gw = new DiscordGateway(cfg);
  return (handlers) => {
    gw.setHandlers(handlers);
    return gw;
  };
}
