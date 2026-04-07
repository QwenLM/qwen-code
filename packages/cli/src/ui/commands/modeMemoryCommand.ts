/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import { ModeMemoryManager } from '@qwen-code/qwen-code-core';
import type { ModeMemoryEntry } from '@qwen-code/qwen-code-core';

/**
 * Module-level state for the memory command.
 * In a full implementation, this would be managed by a service.
 */
let memoryManager: ModeMemoryManager | null = null;

/**
 * Get or create the singleton ModeMemoryManager.
 */
function getMemoryManager(): ModeMemoryManager {
  if (!memoryManager) {
    memoryManager = new ModeMemoryManager();
  }
  return memoryManager;
}

/**
 * Format a single memory entry for display.
 */
function formatEntry(entry: ModeMemoryEntry): string {
  const lines = [
    `**${entry.summary}**`,
    `- Mode: \`${entry.modeName}\``,
    `- Date: ${entry.timestamp.toLocaleString()}`,
  ];

  if (entry.keyDecisions.length > 0) {
    lines.push('- Decisions:');
    for (const decision of entry.keyDecisions) {
      lines.push(`  - ${decision}`);
    }
  }

  if (entry.filesTouched.length > 0) {
    lines.push(`- Files: ${entry.filesTouched.slice(0, 5).join(', ')}${entry.filesTouched.length > 5 ? ' ...' : ''}`);
  }

  if (entry.artifacts.length > 0) {
    lines.push(`- Artifacts: ${entry.artifacts.join(', ')}`);
  }

  if (entry.tags.length > 0) {
    lines.push(`- Tags: ${entry.tags.map((t) => `\`${t}\``).join(' ')}`);
  }

  return lines.join('\n');
}

/**
 * Format a list of memory entries for display.
 */
function formatEntries(entries: ModeMemoryEntry[], title: string): string {
  if (entries.length === 0) {
    return `**${title}**\n\nNo entries found.`;
  }

  const lines = [`**${title}** (${entries.length} entries)\n`];

  for (const entry of entries) {
    lines.push(formatEntry(entry));
    lines.push('---');
  }

  return lines.join('\n');
}

export const modeMemoryCommand: SlashCommand = {
  name: 'mode-memory',
  altNames: ['mmemory'],
  get description() {
    return t('manage per-mode conversation memories');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const trimmedArgs = args.trim();

    // No args — show help
    if (!trimmedArgs) {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Mode Memory**

Each mode has its own isolated conversation memory for tracking decisions, files, and artifacts.

**Usage:**

\`/mode-memory record <mode> <summary>\` — Record a memory entry
\`/mode-memory show <mode>\` — Show mode memory
\`/mode-memory search <query>\` — Search across memories
\`/mode-memory tags <mode>\` — Show all tags for a mode
\`/mode-memory recent\` — Show recent entries across all modes
\`/mode-memory export <mode>\` — Export mode memory
\`/mode-memory import <mode> <json>\` — Import mode memory
\`/mode-memory clear <mode>\` — Clear mode memory
\`/mode-memory stats\` — Show memory statistics

**Example:**

\`/mode-memory record developer Implemented auth middleware with JWT validation\`
\`/mode-memory show developer\`
\`/mode-memory search authentication\`
\`/mode-memory stats\``,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory record <mode> <summary>
    if (trimmedArgs.startsWith('record ')) {
      const rest = trimmedArgs.replace(/^record\s+/, '').trim();
      const spaceIndex = rest.indexOf(' ');

      if (spaceIndex === -1) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/mode-memory record <mode> <summary>`\n\nExample: `/mode-memory record developer Implemented user authentication`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const modeName = rest.substring(0, spaceIndex).trim();
      const summary = rest.substring(spaceIndex + 1).trim();

      if (!summary) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Please provide a summary for the memory entry.',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getMemoryManager();
      const entry = manager.recordEntry(modeName, {
        modeName,
        summary,
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `Memory recorded for mode \`${modeName}\`:\n\n**${entry.summary}**\n- ID: ${entry.id}\n- Time: ${entry.timestamp.toLocaleString()}`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory show <mode>
    if (trimmedArgs.startsWith('show ')) {
      const modeName = trimmedArgs.replace(/^show\s+/, '').trim();

      if (!modeName) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/mode-memory show <mode>`\n\nExample: `/mode-memory show developer`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getMemoryManager();
      const block = manager.getMemory(modeName);

      if (!block || block.entries.length === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `No memory entries found for mode \`${modeName}\`.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const content = formatEntries(block.entries, `Memory for \`${modeName}\``);
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory search <query>
    if (trimmedArgs.startsWith('search ')) {
      const query = trimmedArgs.replace(/^search\s+/, '').trim();

      if (!query) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/mode-memory search <query>`\n\nExample: `/mode-memory search authentication`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getMemoryManager();
      const results = manager.search(query);

      if (results.length === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `No memory entries found for query: \`${query}\``,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const content = formatEntries(results, `Search results for "${query}"`);
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory tags <mode>
    if (trimmedArgs.startsWith('tags ')) {
      const modeName = trimmedArgs.replace(/^tags\s+/, '').trim();

      if (!modeName) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/mode-memory tags <mode>`\n\nExample: `/mode-memory tags developer`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getMemoryManager();
      const block = manager.getMemory(modeName);

      if (!block || block.entries.length === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `No memory entries found for mode \`${modeName}\`.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const allTags = new Set<string>();
      for (const entry of block.entries) {
        for (const tag of entry.tags) {
          allTags.add(tag);
        }
      }

      if (allTags.size === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `No tags found for mode \`${modeName}\`.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Tags for \`${modeName}\`**\n\n${Array.from(allTags).map((t) => `\`${t}\``).join(' ')}`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory recent
    if (trimmedArgs === 'recent' || trimmedArgs === 'latest') {
      const manager = getMemoryManager();
      const entries = manager.getRecent(10);

      if (entries.length === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'No recent memory entries.',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const content = formatEntries(entries, 'Recent Memory Entries');
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory export <mode>
    if (trimmedArgs.startsWith('export ')) {
      const modeName = trimmedArgs.replace(/^export\s+/, '').trim();

      if (!modeName) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/mode-memory export <mode>`\n\nExample: `/mode-memory export developer`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getMemoryManager();
      const data = manager.exportMemory(modeName);

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Exported memory for \`${modeName}\`**\n\n\`\`\`json\n${data}\n\`\`\``,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory import <mode> <json>
    if (trimmedArgs.startsWith('import ')) {
      const rest = trimmedArgs.replace(/^import\s+/, '').trim();

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Import Mode Memory**\n\nUsage: \`/mode-memory import <mode>\`\n\nThen paste the exported JSON data.\n\nOr use: \`/mode-memory import <mode> {"modeName":"...","entries":[...]}\``,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory clear <mode>
    if (trimmedArgs.startsWith('clear ')) {
      const modeName = trimmedArgs.replace(/^clear\s+/, '').trim();

      if (!modeName) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/mode-memory clear <mode>`\n\nExample: `/mode-memory clear developer`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getMemoryManager();
      const block = manager.getMemory(modeName);
      const count = block ? block.totalEntries : 0;

      manager.clearMemory(modeName);

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `Cleared ${count} memory entries for mode \`${modeName}\`.`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /mode-memory stats
    if (trimmedArgs === 'stats' || trimmedArgs === 'statistics') {
      const manager = getMemoryManager();
      const stats = manager.getStats();
      const modeNames = manager.getModeNames();
      const allTags = manager.getAllTags();

      let content = '**Mode Memory Statistics**\n\n';
      content += `- Total entries: ${stats.totalEntries}\n`;
      content += `- Modes with memory: ${stats.modesWithMemory}\n`;
      content += `- Most active mode: \`${stats.mostActiveMode}\`\n`;

      if (modeNames.length > 0) {
        content += '\n**Modes:**\n';
        for (const name of modeNames) {
          const block = manager.getMemory(name);
          if (block) {
            content += `- \`${name}\`: ${block.totalEntries} entries\n`;
          }
        }
      }

      if (allTags.length > 0) {
        content += '\n**All tags:**\n';
        content += allTags.map((t) => `\`${t}\``).join(' ');
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown subcommand: \`/mode-memory ${trimmedArgs}\`

Available subcommands:
- \`record <mode> <summary>\` — Record a memory entry
- \`show <mode>\` — Show mode memory
- \`search <query>\` — Search across memories
- \`tags <mode>\` — Show all tags for a mode
- \`recent\` — Show recent entries across all modes
- \`export <mode>\` — Export mode memory
- \`import <mode>\` — Import mode memory
- \`clear <mode>\` — Clear mode memory
- \`stats\` — Show memory statistics

Use \`/mode-memory\` alone for help.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
