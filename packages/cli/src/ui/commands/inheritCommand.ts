/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';

export const inheritCommand: SlashCommand = {
  name: 'inherit',
  altNames: ['modeinherit', 'mi'],
  get description() {
    return t('manage mode inheritance (show chain, descendants)');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available',
      };
    }

    const modeManager = config.getModeManager();
    const trimmedArgs = args.trim();

    // No args — show help
    if (!trimmedArgs) {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Mode Inheritance**

Modes can inherit from other modes, overriding only specific fields.

**Usage:**

\`/inherit chain <mode>\` — Show inheritance chain
\`/inherit descendants <mode>\` — Show modes that inherit from this one
\`/inherit check <mode>\` — Check if mode inherits from another
\`/inherit resolved <mode>\` — Show fully resolved mode config

**Example MODE.md:**

\`\`\`markdown
---
name: my-dev
displayName: My Developer Mode
inheritedFrom: developer
temperature: 0.9
allowedTools: [read_file, write_file, edit]
---

# My Custom Developer Mode

## Additional Rules
- Always use TypeScript strict mode
- Write tests for new code
\`\`\`

This creates a custom developer mode based on the built-in one.`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /inherit chain <mode>
    if (trimmedArgs.startsWith('chain')) {
      const modeName = trimmedArgs.replace(/^chain\s+/, '').trim();
      const chain = modeManager.getModeInheritanceChain(modeName);

      if (chain.length === 0) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Mode "${modeName}" not found.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const lines: string[] = [
        `**Inheritance Chain for "${modeName}":**`,
        '',
        chain.join(' → '),
        '',
        chain.length === 1
          ? '(No inheritance — this is a base mode)'
          : `(${chain.length} modes in chain)`,
      ];

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /inherit descendants <mode>
    if (trimmedArgs.startsWith('descendants')) {
      const modeName = trimmedArgs.replace(/^descendants\s+/, '').trim();
      const descendants = modeManager.findModeDescendants(modeName);

      const lines: string[] = [
        `**Descendants of "${modeName}":**`,
        '',
      ];

      if (descendants.length === 0) {
        lines.push('No modes inherit from this mode.');
      } else {
        descendants.forEach((d) => {
          const chain = modeManager.getModeInheritanceChain(d.name);
          lines.push(
            `${d.icon || '📋'} **${d.displayName}** (\`${d.name}\`)`,
          );
          lines.push(`   Chain: ${chain.join(' → ')}`);
        });
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /inherit resolved <mode>
    if (trimmedArgs.startsWith('resolved')) {
      const modeName = trimmedArgs.replace(/^resolved\s+/, '').trim();
      const mode = modeManager.getResolvedMode(modeName);

      if (!mode) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Mode "${modeName}" not found.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const lines: string[] = [
        `**Resolved Config for "${modeName}":**`,
        '',
        `Name: \`${mode.name}\``,
        `Display: ${mode.icon} ${mode.displayName}`,
        `Description: ${mode.description}`,
        `Level: ${mode.level}`,
        mode.inheritedFrom ? `Inherits from: \`${mode.inheritedFrom}\`` : '(Base mode)',
        '',
        `**System Prompt:** (first 200 chars)`,
        '```',
        mode.systemPrompt.slice(0, 200) + (mode.systemPrompt.length > 200 ? '...' : ''),
        '```',
      ];

      if (mode.allowedTools) {
        lines.push('');
        lines.push(`**Allowed Tools (${mode.allowedTools.length}):** ${mode.allowedTools.join(', ')}`);
      }
      if (mode.deniedTools) {
        lines.push('');
        lines.push(`**Denied Tools (${mode.deniedTools.length}):** ${mode.deniedTools.join(', ')}`);
      }
      if (mode.allowedSubagents) {
        lines.push('');
        lines.push(`**Allowed Sub-agents:** ${mode.allowedSubagents.join(', ')}`);
      }
      if (mode.allowedSkills) {
        lines.push('');
        lines.push(`**Allowed Skills:** ${mode.allowedSkills.join(', ')}`);
      }
      if (mode.modelConfig) {
        lines.push('');
        lines.push(`**Model Config:**`);
        if (mode.modelConfig.temperature !== undefined) {
          lines.push(`  Temperature: ${mode.modelConfig.temperature}`);
        }
        if (mode.modelConfig.model) {
          lines.push(`  Model: ${mode.modelConfig.model}`);
        }
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown command: \`/inherit ${trimmedArgs}\`\n\nUse \`/inherit\` alone for help.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
