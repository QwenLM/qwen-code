/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { t } from '../i18n/index.js';
import { authCommandMetadata } from './auth-command-metadata.js';
import { commandMetadata } from './command-metadata.js';

interface RegistrationMetadata {
  command: string;
  describe: string;
  aliases?: readonly string[];
}

const updateMetadata = {
  ...commandMetadata.update,
  get describe() {
    return t(commandMetadata.update.describe);
  },
};

export async function registerTopLevelCommands(
  parser: Argv,
  rawArgv: readonly string[],
): Promise<void> {
  // Keep yargs builders synchronous so validation retains its .fail() path.
  const eager = rawArgv.some((arg) => arg.includes('get-yargs-completions'));

  async function register<U>(
    metadata: RegistrationMetadata,
    importer: () => Promise<CommandModule<unknown, U>>,
  ): Promise<void> {
    const names = [metadata.command.split(' ')[0], ...(metadata.aliases ?? [])];
    if (
      eager ||
      names.some((name) => rawArgv.some((arg) => arg.includes(name)))
    ) {
      parser.command(await importer());
      return;
    }

    parser.command({
      command: metadata.command,
      aliases: metadata.aliases,
      get describe() {
        return metadata.describe;
      },
      handler: () => {},
    });
  }

  await register(commandMetadata.mcp, () =>
    import('./mcp.js').then((module) => module.mcpCommand),
  );
  await register(commandMetadata.memory, () =>
    import('./memory.js').then((module) => module.memoryCommand),
  );
  await register(commandMetadata.extensions, () =>
    import('./extensions.js').then((module) => module.extensionsCommand),
  );
  await register(authCommandMetadata, () =>
    import('./auth.js').then((module) => module.authCommand),
  );
  await register(commandMetadata.hooks, () =>
    import('./hooks.js').then((module) => module.hooksCommand),
  );
  await register(commandMetadata.channel, () =>
    import('./channel.js').then((module) => module.channelCommand),
  );
  await register(commandMetadata.board, () =>
    import('./board.js').then((module) => module.boardCommand),
  );
  await register(commandMetadata.serve, () =>
    import('./serve.js').then((module) => module.serveCommand),
  );
  await register(commandMetadata.daemon, () =>
    import('./daemon.js').then((module) => module.daemonCommand),
  );
  await register(commandMetadata.attach, () =>
    import('./attach.js').then((module) => module.attachCommand),
  );
  await register(commandMetadata.sessions, () =>
    import('./sessions.js').then((module) => module.sessionsCommand),
  );
  await register(commandMetadata.agents, () =>
    import('./agents.js').then((module) => module.agentsCommand),
  );
  await register(commandMetadata.batch, () =>
    import('./batch.js').then((module) => module.batchCommand),
  );
  await register(updateMetadata, () =>
    import('./update.js').then((module) => module.updateCommand),
  );
  await register(commandMetadata.sandbox, () =>
    import('./sandbox.js').then((module) => module.sandboxCommand),
  );
}
