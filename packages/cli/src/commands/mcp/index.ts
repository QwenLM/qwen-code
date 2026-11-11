/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp' command
import { Command } from '@commander-js/extra-typings';
import type { McpCommandOptions } from './options.js';
import { createAddCommand } from './add.js';
import { createAddJsonCommand } from './addJson.js';
import { createRemoveCommand } from './remove.js';
import { createGetCommand } from './get.js';
import { createListCommand } from './list.js';
import { createEnableCommand } from './enable.js';
import { createDisableCommand } from './disable.js';
import { createResetProjectChoicesCommand } from './resetProjectChoices.js';

export function createMcpCommand(options: McpCommandOptions = {}): Command {
  const cmd = new Command('mcp').description(
    'Configure and manage MCP servers',
  );

  cmd.hook('preAction', async () => {
    const { initializeOutputListenersAndFlush } = await import(
      '../../utils/outputListeners.js'
    );
    initializeOutputListenersAndFlush();
  });

  cmd.addCommand(createAddCommand(options));
  cmd.addCommand(createAddJsonCommand(options));
  cmd.addCommand(createRemoveCommand(options));
  cmd.addCommand(createGetCommand(options));
  cmd.addCommand(createListCommand(options));
  cmd.addCommand(createEnableCommand(options));
  cmd.addCommand(createDisableCommand(options));
  cmd.addCommand(createResetProjectChoicesCommand());

  // `qwen mcp` with no subcommand prints the help text
  // directly (no "Error: ..." prefix, no non-zero exit).
  cmd.action(async () => {
    const { exitCli } = await import('../../utils/exitCli.js');
    cmd.outputHelp();
    await exitCli(0);
  });

  return cmd;
}
