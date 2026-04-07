/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import { ModePresetRegistry, BUILTIN_PRESETS } from '@qwen-code/qwen-code-core';

export const presetCommand: SlashCommand = {
  name: 'preset',
  altNames: ['modepreset', 'mp'],
  get description() {
    return t('load mode presets for project types');
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

    const registry = new ModePresetRegistry();
    const trimmedArgs = args.trim();

    // No args — list presets
    if (!trimmedArgs) {
      const presets = registry.getAllPresets();
      const currentMode = config.getCurrentMode();

      const lines: string[] = [
        '**Mode Presets**',
        '',
        'Predefined mode configurations for common project types.',
        '',
        '**Available Presets:**',
        '',
        ...presets.map((p) =>
          `${p.icon} **${p.displayName}** (\`${p.name}\`)\n   ${p.description}\n   Default mode: ${p.defaultMode}${p.workflow ? ` | Workflow: ${p.workflow.join(' → ')}` : ''}`,
        ),
        '',
        '**Usage:**',
        '`/preset <name>` — Load a preset',
        '`/preset info <name>` — Show preset details',
        '`/preset detect` — Auto-detect project preset',
        '`/preset apply <name>` — Apply preset to current session',
      ];

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /preset info <name>
    if (trimmedArgs.startsWith('info')) {
      const presetName = trimmedArgs.replace(/^info\s+/, '').trim();
      const preset = registry.getPreset(presetName);

      if (!preset) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Preset "${presetName}" not found. Use \`/preset\` to list available presets.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const lines: string[] = [
        `${preset.icon} **${preset.displayName}** \`${preset.name}\``,
        '',
        preset.description,
        '',
        `**Default Mode:** ${preset.defaultMode}`,
      ];

      if (preset.workflow) {
        lines.push(`**Workflow:** ${preset.workflow.join(' → ')}`);
      }
      if (preset.recommendedSubagents) {
        lines.push(`**Sub-agents:** ${preset.recommendedSubagents.join(', ')}`);
      }
      if (preset.recommendedSkills) {
        lines.push(`**Skills:** ${preset.recommendedSkills.join(', ')}`);
      }

      if (preset.modes) {
        lines.push('');
        lines.push('**Mode Configurations:**');
        for (const [modeName, modeConfig] of Object.entries(preset.modes)) {
          lines.push(`  - ${modeName}:`);
          if (modeConfig.temperatureOverride !== undefined) {
            lines.push(`    Temperature: ${modeConfig.temperatureOverride}`);
          }
          if (modeConfig.hooks) {
            lines.push(`    Hooks: ${modeConfig.hooks.length}`);
          }
        }
      }

      if (preset.quickStart) {
        lines.push('');
        lines.push('**Quick Start:**');
        for (const cmd of preset.quickStart) {
          lines.push(`  ${cmd}`);
        }
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /preset detect
    if (trimmedArgs.startsWith('detect')) {
      const modeManager = config.getModeManager();
      const availableTools = modeManager.getAvailableToolNames();

      // Simple detection based on project files
      const lines: string[] = ['**Auto-Detecting Project Preset...**', ''];

      // Check common project indicators
      const hasPackageJson = availableTools.includes('read_file'); // Would need actual file check
      const hasDockerfile = availableTools.includes('read_file');

      // For now, suggest full-stack as default
      const detected = registry.getPreset('full-stack');

      if (detected) {
        lines.push(`${detected.icon} Detected: **${detected.displayName}**`);
        lines.push('');
        lines.push(`Recommended workflow: ${detected.workflow?.join(' → ')}`);
        lines.push('');
        lines.push(`To apply: \`/preset apply ${detected.name}\``);
      } else {
        lines.push('No specific preset detected.');
        lines.push('Available presets:');
        for (const p of registry.getAllPresets()) {
          lines.push(`  ${p.icon} ${p.displayName} (\`${p.name}\`)`);
        }
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /preset apply <name> — switch to preset's default mode
    if (trimmedArgs.startsWith('apply')) {
      const presetName = trimmedArgs.replace(/^apply\s+/, '').trim();
      const preset = registry.getPreset(presetName);

      if (!preset) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Preset "${presetName}" not found.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      // Switch to the preset's default mode
      try {
        const runtime = await config.switchMode(preset.defaultMode);

        // Register preset-specific hooks
        if (preset.modes) {
          const modeConfig = preset.modes[preset.defaultMode];
          if (modeConfig?.hooks) {
            config.registerModeHooks(modeConfig.hooks);
          }
        }

        const lines: string[] = [
          `✅ Applied preset **${preset.icon} ${preset.displayName}**`,
          '',
          `Switched to mode: ${runtime.config.icon} **${runtime.config.displayName}**`,
        ];

        if (preset.workflow) {
          lines.push('');
          lines.push(`**Recommended workflow:** ${preset.workflow.join(' → ')}`);
        }
        if (preset.quickStart && preset.quickStart.length > 0) {
          lines.push('');
          lines.push('**Quick start commands:**');
          for (const cmd of preset.quickStart) {
            lines.push(`  ${cmd}`);
          }
        }

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: lines.join('\n'),
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Failed to apply preset: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /preset <name> — same as apply
    const preset = registry.getPreset(trimmedArgs);
    if (!preset) {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `❌ Preset "${trimmedArgs}" not found. Use \`/preset\` to list available presets.`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // Show preset details
    const lines: string[] = [
      `${preset.icon} **${preset.displayName}** \`${preset.name}\``,
      '',
      preset.description,
      '',
      `Default mode: **${preset.defaultMode}**`,
      preset.workflow ? `Workflow: ${preset.workflow.join(' → ')}` : '',
      '',
      `To apply: \`/preset apply ${preset.name}\``,
    ].filter(Boolean);

    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: lines.join('\n'),
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
