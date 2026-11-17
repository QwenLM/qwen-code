export { QQChannel } from './QQChannel.js';

import { QQChannel } from './QQChannel.js';
import { startQrLogin } from './login.js';
import type { ChannelPlugin } from '@qwen-code/channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'qq',
  displayName: 'QQ',
  // Both appID and appSecret are optional at config level because
  // fetchToken() resolves them via a fallback chain:
  //   config values → persisted credentials file → QR code login
  // If we required them here, parseChannelConfig() would reject the config
  // before QQChannel is ever constructed — QR-only login would be unreachable
  // through the built-in channel path.
  requiredConfigFields: [],
  management: {
    qrLogin: { start: startQrLogin },
    fields: [
      {
        key: 'appID',
        label: 'App ID',
        kind: 'string',
        envResolvable: true,
        description: 'Leave empty to bind by scanning a QR code instead',
      },
      {
        key: 'appSecret',
        label: 'App Secret',
        kind: 'secret',
        envResolvable: true,
        description: 'Leave empty to bind by scanning a QR code instead',
      },
      {
        key: 'sandbox',
        label: 'Sandbox Environment',
        kind: 'boolean',
        default: 'false',
        description: 'Use the QQ sandbox API instead of production',
      },
      {
        key: 'groupAllPolicy',
        label: 'Non-Mention Group Messages',
        kind: 'enum',
        default: 'log',
        description:
          'How to handle group messages that do not mention the bot. Requires Per Thread sessions, Named Sessions off, and Require Mention off for a group.',
        options: [
          { value: 'log', label: 'Log Only' },
          { value: 'keyword', label: 'Keyword Triggered' },
          { value: 'all', label: 'Reply To All' },
        ],
      },
      {
        key: 'keywordTriggers',
        label: 'Keyword Triggers',
        kind: 'string-list',
        description:
          'Case-insensitive keywords that trigger a reply when the policy is Keyword Triggered',
      },
      {
        key: 'allowMention',
        label: 'Allow Mention Passthrough',
        kind: 'boolean',
        default: 'true',
        description:
          'Keep raw mention tags so the model can mention group members',
      },
      {
        key: 'chatTypes',
        label: 'Chat Types',
        kind: 'record',
        description:
          'Map chat openid to "c2c" or "group" for scheduled messages to chats not yet seen inbound',
      },
      {
        key: 'cron-msg-experimental',
        label: 'Experimental Scheduled Messages',
        kind: 'boolean',
        default: 'false',
        description:
          'Enable experimental cron message features at your own risk',
      },
      {
        key: 'bufferFlushLength',
        label: 'Buffer Flush Length',
        kind: 'number',
        exclusiveMinimum: 0,
        description:
          'Characters buffered before forcing a flush. Default 4096.',
      },
      {
        key: 'maxReconnectAttempts',
        label: 'Max Reconnect Attempts',
        kind: 'number',
        description:
          'Reconnect attempts before giving up. Default 20; 0 is unlimited.',
      },
      {
        key: 'maxFlushRetries',
        label: 'Max Flush Retries',
        kind: 'number',
        description:
          'Delivery retries per streamed message. Default 3; 0 is unlimited.',
      },
      {
        key: 'maxGwRetries',
        label: 'Max Gateway Retries',
        kind: 'number',
        description:
          'Gateway retries per reconnect cycle. Default 5; 0 is unlimited.',
      },
    ],
    validateConfig: (config) => {
      const policy = config['groupAllPolicy'];
      if (policy !== 'keyword' && policy !== 'all') return undefined;
      // multiSession pins sessionScope to 'user', which fragments group
      // messages per sender, so the two features cannot coexist.
      if (config['multiSession'] === true) {
        return 'Non-mention group messages are not supported with Named Sessions enabled; turn Named Sessions off or choose Log Only.';
      }
      // Absent scope resolves to this plugin's defaultSessionScope.
      const scope = config['sessionScope'] ?? 'thread';
      if (scope !== 'thread') {
        return 'Non-mention group messages require Session Scope "Per Thread"; other scopes either fragment group messages per sender or merge direct messages into the group context.';
      }
      // GroupGate accepts a per-group override, not just the wildcard entry.
      const groups = config['groups'];
      const anyMentionOff =
        groups !== null &&
        typeof groups === 'object' &&
        Object.values(groups as Record<string, unknown>).some(
          (group) =>
            group !== null &&
            typeof group === 'object' &&
            (group as Record<string, unknown>)['requireMention'] === false,
        );
      if (!anyMentionOff) {
        return 'Non-mention group messages require "Require Mention" to be off for at least one group, otherwise the group gate drops them.';
      }
      if (policy === 'keyword') {
        const triggers = config['keywordTriggers'];
        if (!Array.isArray(triggers) || triggers.length === 0) {
          return 'Keyword Triggered requires at least one keyword trigger.';
        }
      }
      return undefined;
    },
  },
  // Per-group/per-chat thread sessions by default: routing key is
  // channel:chatId, so every group / private chat gets its own shared session.
  // groupAllPolicy 'keyword'/'all' relies on this for shared group context;
  // without it, zero-config users would fragment group messages per sender
  // ('user' scope). Explicit sessionScope in config still wins (see
  // parseChannelConfig in packages/cli/src/commands/channel/config-utils.ts).
  defaultSessionScope: 'thread',
  createChannel: (name, config, bridge, options) =>
    new QQChannel(name, config, bridge, options),
};
