import { describe, expect, it } from 'vitest';
import { supportedChannelCatalog } from './channel-registry.js';

describe('channel registry', () => {
  it('returns safe management metadata for every built-in type', async () => {
    const catalog = await supportedChannelCatalog();
    expect(catalog.map((entry) => entry.type)).toEqual([
      'telegram',
      'weixin',
      'dingtalk',
      'wecom',
      'feishu',
      'qq',
    ]);
    expect(
      catalog.find((entry) => entry.type === 'telegram')?.fields,
    ).toContainEqual(
      expect.objectContaining({
        key: 'token',
        kind: 'secret',
        required: true,
      }),
    );
    expect(JSON.stringify(catalog)).not.toContain('createChannel');
  });
});
