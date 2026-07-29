import { describe, expect, it } from 'vitest';
import { supportedChannelCatalog } from './channel-registry.js';

describe('channel registry', () => {
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
    ]);
    expect(
      catalog.filter((entry) => entry.manageable).map((entry) => entry.type),
    ).toEqual(['dingtalk', 'wecom', 'feishu']);
    expect(
      catalog.find((entry) => entry.type === 'dingtalk')?.fields,
    ).toContainEqual(
      expect.objectContaining({
        key: 'clientSecret',
        kind: 'secret',
        required: true,
      }),
    );
    expect(JSON.stringify(catalog)).not.toContain('createChannel');
  });
});
