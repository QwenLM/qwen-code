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

import { supportedChannelCatalog } from './channel-registry.js';

describe('built-in channel registry', () => {
  it('isolates an invalid built-in management descriptor', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const catalog = await supportedChannelCatalog();

    expect(catalog.map((entry) => entry.type)).not.toContain('dingtalk');
    expect(catalog.map((entry) => entry.type)).toContain('gitlab');
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid management metadata in "dingtalk" channel: Channel field "settings" cannot be a required object.',
      ),
    );
    stderr.mockRestore();
  });
});
