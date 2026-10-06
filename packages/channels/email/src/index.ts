import type { ChannelPlugin } from '@qwen-code/channel-base';
import { EmailChannel } from './email-channel.js';
import { emailSettings } from './config.js';

export { EmailChannel };

const required = [
  'address',
  'imapHost',
  'imapUser',
  'imapPassword',
  'smtpHost',
  'smtpUser',
  'smtpPassword',
];

export const plugin: ChannelPlugin = {
  channelType: 'email',
  displayName: 'Email',
  defaultSessionScope: 'chat_thread',
  requiredConfigFields: required,
  envResolvableConfigFields: [...required, 'folder'],
  management: {
    fields: [
      ...required.map((key) => ({
        key,
        label: key,
        kind: key.endsWith('Password')
          ? ('secret' as const)
          : ('string' as const),
        required: true,
        envResolvable: true,
      })),
      {
        key: 'folder',
        label: 'IMAP Folder',
        kind: 'string',
        default: 'INBOX',
        envResolvable: true,
      },
      {
        key: 'imapPort',
        label: 'IMAP Port',
        kind: 'number',
        exclusiveMinimum: 0,
      },
      {
        key: 'smtpPort',
        label: 'SMTP Port',
        kind: 'number',
        exclusiveMinimum: 0,
      },
      {
        key: 'imapSecure',
        label: 'IMAP Implicit TLS',
        kind: 'boolean',
        default: 'true',
        description: 'When disabled, STARTTLS is mandatory.',
      },
      {
        key: 'smtpSecure',
        label: 'SMTP Implicit TLS',
        kind: 'boolean',
        default: 'true',
        description: 'When disabled, STARTTLS is mandatory.',
      },
      {
        key: 'privatePolicy',
        label: 'Private Policy',
        kind: 'enum',
        default: 'allowlist',
        required: true,
        options: [
          { value: 'disabled', label: 'Disabled' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'open', label: 'Open' },
        ],
      },
      {
        key: 'proactiveRecipients',
        label: 'Proactive Recipients',
        kind: 'string-list',
        description: 'Explicit bare addresses. Empty disables proactive email.',
      },
      {
        key: 'pollInterval',
        label: 'Poll Interval (ms)',
        kind: 'number',
        exclusiveMinimum: 0,
        default: '60000',
      },
      {
        key: 'maxMessageBytes',
        label: 'Message Size Limit (bytes)',
        kind: 'number',
        exclusiveMinimum: 0,
        default: '10485760',
      },
      {
        key: 'maxAttachmentBytes',
        label: 'Attachment Size Limit (bytes)',
        kind: 'number',
        exclusiveMinimum: 0,
        default: '5242880',
      },
      {
        key: 'maxTextLength',
        label: 'Text Character Limit',
        kind: 'number',
        exclusiveMinimum: 0,
        default: '32000',
      },
    ],
    validateConfig(config) {
      try {
        emailSettings(config);
        return undefined;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Invalid email configuration.';
      }
    },
  },
  createChannel: (name, config, bridge, options) =>
    new EmailChannel(name, config, bridge, options),
};
