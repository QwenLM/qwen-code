import { describe, expect, it } from 'vitest';
import type { ChannelPlugin } from '@qwen-code/channel-base';
import { registerPlugin, supportedChannelCatalog } from './channel-registry.js';

describe('channel registry', () => {
  it.each([
    {
      type: 'invalid-nested-secret',
      field: {
        key: 'settings',
        label: 'Settings',
        kind: 'object',
        properties: [{ key: 'token', label: 'Token', kind: 'secret' }],
      },
      message: 'Channel field "settings.token" cannot declare a nested secret.',
    },
    {
      type: 'invalid-nested-environment',
      field: {
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
      message:
        'Channel field "settings.endpoint" cannot resolve environment references.',
    },
    {
      type: 'invalid-required-object',
      field: {
        key: 'settings',
        label: 'Settings',
        kind: 'object',
        required: true,
      },
      message: 'Channel field "settings" cannot be a required object.',
    },
    {
      type: 'invalid-env-resolvable-object',
      field: {
        key: 'settings',
        label: 'Settings',
        kind: 'object',
        envResolvable: true,
      },
      message:
        'Channel field "settings" cannot resolve environment references.',
    },
    {
      type: 'invalid-reserved-field-key',
      field: {
        key: 'constructor',
        label: 'Constructor',
        kind: 'string',
      },
      message: 'Channel field "constructor" cannot use a reserved key.',
    },
    {
      type: 'invalid-reserved-property-key',
      field: {
        key: 'settings',
        label: 'Settings',
        kind: 'object',
        properties: [{ key: 'prototype', label: 'Prototype', kind: 'string' }],
      },
      message: 'Channel field "settings.prototype" cannot use a reserved key.',
    },
  ])('rejects $type management metadata', ({ type, field, message }) => {
    const plugin = {
      channelType: type,
      displayName: type,
      management: { fields: [field] },
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin;

    expect(() => registerPlugin(plugin)).toThrow(message);
  });

  it.each([
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
  ])('rejects $type management metadata', ({ type, fields, message }) => {
    const plugin = {
      channelType: type,
      displayName: type,
      management: { fields },
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin;

    expect(() => registerPlugin(plugin)).toThrow(message);
  });

  it('only marks the manually configurable built-in types as manageable', async () => {
    const catalog = await supportedChannelCatalog();
    expect(catalog.map((entry) => entry.type)).toEqual([
      'telegram',
      'weixin',
      'dingtalk',
      'wecom',
      'feishu',
      'qq',
      'github',
      'gitlab',
    ]);
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
