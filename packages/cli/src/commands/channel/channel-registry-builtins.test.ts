import { describe, expect, it, vi } from 'vitest';
import type { ChannelPlugin } from '@qwen-code/channel-base';

const { dingtalkPlugin } = vi.hoisted(() => {
  // A prototype-based (class-instance) plugin, a shape the extension loader
  // accepts: createChannel lives on the prototype, not as an own property.
  class InvalidDingtalkPlugin {
    channelType = 'dingtalk';
    displayName = 'DingTalk';
    requiredConfigFields = ['clientId', 'clientSecret'];
    envResolvableConfigFields = ['clientId', 'clientSecret'];
    defaultSessionScope = 'thread';
    management = {
      fields: [
        {
          key: 'settings',
          label: 'Settings',
          kind: 'object',
          required: true,
        },
      ],
    };
    createChannel(): never {
      throw new Error('not used');
    }
  }
  return { dingtalkPlugin: new InvalidDingtalkPlugin() };
});

vi.mock('@qwen-code/channel-dingtalk', () => ({
  plugin: dingtalkPlugin,
}));

import {
  getPlugin,
  registerPlugin,
  supportedChannelCatalog,
} from './channel-registry.js';

describe('built-in channel registry', () => {
  it('keeps an invalid built-in channel running without management metadata', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const catalog = await supportedChannelCatalog();

    expect(catalog.find((entry) => entry.type === 'dingtalk')).toEqual({
      type: 'dingtalk',
      displayName: 'DingTalk',
      manageable: false,
      fields: [],
    });
    expect(catalog.map((entry) => entry.type)).toContain('gitlab');
    expect(
      catalog.filter((entry) => entry.manageable).map((entry) => entry.type),
    ).toEqual(['dws', 'wecom', 'feishu', 'github', 'gitlab']);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "dingtalk" channel: Channel field "settings" cannot be a required object.',
      ),
    );

    const plugin = await getPlugin('dingtalk');
    expect(plugin?.management).toBeUndefined();
    expect(plugin).not.toBe(dingtalkPlugin);
    expect(plugin?.createChannel).toBeTypeOf('function');
    expect(plugin?.createChannel).toBe(dingtalkPlugin.createChannel);
    expect(plugin?.channelType).toBe('dingtalk');
    expect(plugin?.requiredConfigFields).toEqual(['clientId', 'clientSecret']);
    expect(plugin?.envResolvableConfigFields).toEqual([
      'clientId',
      'clientSecret',
    ]);
    expect(plugin?.defaultSessionScope).toBe('thread');

    stderr.mockRestore();
  });

  it('registers a nested property keyed "type" with management intact', async () => {
    const plugin: ChannelPlugin = {
      channelType: 'valid-nested-type-key',
      displayName: 'valid-nested-type-key',
      management: {
        fields: [
          {
            key: 'settings',
            label: 'Settings',
            kind: 'object',
            properties: [{ key: 'type', label: 'Type', kind: 'string' }],
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

    const registered = await getPlugin('valid-nested-type-key');
    expect(registered?.management).toBe(plugin.management);

    const entry = (await supportedChannelCatalog()).find(
      (candidate) => candidate.type === 'valid-nested-type-key',
    );
    expect(entry).toMatchObject({
      type: 'valid-nested-type-key',
      displayName: 'valid-nested-type-key',
      manageable: true,
    });
    expect(entry?.fields[0]).toEqual({
      key: 'settings',
      label: 'Settings',
      kind: 'object',
      properties: [{ key: 'type', label: 'Type', kind: 'string' }],
    });
    expect(entry?.fields.map((field) => field.key)).toEqual([
      'settings',
      'senderPolicy',
      'allowedUsers',
      'groupPolicy',
      'sessionScope',
      'multiSession',
    ]);
    expect(
      entry?.fields.find((field) => field.key === 'senderPolicy'),
    ).toMatchObject({ default: 'pairing' });
  });
});
