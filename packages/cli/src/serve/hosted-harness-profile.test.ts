/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('accepts the Hosted Broker credential pair', () => {
    const privateOptions = {
      ...options,
      profile: 'hosted-harness' as const,
      token: 'harness-secret',
      serveWebShell: false,
      hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
      managedRuntimeBrokerUrl: 'http://127.0.0.1:8080',
      managedRuntimeBrokerToken: 'broker-secret',
    };
    expect(() => validateHostedHarnessProfile(privateOptions)).not.toThrow();
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

  describe('work pull', () => {
    const hosted = {
      ...options,
      profile: 'hosted-harness' as const,
      token: 'harness-secret',
      serveWebShell: false,
      hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
    };
    afterEach(() => vi.unstubAllEnvs());

    it('accepts a pool member with a work URL', () => {
      vi.stubEnv('QWEN_MANAGED_HARNESS_WORK_URL', 'http://127.0.0.1:8081');
      vi.stubEnv('QWEN_HOSTED_HARNESS_INSTANCE_ID', 'pod-a');
      expect(() => validateHostedHarnessProfile(hosted)).not.toThrow();
    });

    it.each([
      {
        url: 'http://127.0.0.1:8081',
        error: 'requires QWEN_HOSTED_HARNESS_INSTANCE_ID',
      },
      {
        url: 'http://managed-agent.internal',
        instanceId: 'pod-a',
        error: 'HTTPS outside the loopback interface',
      },
      {
        url: 'http://127.0.0.1:8081',
        instanceId: 'pod-a',
        tlsCert: 'cert.pem',
        error: 'does not support TLS',
      },
    ])('rejects $error', ({ url, instanceId, tlsCert, error }) => {
      vi.stubEnv('QWEN_MANAGED_HARNESS_WORK_URL', url);
      vi.stubEnv('QWEN_HOSTED_HARNESS_INSTANCE_ID', instanceId);
      expect(() =>
        validateHostedHarnessProfile({ ...hosted, tlsCert }),
      ).toThrow(error);
    });
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
