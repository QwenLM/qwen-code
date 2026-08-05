import { describe, expect, it, vi } from 'vitest';
import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  getPlugin,
  registerPlugin,
  supportedChannelCatalog,
} from './channel-registry.js';

function invalidPlugin(
  type: string,
  fields: readonly unknown[],
): ChannelPlugin {
  return {
    channelType: type,
    displayName: type,
    management: { fields },
    createChannel() {
      throw new Error('not used');
    },
  } as unknown as ChannelPlugin;
}

describe('channel registry', () => {
  it.each([
    {
      type: 'invalid-nested-secret',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: [{ key: 'token', label: 'Token', kind: 'secret' }],
        },
      ],
      message: 'Channel field "settings.token" cannot declare a nested secret.',
    },
    {
      type: 'invalid-nested-environment',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: [
            {
              key: 'endpoint',
              label: 'Endpoint',
              kind: 'string',
              envResolvable: true,
            },
          ],
        },
      ],
      message:
        'Channel field "settings.endpoint" cannot resolve environment references.',
    },
    {
      type: 'invalid-required-object',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          required: true,
        },
      ],
      message: 'Channel field "settings" cannot be a required object.',
    },
    {
      type: 'invalid-env-resolvable-object',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          envResolvable: true,
        },
      ],
      message:
        'Channel field "settings" cannot resolve environment references.',
    },
    {
      type: 'invalid-reserved-field-key',
      fields: [
        {
          key: 'constructor',
          label: 'Constructor',
          kind: 'string',
        },
      ],
      message: 'Channel field "constructor" cannot use a reserved key.',
    },
    {
      type: 'invalid-reserved-property-key',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: [
            { key: 'prototype', label: 'Prototype', kind: 'string' },
          ],
        },
      ],
      message: 'Channel field "settings.prototype" cannot use a reserved key.',
    },
    {
      type: 'duplicate-top-level-field',
      fields: [
        { key: 'token', label: 'Token', kind: 'secret' },
        { key: 'token', label: 'Token', kind: 'string' },
      ],
      message: 'Channel field "token" is declared more than once.',
    },
    {
      type: 'duplicate-nested-field',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: [
            { key: 'enabled', label: 'Enabled', kind: 'boolean' },
            { key: 'enabled', label: 'Enabled', kind: 'boolean' },
          ],
        },
      ],
      message: 'Channel field "settings.enabled" is declared more than once.',
    },
  ])(
    'registers $type without management metadata',
    async ({ type, fields, message }) => {
      const plugin = invalidPlugin(type, fields);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      registerPlugin(plugin);

      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          `Invalid management metadata in "${type}" channel: ${message}`,
        ),
      );
      stderr.mockRestore();

      const registered = await getPlugin(type);
      expect(registered?.management).toBeUndefined();
      expect(registered?.createChannel).toBe(plugin.createChannel);

      const entry = (await supportedChannelCatalog()).find(
        (candidate) => candidate.type === type,
      );
      expect(entry).toEqual({
        type,
        displayName: type,
        manageable: false,
        fields: [],
      });
    },
  );

  it('only marks the manually configurable built-in types as manageable', async () => {
    const catalog = await supportedChannelCatalog();
    expect(catalog.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        'telegram',
        'weixin',
        'dingtalk',
        'wecom',
        'feishu',
        'qq',
        'github',
        'gitlab',
      ]),
    );
    expect(
      catalog.filter((entry) => entry.manageable).map((entry) => entry.type),
    ).toEqual(['dingtalk', 'wecom', 'feishu', 'github', 'gitlab']);
    expect(
      catalog.find((entry) => entry.type === 'dingtalk')?.fields,
    ).toContainEqual(
      expect.objectContaining({
        key: 'clientSecret',
        kind: 'secret',
        required: true,
      }),
    );
    for (const type of ['github', 'gitlab'] as const) {
      const fields = catalog.find((entry) => entry.type === type)?.fields;
      expect(fields).toContainEqual(
        expect.objectContaining({
          key: 'token',
          kind: 'secret',
          required: true,
        }),
      );
      expect(fields).toContainEqual(
        expect.objectContaining({
          key: 'groupPolicy',
          kind: 'enum',
          required: true,
        }),
      );
      expect(fields).toContainEqual(
        expect.objectContaining({
          key: 'senderPolicy',
          kind: 'enum',
          required: true,
        }),
      );
      expect(fields).toContainEqual(
        expect.objectContaining({
          key: 'allowedUsers',
          kind: 'string-list',
        }),
      );
    }
    expect(
      catalog.find((entry) => entry.type === 'dingtalk')?.fields,
    ).toContainEqual(
      expect.objectContaining({
        key: 'interactiveCards',
        kind: 'object',
        properties: expect.arrayContaining([
          expect.objectContaining({ key: 'enabled', kind: 'boolean' }),
          expect.objectContaining({ key: 'statusCard', kind: 'object' }),
          expect.objectContaining({ key: 'questionCard', kind: 'object' }),
        ]),
      }),
    );
    expect(JSON.stringify(catalog)).not.toContain('createChannel');
  });
});
