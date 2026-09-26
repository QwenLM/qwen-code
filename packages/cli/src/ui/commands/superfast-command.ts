/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { SettingScope } from '../../config/settings.js';
import { probeBackend } from '@qwen-code/qwen-code-core/superfast/decision-gate.js';

/**
 * `/superfast [on|off|status]` — the user-facing switch for the optional
 * System One decision gate.
 *
 * The gate is off by default. Enabling it makes the harness ask a small local
 * decision model (Von) about each turn so it can skip expensive work on
 * obvious requests. It fails open: if the model is missing or unsure, the
 * harness behaves exactly as if the feature were off. The backend itself is
 * installed out-of-band with the `von-install` command.
 */
export const superfastCommand: SlashCommand = {
  name: 'superfast',
  get description() {
    return t('Toggle the Superfast decision gate (local System One model)');
  },
  argumentHint: '<on|off|status>',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const { config, settings } = context.services;
    const sub = args.trim().toLowerCase();

    if (sub === 'on' || sub === 'off') {
      const enabled = sub === 'on';
      settings.setValue(SettingScope.User, 'superfast.enabled', enabled);
      const effective = settings.merged?.superfast?.enabled;
      if (effective !== enabled) {
        const scope =
          settings.system?.settings?.superfast?.enabled !== undefined
            ? 'system'
            : settings.workspace?.settings?.superfast?.enabled !== undefined
              ? 'workspace'
              : 'a higher scope';
        return {
          type: 'message',
          messageType: 'warning',
          content: t(
            'Superfast {{requested}} was saved to your user settings, but a {{scope}}-scope setting overrides it, so the effective value is still {{effective}}.',
            {
              requested: enabled ? 'enabling' : 'disabling',
              scope,
              effective: effective ? 'on' : 'off',
            },
          ),
        };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: enabled
          ? t(
              'Superfast enabled. Restart Qwen Code for the decision gate to start classifying turns. It runs in shadow mode and fails open if the model is unavailable.',
            )
          : t(
              'Superfast disabled. Restart Qwen Code for the change to take effect; the harness runs normally.',
            ),
      };
    }

    if (sub && sub !== 'status') {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /superfast <on|off|status>'),
      };
    }

    // status
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not available.'),
      };
    }
    const s = config.getSuperfastSettings();
    if (!s.enabled) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Superfast is OFF. Run /superfast on to enable it (install the backend first with: von-install).',
        ),
      };
    }
    const healthy = await probeBackend(s);
    return {
      type: 'message',
      messageType: healthy ? 'info' : 'warning',
      content: healthy
        ? t(
            'Superfast is ON. Backend reachable at {{endpoint}} (model {{model}}).',
            { endpoint: s.endpoint, model: s.model },
          )
        : t(
            'Superfast is ON but the backend at {{endpoint}} is not reachable. The gate fails open (normal behaviour). Start it with `von serve` or run von-install.',
            { endpoint: s.endpoint },
          ),
    };
  },
};
