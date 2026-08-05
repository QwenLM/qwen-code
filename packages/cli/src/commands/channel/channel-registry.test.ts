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
