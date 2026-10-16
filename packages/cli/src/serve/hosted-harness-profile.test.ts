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
    expect(() =>
      validateHostedHarnessProfile({
        ...options,
        experimentalPairedEngines: true,
      }),
    ).not.toThrow();
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

  it('pins the private store only with an authenticated Hosted Broker', () => {
    const privateOptions = {
      ...options,
      profile: 'hosted-harness' as const,
      token: 'harness-secret',
      serveWebShell: false,
      hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
      managedRuntimeBrokerUrl: 'http://127.0.0.1:8080',
      managedRuntimeBrokerToken: 'broker-secret',
      hostedCsiSessionStoreUrl:
        'http://127.0.0.1:8081/internal/managed-session-store/v1',
    };
    expect(() => validateHostedHarnessProfile(privateOptions)).not.toThrow();
    for (const url of [
      'http://store.example/v1',
      'https://u:p@store.example/v1',
      'https://store.example/v1?q=1',
      'https://store.example/v1#f',
      'file:///store',
    ]) {
      expect(() =>
        validateHostedHarnessProfile({
          ...privateOptions,
          hostedCsiSessionStoreUrl: url,
        }),
      ).toThrow();
    }
    expect(() =>
      validateHostedHarnessProfile({
        ...privateOptions,
        managedRuntimeBrokerUrl: undefined,
        managedRuntimeBrokerToken: undefined,
      }),
    ).toThrow('requires the original Runtime Broker');
    expect(() =>
      validateHostedHarnessProfile({
        ...options,
        hostedCsiSessionStoreUrl: privateOptions.hostedCsiSessionStoreUrl,
      }),
    ).toThrow('require --profile hosted-harness');
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
      experimentalPairedEngines: true,
      error: 'does not pair execution engines',
    },
    {
      managedRuntimeBrokerUrl: 'http://127.0.0.1:8080',
      error: 'both URL and token',
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
