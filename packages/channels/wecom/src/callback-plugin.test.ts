import { describe, expect, it } from 'vitest';
import { callbackPlugin } from './callback-plugin.js';
import { parseCallbackConfig } from './wecom-callback-adapter.js';

const config = {
  corpId: 'corp',
  agentId: '1000002',
  corpSecret: 'secret',
  token: 'token',
  encodingAESKey: Buffer.alloc(32, 42).toString('base64').slice(0, -1),
};

describe('callback plugin configuration', () => {
  it('marks callback credentials as required and secrets as redacted fields', () => {
    expect(callbackPlugin.requiredConfigFields).toEqual(Object.keys(config));
    expect(
      callbackPlugin.management?.fields
        .filter((field) => field.kind === 'secret')
        .map((field) => field.key),
    ).toEqual(['corpSecret', 'token', 'encodingAESKey']);
    expect(callbackPlugin.management?.validateConfig?.(config)).toBeUndefined();
  });

  it.each([
    { agentId: '$WECOM_AGENT_ID' },
    { encodingAESKey: '$WECOM_ENCODING_AES_KEY' },
    { agentId: '$WECOM_AGENT_ID', encodingAESKey: '$WECOM_ENCODING_AES_KEY' },
  ])('accepts environment references for management saves %s', (override) => {
    const input = Object.freeze({ ...config, ...override });
    expect(callbackPlugin.management?.validateConfig?.(input)).toBeUndefined();
    expect(input).toEqual({ ...config, ...override });
    expect(() => parseCallbackConfig(input)).toThrow();
  });

  it.each([
    { corpId: '' },
    { agentId: 'not-number' },
    { agentId: '0' },
    { agentId: '9007199254740993' },
    { encodingAESKey: 'wrong' },
    { agentId: '$9BAD' },
    { agentId: '${WECOM_AGENT_ID}' },
    { encodingAESKey: '$9BAD' },
    { encodingAESKey: '${WECOM_ENCODING_AES_KEY}' },
    { agentId: '$WECOM_AGENT_ID', encodingAESKey: 'wrong' },
    { agentId: '0', encodingAESKey: '$WECOM_ENCODING_AES_KEY' },
    { webhookPort: 0 },
    { webhookPort: 65536 },
    { webhookPort: '8645' },
    { webhookHost: '' },
  ])('rejects invalid settings %s', (override) => {
    expect(
      callbackPlugin.management?.validateConfig?.({ ...config, ...override }),
    ).toBeTypeOf('string');
  });
});
