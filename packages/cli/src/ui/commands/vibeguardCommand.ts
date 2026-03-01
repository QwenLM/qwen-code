/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

function formatStatusMessage(stats: {
  enabled: boolean;
  mappings: number;
  prefix: string;
}): string {
  const enabledLine = `Enabled (this session): ${stats.enabled ? 'true' : 'false'}`;
  const mappingsLine = `Mappings (in-memory): ${stats.mappings}`;
  const formatLine = `Placeholder format: ${stats.prefix}<CATEGORY>_<hash12>__`;

  const configHint = `To enable via settings.json (requires restart):
  "security": {
    "redaction": {
      "enabled": true,
      "placeholderPrefix": "${stats.prefix}",
      "keywords": { "example-secret-123": "API_KEY" },
      "patterns": { "ghp_[A-Za-z0-9]{36}": "GITHUB_TOKEN" },
      "builtins": ["email", "uuid", "ipv4"],
      "exclude": ["localhost", "127.0.0.1"],
      "ttlMinutes": 60,
      "maxSize": 10000
    }
  }`;

  return [
    'VibeGuard-style client-side redaction',
    enabledLine,
    mappingsLine,
    formatLine,
    '',
    'Usage:',
    '  /vibeguard status',
    '  /vibeguard on',
    '  /vibeguard off',
    '',
    configHint,
  ].join('\n');
}

export const vibeguardCommand: SlashCommand = {
  name: 'vibeguard',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Manage client-side redaction (VibeGuard-style placeholders)');
  },
  action: async (context, args): Promise<MessageActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config is not available.'),
      };
    }

    const sub = args.trim().toLowerCase();
    if (sub === 'on' || sub === 'enable') {
      config.setRedactionEnabled(true);
    } else if (sub === 'off' || sub === 'disable') {
      config.setRedactionEnabled(false);
    } else if (sub === '' || sub === 'status') {
      // no-op
    } else {
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown subcommand: ${sub}\n\nTry: /vibeguard status|on|off`,
      };
    }

    const stats = config.getRedactionManager().getStats();
    return {
      type: 'message',
      messageType: 'info',
      content: formatStatusMessage(stats),
    };
  },
};
