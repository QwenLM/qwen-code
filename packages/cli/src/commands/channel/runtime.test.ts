import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfiguredChannels } from './runtime.js';

vi.mock('./channel-registry.js', () => ({
  getPlugin: async (type: string) =>
    type === 'telegram'
      ? { channelType: 'telegram', requiredConfigFields: ['token'] }
      : undefined,
  supportedTypes: async () => ['telegram'],
}));

describe('parseConfiguredChannels', () => {
  afterEach(() => {
    delete process.env['TEST_CHANNEL_TOKEN'];
  });

  it('throws a clear error when a selected channel is missing config', async () => {
    await expect(
      parseConfiguredChannels({}, ['telegram'], { defaultCwd: '/workspace' }),
    ).rejects.toThrow(
      'Error in channel "telegram": channel is not configured. Add a "telegram" entry under "channels" in settings.json.',
    );
  });

  it('parses configured channels', async () => {
    const parsed = await parseConfiguredChannels(
      {
        telegram: {
          type: 'telegram',
          token: 'secret',
        },
      },
      ['telegram'],
      { defaultCwd: '/workspace' },
    );

    expect(parsed).toEqual([
      expect.objectContaining({
        name: 'telegram',
        config: expect.objectContaining({
          type: 'telegram',
          token: 'secret',
          cwd: '/workspace',
        }),
      }),
    ]);
  });

  it('does not re-expand credentials already resolved by settings loading', async () => {
    const parsed = await parseConfiguredChannels(
      {
        telegram: {
          type: 'telegram',
          token: '$TOKEN_LITERAL_VALUE',
        },
      },
      ['telegram'],
      { defaultCwd: '/workspace' },
    );

    expect(parsed[0]?.config.token).toBe('$TOKEN_LITERAL_VALUE');
  });

  it('resolves channel credentials from environment loaded after settings', async () => {
    process.env['TEST_CHANNEL_TOKEN'] = 'token-from-env';

    const parsed = await parseConfiguredChannels(
      {
        telegram: {
          type: 'telegram',
          token: '$TEST_CHANNEL_TOKEN',
        },
      },
      ['telegram'],
      { defaultCwd: '/workspace' },
    );

    expect(parsed[0]?.config.token).toBe('token-from-env');
  });
});
