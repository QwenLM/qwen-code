import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvVars, parseChannelConfig } from './config-utils.js';

// Mock the channel-registry so we don't pull in real plugins
vi.mock('./channel-registry.js', () => ({
  getPlugin: async (type: string) => {
    const plugins: Record<
      string,
      { channelType: string; requiredConfigFields?: string[] }
    > = {
      telegram: { channelType: 'telegram', requiredConfigFields: ['token'] },
      dingtalk: {
        channelType: 'dingtalk',
        requiredConfigFields: ['clientId', 'clientSecret'],
      },
      wecom: {
        channelType: 'wecom',
        requiredConfigFields: ['botId', 'secret'],
      },
      bare: { channelType: 'bare' }, // no requiredConfigFields
    };
    return plugins[type];
  },
  supportedTypes: async () => ['telegram', 'dingtalk', 'wecom', 'bare'],
}));

describe('resolveEnvVars', () => {
  const ENV_KEY = 'TEST_RESOLVE_VAR_123';

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('returns literal values unchanged', () => {
    expect(resolveEnvVars('my-token')).toBe('my-token');
  });

  it('resolves $ENV_VAR to its value', () => {
    process.env[ENV_KEY] = 'secret';
    expect(resolveEnvVars(`$${ENV_KEY}`)).toBe('secret');
  });

  it('throws when referenced env var is not set', () => {
    expect(() => resolveEnvVars(`$${ENV_KEY}`)).toThrow(
      `Environment variable ${ENV_KEY} is not set`,
    );
  });

  it('does not resolve vars that do not start with $', () => {
    process.env[ENV_KEY] = 'val';
    expect(resolveEnvVars(`prefix$${ENV_KEY}`)).toBe(`prefix$${ENV_KEY}`);
  });
});

describe('parseChannelConfig', () => {
  it('throws when type is missing', async () => {
    await expect(parseChannelConfig('bot', {})).rejects.toThrow(
      'missing required field "type"',
    );
  });

  it('throws for unsupported channel type', async () => {
    await expect(parseChannelConfig('bot', { type: 'slack' })).rejects.toThrow(
      '"slack" is not supported',
    );
  });

  it('throws when plugin-required fields are missing', async () => {
    await expect(
      parseChannelConfig('bot', { type: 'telegram' }),
    ).rejects.toThrow('requires "token"');
  });

  it('resolves env vars in plugin-required bot credentials', async () => {
    process.env['TEST_WECOM_BOT_ID'] = 'bot-from-env';
    process.env['TEST_WECOM_SECRET'] = 'secret-from-env';

    const result = await parseChannelConfig('bot', {
      type: 'wecom',
      botId: '$TEST_WECOM_BOT_ID',
      secret: '$TEST_WECOM_SECRET',
    });

    expect(result['botId']).toBe('bot-from-env');
    expect(result['secret']).toBe('secret-from-env');

    delete process.env['TEST_WECOM_BOT_ID'];
    delete process.env['TEST_WECOM_SECRET'];
  });

  it('throws a clear error when plugin-required fields are not strings', async () => {
    await expect(
      parseChannelConfig('bot', {
        type: 'wecom',
        botId: 123,
        secret: 'secret',
      }),
    ).rejects.toThrow('Channel "bot" field "botId" must be a string.');
  });

  it('throws a clear error when token is not a string', async () => {
    await expect(
      parseChannelConfig('bot', { type: 'telegram', token: 123 }),
    ).rejects.toThrow('Channel "bot" field "token" must be a string.');
  });

  it('throws a clear error when dingtalk credentials are not strings', async () => {
    await expect(
      parseChannelConfig('bot', {
        type: 'dingtalk',
        clientId: 123,
        clientSecret: 'secret',
      }),
    ).rejects.toThrow('Channel "bot" field "clientId" must be a string.');
    await expect(
      parseChannelConfig('bot', {
        type: 'dingtalk',
        clientId: 'client-id',
        clientSecret: false,
      }),
    ).rejects.toThrow('Channel "bot" field "clientSecret" must be a string.');
  });

  it('parses minimal valid config with defaults', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
    });

    expect(result.type).toBe('bare');
    expect(result.token).toBe('');
    expect(result.senderPolicy).toBe('allowlist');
    expect(result.allowedUsers).toEqual([]);
    expect(result.sessionScope).toBe('user');
    expect(result.cwd).toBe(process.cwd());
    expect(result.groupPolicy).toBe('disabled');
    expect(result.groups).toEqual({});
    expect(result.identity).toBeUndefined();
    expect(result.memoryScope).toBeUndefined();
  });

  it('resolves env vars in token, clientId, clientSecret', async () => {
    process.env['TEST_TOKEN'] = 'tok123';
    process.env['TEST_CID'] = 'cid456';
    process.env['TEST_SEC'] = 'sec789';

    const result = await parseChannelConfig('bot', {
      type: 'bare',
      token: '$TEST_TOKEN',
      clientId: '$TEST_CID',
      clientSecret: '$TEST_SEC',
    });

    expect(result.token).toBe('tok123');
    expect(result.clientId).toBe('cid456');
    expect(result.clientSecret).toBe('sec789');

    delete process.env['TEST_TOKEN'];
    delete process.env['TEST_CID'];
    delete process.env['TEST_SEC'];
  });

  it('does not resolve known credential fields twice', async () => {
    process.env['TEST_TOKEN'] = '$TOKEN_LITERAL_VALUE';

    const result = await parseChannelConfig('bot', {
      type: 'telegram',
      token: '$TEST_TOKEN',
    });

    expect(result.token).toBe('$TOKEN_LITERAL_VALUE');

    delete process.env['TEST_TOKEN'];
  });

  it('preserves explicit config values over defaults', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      token: 'literal-tok',
      senderPolicy: 'open',
      allowedUsers: ['alice'],
      sessionScope: 'thread',
      cwd: '/custom',
      approvalMode: 'auto',
      instructions: 'Be helpful',
      identity: { id: 'ops-agent', displayName: 'Ops Agent' },
      memoryScope: { namespace: 'qwen-tag:ops', mode: 'metadata-only' },
      model: 'qwen-coder',
      groupPolicy: 'open',
      groups: { g1: { mentionKeywords: ['@bot'] } },
    });

    expect(result.token).toBe('literal-tok');
    expect(result.senderPolicy).toBe('open');
    expect(result.allowedUsers).toEqual(['alice']);
    expect(result.sessionScope).toBe('thread');
    expect(result.cwd).toBe('/custom');
    expect(result.approvalMode).toBe('auto');
    expect(result.instructions).toBe('Be helpful');
    expect(result.identity).toEqual({
      id: 'ops-agent',
      displayName: 'Ops Agent',
    });
    expect(result.memoryScope).toEqual({
      namespace: 'qwen-tag:ops',
      mode: 'metadata-only',
    });
    expect(result.model).toBe('qwen-coder');
    expect(result.groupPolicy).toBe('open');
    expect(result.groups).toEqual({ g1: { mentionKeywords: ['@bot'] } });
  });

  it('drops empty identity and memory scope objects', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      identity: { id: '', displayName: null, description: undefined },
      memoryScope: { namespace: '', mode: undefined },
    });

    expect(result.identity).toBeUndefined();
    expect(result.memoryScope).toBeUndefined();
  });

  it('rejects a non-object identity', async () => {
    await expect(
      parseChannelConfig('bot', { type: 'bare', identity: 'ops' }),
    ).rejects.toThrow('Channel "bot" field "identity" must be an object.');
  });

  it('rejects a non-string identity field', async () => {
    await expect(
      parseChannelConfig('bot', { type: 'bare', identity: { id: 123 } }),
    ).rejects.toThrow('Channel "bot" field "identity.id" must be a string.');
  });

  it('rejects a non-object memoryScope', async () => {
    await expect(
      parseChannelConfig('bot', { type: 'bare', memoryScope: ['ops'] }),
    ).rejects.toThrow('Channel "bot" field "memoryScope" must be an object.');
  });

  it('rejects an unknown memoryScope.mode', async () => {
    await expect(
      parseChannelConfig('bot', {
        type: 'bare',
        memoryScope: { mode: 'full' },
      }),
    ).rejects.toThrow(
      'Channel "bot" field "memoryScope.mode" must be "metadata-only".',
    );
  });

  it('drops empty identity fields instead of failing', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      identity: { id: 'ops-agent', displayName: '', description: null },
    });
    expect(result.identity).toEqual({ id: 'ops-agent' });
  });

  it('spreads extra fields from raw config', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      customField: 42,
    });
    expect((result as Record<string, unknown>)['customField']).toBe(42);
  });

  it('expands tilde in cwd (~/x → $HOME/x)', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      cwd: '~/xomo',
    });
    expect(result.cwd).toBe(path.join(os.homedir(), 'xomo'));
  });

  it('expands bare tilde (~) in cwd to home directory', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      cwd: '~',
    });
    expect(result.cwd).toBe(path.normalize(os.homedir()));
  });

  it('resolves relative cwd against process.cwd', async () => {
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      cwd: 'relative/dir',
    });
    expect(result.cwd).toBe(path.resolve('relative/dir'));
  });

  it('leaves absolute cwd unchanged', async () => {
    const abs = path.resolve('/custom');
    const result = await parseChannelConfig('bot', {
      type: 'bare',
      cwd: abs,
    });
    expect(result.cwd).toBe(abs);
  });
});
