/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
  OpenDialogActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  applyReasoningEffort,
  normalizeReasoningEffort,
  REASONING_EFFORT_TIERS,
} from '@qwen-code/qwen-code-core';
import { formatEffortChangeMessage } from './effort-utils.js';
import { getReasoningEffortsForConfig } from '../../acp-integration/model-configuration.js';

const TIER_LIST = REASONING_EFFORT_TIERS.join(', ');

export const effortCommand: SlashCommand = {
  name: 'effort',
  get description() {
    return t(
      'Set how hard reasoning-capable models think ({{tiers}}); mapped and clamped per provider.',
      { tiers: TIER_LIST },
    );
  },
  // The tiers show up as a placeholder via argumentHint rather than as
  // autocompletion suggestions: bare `/effort` should open the picker dialog
  // (no tier auto-selected), while `/effort <tier>` still sets one directly. A
  // completion function would surface the tiers as submenu-like entries and let
  // Enter auto-pick the first one, which we don't want here.
  argumentHint: '[low|medium|high|xhigh|max]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    actionArgs: string,
  ): Promise<MessageActionReturn | OpenDialogActionReturn> => {
    const { services } = context;
    const { config, settings } = services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    const args = context.invocation?.args?.trim() || actionArgs.trim();
    const availableTiers = getReasoningEffortsForConfig(config);
    const availableTierList = availableTiers.join(', ');

    // No argument: open the interactive picker, or (non-interactive/ACP) report
    // the current tier and the available options.
    if (!args) {
      if (availableTiers.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: t(
            'The current model does not expose reasoning effort tiers.',
          ),
        };
      }
      if (context.executionMode === 'interactive') {
        return { type: 'dialog', dialog: 'effort' };
      }
      const current = config.getReasoningEffort();
      return {
        type: 'message',
        messageType: 'info',
        content: current
          ? t(
              'Current reasoning effort: {{current}}\nAvailable: {{tiers}}\nUse "/effort <tier>" to change it.',
              { current, tiers: availableTierList },
            )
          : t(
              'Reasoning effort: not set (using the model/provider default).\nAvailable: {{tiers}}\nUse "/effort <tier>" to set it.',
              { tiers: availableTierList },
            ),
      };
    }

    const tier = normalizeReasoningEffort(args);
    if (!tier || !availableTiers.includes(tier)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Unknown reasoning effort "{{value}}". Choose one of: {{tiers}}.',
          { value: args, tiers: availableTierList },
        ),
      };
    }

    if (!settings) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Settings service not available.'),
      };
    }

    // Apply at runtime (takes effect next turn) and persist for future sessions.
    // Provider adapters clamp the tier to what the active model supports.
    applyReasoningEffort(config, tier);
    if (context.executionPolicy?.persistModelSelection !== false) {
      settings.setValue(
        getPersistScopeForModelSelection(settings),
        'model.reasoningEffort',
        tier,
      );
    }

    return {
      type: 'message',
      messageType: 'info',
      content: formatEffortChangeMessage(config, tier),
    };
  },
};
