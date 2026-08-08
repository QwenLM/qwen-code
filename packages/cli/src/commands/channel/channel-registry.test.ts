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
      type: 'invalid-truthy-required-object',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          required: 'true',
        },
      ],
      message: 'Channel field "settings" cannot be a required object.',
    },
    {
      type: 'invalid-truthy-nested-environment',
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
              envResolvable: 'yes',
            },
          ],
        },
      ],
      message:
        'Channel field "settings.endpoint" cannot resolve environment references.',
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
      type: 'invalid-depth2-nested-secret',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: [
            {
              key: 'inner',
              label: 'Inner',
              kind: 'object',
              properties: [{ key: 'token', label: 'Token', kind: 'secret' }],
            },
          ],
        },
      ],
      message:
        'Channel field "settings.inner.token" cannot declare a nested secret.',
    },
    {
      type: 'invalid-depth2-reserved-key',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: [
            {
              key: 'inner',
              label: 'Inner',
              kind: 'object',
              properties: [
                { key: '__proto__', label: 'Proto', kind: 'string' },
              ],
            },
          ],
        },
      ],
      message:
        'Channel field "settings.inner.__proto__" cannot use a reserved key.',
    },
    {
      type: 'invalid-reserved-type-key',
      fields: [
        {
          key: 'type',
          label: 'Type',
          kind: 'string',
        },
      ],
      message: 'Channel field "type" cannot use the reserved key "type".',
    },
    {
      type: 'invalid-field-without-key',
      fields: [{ label: 'Token', kind: 'string', required: true }],
      message: 'Channel field "undefined" must declare a non-empty string key.',
    },
    {
      type: 'invalid-unknown-kind',
      fields: [{ key: 'retries', label: 'Retries', kind: 'sting' }],
      message: 'Channel field "retries" declares an unknown kind "sting".',
    },
    {
      type: 'invalid-enum-without-options',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'enum',
          required: true,
        },
      ],
      message: 'Channel field "mode" must declare at least one option.',
    },
    {
      type: 'invalid-enum-empty-options',
      fields: [{ key: 'mode', label: 'Mode', kind: 'enum', options: [] }],
      message: 'Channel field "mode" must declare at least one option.',
    },
    {
      type: 'invalid-enum-string-options',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'enum',
          options: ['allowlist', 'open'],
        },
      ],
      message:
        'Channel field "mode" must declare non-empty string option values.',
    },
    {
      type: 'invalid-enum-empty-option-value',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'enum',
          options: [{ value: '', label: 'Empty' }],
        },
      ],
      message:
        'Channel field "mode" must declare non-empty string option values.',
    },
    {
      type: 'invalid-enum-duplicate-option-values',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'enum',
          options: [
            { value: 'fast', label: 'Fast' },
            { value: 'fast', label: 'Fastest' },
          ],
        },
      ],
      message: 'Channel field "mode" declares duplicate option values.',
    },
    {
      type: 'invalid-non-finite-exclusive-minimum',
      fields: [
        {
          key: 'retries',
          label: 'Retries',
          kind: 'number',
          exclusiveMinimum: Number.NaN,
        },
      ],
      message:
        'Channel field "retries" must declare a finite exclusiveMinimum.',
    },
    {
      type: 'invalid-exclusive-minimum-on-string',
      fields: [
        {
          key: 'retentionDays',
          label: 'Retention days',
          kind: 'string',
          exclusiveMinimum: 0,
        },
      ],
      message:
        'Channel field "retentionDays" can only declare exclusiveMinimum on number fields.',
    },
    {
      type: 'invalid-env-resolvable-number',
      fields: [
        {
          key: 'timeout',
          label: 'Timeout',
          kind: 'number',
          envResolvable: true,
        },
      ],
      message: 'Channel field "timeout" cannot resolve environment references.',
    },
    {
      type: 'invalid-env-resolvable-enum',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'enum',
          envResolvable: true,
          options: [{ value: 'safe', label: 'Safe' }],
        },
      ],
      message: 'Channel field "mode" cannot resolve environment references.',
    },
    {
      type: 'invalid-env-resolvable-boolean',
      fields: [
        {
          key: 'enabled',
          label: 'Enabled',
          kind: 'boolean',
          envResolvable: true,
        },
      ],
      message: 'Channel field "enabled" cannot resolve environment references.',
    },
    {
      type: 'invalid-missing-label',
      fields: [{ key: 'token', kind: 'string' }],
      message: 'Channel field "token" must declare a string label.',
    },
    {
      type: 'invalid-object-label',
      fields: [{ key: 'token', label: { en: 'Token' }, kind: 'secret' }],
      message: 'Channel field "token" must declare a string label.',
    },
    {
      type: 'invalid-non-string-description',
      fields: [
        {
          key: 'token',
          label: 'Token',
          kind: 'string',
          description: ['rich'],
        },
      ],
      message: 'Channel field "token" must declare a string description.',
    },
    {
      type: 'invalid-non-string-default',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'enum',
          default: 42,
          options: [{ value: 'safe', label: 'Safe' }],
        },
      ],
      message: 'Channel field "mode" must declare a string default.',
    },
    {
      type: 'invalid-enum-default-not-in-options',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'enum',
          default: 'turbo',
          options: [
            { value: 'safe', label: 'Safe' },
            { value: 'fast', label: 'Fast' },
          ],
        },
      ],
      message:
        'Channel field "mode" declares a default that is not one of its options.',
    },
    {
      type: 'invalid-object-properties-not-array',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: '',
        },
      ],
      message: 'Channel field "settings" must declare a properties array.',
    },
    {
      type: 'invalid-object-without-properties',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
        },
      ],
      message: 'Channel field "settings" must declare a properties array.',
    },
    {
      type: 'invalid-object-with-empty-properties',
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          properties: [],
        },
      ],
      message: 'Channel field "settings" must declare at least one property.',
    },
    {
      type: 'invalid-duplicate-top-level-field',
      fields: [
        { key: 'token', label: 'Token', kind: 'secret' },
        { key: 'token', label: 'Token', kind: 'string' },
      ],
      message: 'Channel field "token" is declared more than once.',
    },
    {
      type: 'invalid-duplicate-nested-field',
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
      expect(registered).not.toBe(plugin);
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

  it('registers a plugin whose management descriptor lacks a fields array without management metadata', async () => {
    const plugin = {
      channelType: 'invalid-missing-fields-array',
      displayName: 'invalid-missing-fields-array',
      management: {},
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerPlugin(plugin);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "invalid-missing-fields-array" channel: Channel management metadata must declare a fields array.',
      ),
    );
    stderr.mockRestore();

    const registered = await getPlugin('invalid-missing-fields-array');
    expect(registered?.management).toBeUndefined();
    expect(registered).not.toBe(plugin);
    expect(registered?.createChannel).toBe(plugin.createChannel);

    const entry = (await supportedChannelCatalog()).find(
      (candidate) => candidate.type === 'invalid-missing-fields-array',
    );
    expect(entry).toEqual({
      type: 'invalid-missing-fields-array',
      displayName: 'invalid-missing-fields-array',
      manageable: false,
      fields: [],
    });
  });

  it('registers a plugin whose validateConfig is not a function without management metadata', async () => {
    const plugin = {
      channelType: 'invalid-validate-config',
      displayName: 'invalid-validate-config',
      management: {
        fields: [{ key: 'token', label: 'Token', kind: 'string' }],
        validateConfig: { report: true },
      },
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerPlugin(plugin);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "invalid-validate-config" channel: Channel management metadata must declare validateConfig as a synchronous function.',
      ),
    );
    stderr.mockRestore();

    const registered = await getPlugin('invalid-validate-config');
    expect(registered?.management).toBeUndefined();
    expect(registered).not.toBe(plugin);
    expect(registered?.createChannel).toBe(plugin.createChannel);

    const entry = (await supportedChannelCatalog()).find(
      (candidate) => candidate.type === 'invalid-validate-config',
    );
    expect(entry).toEqual({
      type: 'invalid-validate-config',
      displayName: 'invalid-validate-config',
      manageable: false,
      fields: [],
    });
  });

  it('registers a plugin whose validateConfig is async without management metadata', async () => {
    const plugin = {
      channelType: 'invalid-async-validate-config',
      displayName: 'invalid-async-validate-config',
      management: {
        fields: [{ key: 'token', label: 'Token', kind: 'string' }],
        validateConfig: async () => undefined,
      },
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerPlugin(plugin);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "invalid-async-validate-config" channel: Channel management metadata must declare validateConfig as a synchronous function.',
      ),
    );
    stderr.mockRestore();

    const registered = await getPlugin('invalid-async-validate-config');
    expect(registered?.management).toBeUndefined();
    expect(registered).not.toBe(plugin);
    expect(registered?.createChannel).toBe(plugin.createChannel);

    const entry = (await supportedChannelCatalog()).find(
      (candidate) => candidate.type === 'invalid-async-validate-config',
    );
    expect(entry).toEqual({
      type: 'invalid-async-validate-config',
      displayName: 'invalid-async-validate-config',
      manageable: false,
      fields: [],
    });
  });

  it('registers a null-prototype plugin without management metadata and keeps Object.prototype behavior', async () => {
    const plugin = Object.assign(Object.create(null), {
      channelType: 'invalid-null-prototype-plugin',
      displayName: 'invalid-null-prototype-plugin',
      management: {
        fields: [
          {
            key: 'settings',
            label: 'Settings',
            kind: 'object',
            required: true,
          },
        ],
      },
      createChannel() {
        throw new Error('not used');
      },
    }) as ChannelPlugin;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerPlugin(plugin);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "invalid-null-prototype-plugin" channel: Channel field "settings" cannot be a required object.',
      ),
    );
    stderr.mockRestore();

    const registered = await getPlugin('invalid-null-prototype-plugin');
    expect(registered?.management).toBeUndefined();
    expect(registered).not.toBe(plugin);
    expect(Object.getPrototypeOf(registered)).toBe(Object.prototype);
    expect(registered?.createChannel).toBe(plugin.createChannel);
  });

  it('registers a plugin whose management is a getter-only accessor without management metadata', async () => {
    class GetterManagementPlugin {
      channelType = 'invalid-getter-management';
      displayName = 'invalid-getter-management';
      get management() {
        return {
          fields: [
            {
              key: 'settings',
              label: 'Settings',
              kind: 'object',
              required: true,
            },
          ],
        };
      }
      createChannel(): never {
        throw new Error('not used');
      }
    }
    const plugin = new GetterManagementPlugin() as unknown as ChannelPlugin;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerPlugin(plugin);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "invalid-getter-management" channel: Channel field "settings" cannot be a required object.',
      ),
    );
    stderr.mockRestore();

    const registered = await getPlugin('invalid-getter-management');
    expect(registered?.management).toBeUndefined();
    expect(registered).not.toBe(plugin);
    expect(registered?.createChannel).toBe(plugin.createChannel);
  });

  it('registers an object field declaring required: false with management intact', async () => {
    const plugin: ChannelPlugin = {
      channelType: 'valid-optional-required-object',
      displayName: 'valid-optional-required-object',
      management: {
        fields: [
          {
            key: 'settings',
            label: 'Settings',
            kind: 'object',
            required: false,
            properties: [{ key: 'enabled', label: 'Enabled', kind: 'boolean' }],
          },
        ],
      },
      createChannel() {
        throw new Error('not used');
      },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerPlugin(plugin);

    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('Invalid management metadata'),
    );
    stderr.mockRestore();

    const registered = await getPlugin('valid-optional-required-object');
    expect(registered).toBe(plugin);
    expect(registered?.management).toBe(plugin.management);

    const entry = (await supportedChannelCatalog()).find(
      (candidate) => candidate.type === 'valid-optional-required-object',
    );
    expect(entry?.manageable).toBe(true);
  });

  it('only marks the manually configurable built-in types as manageable', async () => {
    const catalog = await supportedChannelCatalog();
    const builtinCatalog = catalog.filter(
      (entry) =>
        !entry.type.startsWith('invalid-') && !entry.type.startsWith('valid-'),
    );
    expect(builtinCatalog.map((entry) => entry.type)).toEqual([
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
      builtinCatalog
        .filter((entry) => entry.manageable)
        .map((entry) => entry.type),
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
          key: 'groupPolicy',
          kind: 'enum',
          required: true,
        }),
      );
      expect(
        fields
          ?.find((field) => field.key === 'groupPolicy')
          ?.options?.map((option) => option.value),
      ).toContain('pairing');
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
    expect(
      catalog.find((entry) => entry.type === 'gitlab')?.fields,
    ).toContainEqual(
      expect.objectContaining({
        key: 'token',
        kind: 'secret',
        required: true,
      }),
    );
    const githubFields = catalog.find(
      (entry) => entry.type === 'github',
    )?.fields;
    expect(githubFields).toContainEqual(
      expect.objectContaining({
        key: 'token',
        kind: 'secret',
      }),
    );
    expect(
      githubFields?.find((field) => field.key === 'token'),
    ).not.toHaveProperty('required');
    expect(githubFields).toContainEqual(
      expect.objectContaining({
        key: 'useLocalGh',
        kind: 'boolean',
      }),
    );
    expect(JSON.stringify(catalog)).not.toContain('createChannel');
  });
});
