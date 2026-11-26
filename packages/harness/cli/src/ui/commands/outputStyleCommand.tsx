/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getErrorMessage,
  type OutputStyleConfig,
} from '@qwen-code/core';
import { SettingScope } from '../../config/settings.js';
import { OutputStyleBrowser } from '../components/OutputStyleBrowser.js';
import { MessageType } from '../types.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';

async function outputStyleAction(
  context: CommandContext,
): Promise<SlashCommandActionReturn> {
  const config = context.services.agentContext?.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    };
  }

  let styles: Record<string, OutputStyleConfig | null>;
  let definitions: OutputStyleConfig[];
  try {
    [styles, definitions] = await Promise.all([
      config.getAvailableOutputStyles(),
      config.getAvailableOutputStyleDefinitions(),
    ]);
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Unable to load output styles: ${getErrorMessage(error)}`,
    };
  }

  const activeStyleName =
    config.getOutputStyle()?.name ?? DEFAULT_OUTPUT_STYLE_NAME;
  const localOutputStyle = context.services.settings.forScope(
    SettingScope.Local,
  ).settings.outputStyle;
  const configuredStyleName =
    typeof localOutputStyle === 'string' ? localOutputStyle : undefined;

  return {
    type: 'custom_dialog',
    component: (
      <OutputStyleBrowser
        styles={styles}
        definitions={definitions}
        activeStyleName={activeStyleName}
        configuredStyleName={configuredStyleName}
        onSelect={(name, style) => {
          if (style?.forceForPlugin) {
            return;
          }
          const saved = context.services.settings.setValue(
            SettingScope.Local,
            'outputStyle',
            name,
          );
          if (!saved) return;
          config.setRequestedOutputStyleName(name);
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: `Output style "${name}" saved for this project. Run /clear or /new to apply it. The current conversation is unchanged.`,
            },
            Date.now(),
          );
        }}
        onExit={() => context.ui.setCustomDialog(null)}
      />
    ),
  };
}

export const outputStyleCommand: SlashCommand = {
  name: 'output-style',
  description: 'Configure the output style for the next conversation',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: false,
  bridgeCommandType: 'local-jsx',
  requiredStartupGates: ['commands'],
  action: outputStyleAction,
};
