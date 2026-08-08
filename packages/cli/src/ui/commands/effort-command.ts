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
  clampReasoningEffort,
  getSupportedReasoningEffortTiers,
  normalizeReasoningEffort,
} from '@qwen-code/qwen-code-core';

export const effortCommand: SlashCommand = {
  name: 'effort',
  get description() {
    return t(
      'Set how hard reasoning-capable models think; available tiers depend on the active provider/model.',
    );
  },
  // Keep the static hint generic because the supported tiers are model-aware.
  // Bare `/effort` opens the picker; `/effort <tier>` still sets one directly.
  argumentHint: '<tier>',
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

    const supportedTiers = getSupportedReasoningEffortTiers(
      config.getAuthType(),
      config.getModel(),
    );
    const tierList = supportedTiers.join(', ');
    const args = context.invocation?.args?.trim() || actionArgs.trim();

    // No argument: open the interactive picker, or (non-interactive/ACP) report
    // the current tier and the available options.
    if (!args) {
      if (context.executionMode === 'interactive') {
        return { type: 'dialog', dialog: 'effort' };
      }
      const configuredEffort = config.getReasoningEffort();
      const current = configuredEffort
        ? clampReasoningEffort(configuredEffort, supportedTiers)
        : undefined;
      return {
        type: 'message',
        messageType: 'info',
        content: current
          ? t(
              'Current reasoning effort: {{current}}\nAvailable: {{tiers}}\nUse "/effort <tier>" to change it.',
              { current, tiers: tierList },
            )
          : t(
              'Reasoning effort: not set (using the model/provider default).\nAvailable: {{tiers}}\nUse "/effort <tier>" to set it.',
              { tiers: tierList },
            ),
      };
    }

    const tier = normalizeReasoningEffort(args);
    if (!tier) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Unknown reasoning effort "{{value}}". Choose one of: {{tiers}}.',
          { value: args, tiers: tierList },
        ),
      };
    }
    if (!supportedTiers.includes(tier)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Reasoning effort "{{value}}" is not supported by the active provider/model. Choose one of: {{tiers}}.',
          { value: args, tiers: tierList },
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
    config.setReasoningEffort(tier);
    settings.setValue(
      getPersistScopeForModelSelection(settings),
      'model.reasoningEffort',
      tier,
    );

    // `setReasoningEffort` is a no-op when thinking is explicitly disabled
    // (`reasoning: false`), so effort cannot silently re-enable it. The tier is
    // still persisted for future sessions, but report that it won't take effect
    // yet instead of a misleading success message.
    if (config.getReasoningEffort() !== tier) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Reasoning effort set to {{tier}}, but thinking is currently disabled — it will take effect when thinking is re-enabled.',
          { tier },
        ),
      };
    }

    // Report the requested tier, not an effective one: provider adapters clamp
    // per active model (e.g. 'max' → 'high' on most Anthropic models, xhigh/max
    // → HIGH on Gemini), and that resolution happens per request at send time,
    // so the actual tier on the wire may differ from what's shown here.
    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'Reasoning effort: {{tier}} (requested; the effective tier depends on the active provider/model).',
        { tier },
      ),
    };
  },
};
