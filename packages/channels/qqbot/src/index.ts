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
        default: false,
        description: 'Use the QQ sandbox API instead of production',
      },
      {
        key: 'groupAllPolicy',
        label: 'Non-Mention Group Messages',
        kind: 'enum',
        default: 'log',
        description:
          'How to handle group messages that do not mention the bot. Requires One Shared Session and Require Mention off.',
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
        default: true,
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
        default: false,
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
      if (config['sessionScope'] !== 'single') {
        return 'Non-mention group messages require Session Scope "One Shared Session"; otherwise the adapter silently overrides it.';
      }
      const groups = config['groups'];
      const wildcard =
        groups !== null && typeof groups === 'object'
          ? (groups as Record<string, unknown>)['*']
          : undefined;
      const requireMention =
        wildcard !== null && typeof wildcard === 'object'
          ? (wildcard as Record<string, unknown>)['requireMention']
          : undefined;
      if (requireMention !== false) {
        return 'Non-mention group messages require "Require Mention" to be off, otherwise the group gate drops them.';
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
  createChannel: (name, config, bridge, options) =>
    new QQChannel(name, config, bridge, options),
};
