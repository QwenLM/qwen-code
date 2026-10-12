import { describe, expect, it } from 'vitest';
import { callbackPlugin } from './callback-plugin.js';

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
    { corpId: '' },
    { agentId: 'not-number' },
    { agentId: '0' },
    { agentId: '9007199254740993' },
    { encodingAESKey: 'wrong' },
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
