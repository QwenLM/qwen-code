import { describe, expect, it, vi } from 'vitest';

vi.mock('@qwen-code/channel-dingtalk', () => ({
  plugin: {
    channelType: 'dingtalk',
    displayName: 'DingTalk',
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
  },
}));

import { getPlugin, supportedChannelCatalog } from './channel-registry.js';

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
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "dingtalk" channel: Channel field "settings" cannot be a required object.',
      ),
    );

    const plugin = await getPlugin('dingtalk');
    expect(plugin?.management).toBeUndefined();
    expect(plugin?.createChannel).toBeTypeOf('function');

    stderr.mockRestore();
  });
});
