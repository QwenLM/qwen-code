/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { validateHostedHarnessProfile } from './hosted-harness-profile.js';

const options = {
  port: 0,
  hostname: '127.0.0.1',
  mode: 'http-bridge' as const,
};

describe('Hosted Harness profile', () => {
  it('leaves the ordinary daemon available', () => {
    expect(() => validateHostedHarnessProfile(options)).not.toThrow();
  });

  it('accepts loopback no-tool deployment credentials', () => {
    expect(() =>
      validateHostedHarnessProfile({
        ...options,
        profile: 'hosted-harness',
        token: 'harness-secret',
        serveWebShell: false,
        hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).not.toThrow();
  });

  it.each([
    { hostname: '0.0.0.0', error: 'loopback' },
    { mode: 'native' as const, error: '--http-bridge' },
    { token: '', error: 'bearer token' },
    { serveWebShell: true, error: '--no-web' },
    { enableSessionShell: true, error: 'WebSocket tunnels' },
    { clientMcpOverWs: true, error: 'WebSocket tunnels' },
    { cdpTunnelOverWs: true, error: 'WebSocket tunnels' },
    { allowOrigins: ['https://example.com'], error: 'browser origins' },
    {
      managedRuntimeBrokerUrl: 'http://127.0.0.1:8080',
      error: 'does not enable',
    },
    { hostedHarnessCapabilityDigest: 'invalid', error: 'sha256' },
  ])('rejects invalid hosted configuration: %j', ({ error, ...option }) => {
    expect(() =>
      validateHostedHarnessProfile({
        ...options,
        profile: 'hosted-harness',
        token: 'harness-secret',
        serveWebShell: false,
        hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
        ...option,
      }),
    ).toThrow(error);
  });

  it.each([
    { experimentalManagedAgents: true },
    { experimentalManagedRuntimeWorker: true },
    { experimentalManagedRuntimeAutoLocal: true },
    { experimentalManagedRuntimeUrl: 'http://127.0.0.1:8080' },
    { experimentalManagedRuntimeToken: '' },
  ])('rejects an unsupported experimental option: %j', (option) => {
    expect(() =>
      validateHostedHarnessProfile({ ...options, ...option }),
    ).toThrow('not implemented');
  });

  it('rejects broker options outside hosted mode', () => {
    expect(() =>
      validateHostedHarnessProfile({
        ...options,
        managedRuntimeBrokerToken: 'secret',
      }),
    ).toThrow('require --profile hosted-harness');
  });
});
