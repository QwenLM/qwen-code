/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelPlugin } from '@qwen-code/channel-base';
import { DwsChannel } from './dws-channel.js';

export { DwsChannel };
export { DwsClient, parseDwsImEvent } from './dws-client.js';
export type {
  DwsClientLike,
  DwsClientOptions,
  DwsDocumentComment,
  DwsIdentity,
  DwsImMessage,
  DwsImSource,
  DwsImTarget,
} from './dws-client.js';
export { startDwsEventProcess } from './dws-event-stream.js';
export type {
  DwsEventProcessStarter,
  DwsEventSubscription,
} from './dws-event-stream.js';

function validStringList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.trim()))
  );
}

export const plugin: ChannelPlugin = {
  channelType: 'dws',
  displayName: 'DingTalk Workspace',
  envResolvableConfigFields: ['dwsPath', 'profile'],
  defaultSessionScope: 'chat_thread',
  management: {
    fields: [
      {
        key: 'dwsPath',
        label: 'DWS executable',
        kind: 'string',
        envResolvable: true,
        description:
          'Optional path to dws. Leave empty to resolve it from PATH',
      },
      {
        key: 'profile',
        label: 'DWS profile',
        kind: 'string',
        envResolvable: true,
        description:
          'Optional DWS profile. Leave empty to use the active profile',
      },
      {
        key: 'imUserIds',
        label: 'Direct-message users',
        kind: 'string-list',
        description: 'DingTalk user IDs whose direct messages start tasks',
      },
      {
        key: 'documentIds',
        label: 'Documents',
        kind: 'string-list',
        description: 'DingTalk document IDs or URLs to watch for comments',
      },
      {
        key: 'wikiSpaceIds',
        label: 'Knowledge bases',
        kind: 'string-list',
        description:
          'DingTalk knowledge-base workspace IDs or URLs whose documents are discovered recursively',
      },
      {
        key: 'wikiDiscoveryInterval',
        label: 'Knowledge-base discovery interval (ms)',
        kind: 'number',
        description:
          'How often knowledge-base document lists are refreshed. Defaults to 300000',
      },
      {
        key: 'trigger',
        label: 'Document-comment trigger',
        kind: 'string',
        description: 'Fallback prefix for document comments. Defaults to /qwen',
      },
      {
        key: 'pollInterval',
        label: 'Poll interval (ms)',
        kind: 'number',
        exclusiveMinimum: 4_999,
        description: 'Document comment polling interval. Defaults to 60000',
      },
      {
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        default: 'open',
        description:
          'Controls which DingTalk conversations and document threads may start DWS tasks',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'pairing', label: 'Pairing' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
      {
        key: 'senderPolicy',
        label: 'Sender Policy',
        kind: 'enum',
        required: true,
        default: 'open',
        description: 'Controls which DingTalk users may start DWS tasks',
        options: [
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'pairing', label: 'Pairing' },
          { value: 'open', label: 'Open' },
        ],
      },
      {
        key: 'allowedUsers',
        label: 'Allowed Users',
        kind: 'string-list',
        description: 'DingTalk IDs used by Allowlist and Pairing policies',
      },
    ],
    validateConfig: (config) => {
      for (const field of ['imUserIds', 'documentIds', 'wikiSpaceIds']) {
        if (!validStringList(config[field])) {
          return `DWS ${field} must contain non-empty strings.`;
        }
      }
      if (
        config['trigger'] !== undefined &&
        (typeof config['trigger'] !== 'string' ||
          config['trigger'].trim().length === 0)
      ) {
        return 'DWS trigger must be a non-empty string.';
      }
      if (
        config['wikiDiscoveryInterval'] !== undefined &&
        (typeof config['wikiDiscoveryInterval'] !== 'number' ||
          !Number.isSafeInteger(config['wikiDiscoveryInterval']) ||
          config['wikiDiscoveryInterval'] < 0)
      ) {
        return 'DWS wikiDiscoveryInterval must be a non-negative integer.';
      }
      const hasDocumentSource = ['documentIds', 'wikiSpaceIds'].some(
        (field) => Array.isArray(config[field]) && config[field].length > 0,
      );
      if (
        hasDocumentSource &&
        config['approvalMode'] !== undefined &&
        config['approvalMode'] !== 'default' &&
        config['approvalMode'] !== 'plan'
      ) {
        return 'DWS document sources require approvalMode "default" or "plan".';
      }
      return undefined;
    },
  },
  createChannel: (name, config, bridge, options) =>
    new DwsChannel(name, config, bridge, options),
};
