/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getScopedAutoMemoryDirs,
  listStructuredMemoryFiles,
} from '@qwen-code/core';
import { MessageType } from '../types.js';
import {
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MemoryManager } from '../components/views/MemoryManager.js';
import { MemoryOverview } from '../components/views/MemoryOverview.js';
import { parseSlashCommand } from '../../utils/commands.js';

// /memory reload was removed: AGENTS.md changes are picked up per-turn via
// attachment SHA-1 delta, structurally new AGENTS.md files are caught by JIT
// on the next read/write/edit, and trust-change events trigger
// MemoryContextManager.refresh() internally. Auto-memory MEMORY.md is
// fork-maintained — there is no human-edited state for reload to surface.

const manageCommand: SlashCommand = {
  name: 'manage',
  description: 'Open interactive TUI for managing auto-memory files',
  kind: CommandKind.BUILT_IN,
  requiredStartupGates: ['memory'],
  autoExecute: true,
  action: async (context): Promise<SlashCommandActionReturn | void> => {
    const config = context.services.agentContext?.config;
    if (!config) return;

    if (!config.isAutoMemoryEnabled()) {
      context.ui.addItem(
        {
          type: MessageType.WARNING,
          text: 'Auto-memory is not enabled. Enable it in settings to use /memory manage.',
        },
        Date.now(),
      );
      return;
    }

    // One independently enabled root or both USER + PROJECT roots.
    const roots = await Promise.all(
      getScopedAutoMemoryDirs(config).map(async ({ scope, dir }) => ({
        scope,
        dir,
        entries: await listStructuredMemoryFiles(dir),
      })),
    );

    return {
      type: 'custom_dialog',
      component: (
        <MemoryManager
          roots={roots}
          onClose={() => context.ui.removeComponent()}
        />
      ),
    };
  },
};

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'Commands for interacting with memory',
  kind: CommandKind.BUILT_IN,
  requiredStartupGates: ['memory'],
  autoExecute: true,
  subCommands: [manageCommand],
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    if (args) {
      const parsed = parseSlashCommand(`/${args}`, memoryCommand.subCommands!);
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }

    // Default action: open the interactive Memory Overview dialog.
    const config = context.services.agentContext?.config;
    if (!config) return;

    return {
      type: 'custom_dialog',
      component: (
        <MemoryOverview
          config={config}
          onClose={() => context.ui.removeComponent()}
        />
      ),
    };
  },
};
