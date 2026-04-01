import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveEnvVars, parseChannelConfig } from './config-utils.js';

// Mock the channel-registry so we don't pull in real plugins
vi.mock('./channel-registry.js', () => ({
  getPlugin: (type: string) => {
    const plugins: Record<
      string,
      { channelType: string; requiredConfigFields?: string[] }
    > = {
      telegram: { channelType: 'telegram', requiredConfigFields: ['token'] },
      dingtalk: {
        channelType: 'dingtalk',
        requiredConfigFields: ['clientId', 'clientSecret'],
      },
      bare: { channelType: 'bare' }, // no requiredConfigFields
    };
    return plugins[type];
  },
  supportedTypes: () => ['telegram', 'dingtalk', 'bare'],
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
  it('throws when type is missing', () => {
    expect(() => parseChannelConfig('bot', {})).toThrow(
      'missing required field "type"',
    );
  });

  it('throws for unsupported channel type', () => {
    expect(() => parseChannelConfig('bot', { type: 'slack' })).toThrow(
      '"slack" is not supported',
    );
  });

  it('throws when plugin-required fields are missing', () => {
    expect(() => parseChannelConfig('bot', { type: 'telegram' })).toThrow(
      'requires "token"',
    );
  });

  it('parses minimal valid config with defaults', () => {
    const result = parseChannelConfig('bot', {
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
  });

  it('resolves env vars in token, clientId, clientSecret', () => {
    process.env['TEST_TOKEN'] = 'tok123';
    process.env['TEST_CID'] = 'cid456';
    process.env['TEST_SEC'] = 'sec789';

    const result = parseChannelConfig('bot', {
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

  it('preserves explicit config values over defaults', () => {
    const result = parseChannelConfig('bot', {
      type: 'bare',
      token: 'literal-tok',
      senderPolicy: 'open',
      allowedUsers: ['alice'],
      sessionScope: 'thread',
      cwd: '/custom',
      approvalMode: 'auto',
      instructions: 'Be helpful',
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
    expect(result.model).toBe('qwen-coder');
    expect(result.groupPolicy).toBe('open');
    expect(result.groups).toEqual({ g1: { mentionKeywords: ['@bot'] } });
  });

  it('spreads extra fields from raw config', () => {
    const result = parseChannelConfig('bot', {
      type: 'bare',
      customField: 42,
    });
    expect((result as Record<string, unknown>)['customField']).toBe(42);
  });
});
