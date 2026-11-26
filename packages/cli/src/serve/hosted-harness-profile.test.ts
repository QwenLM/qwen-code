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

  it('requires separate opt-ins for a private listener and HTTP Broker', () => {
    const optionsForPrivateNetwork = {
      ...options,
      profile: 'hosted-harness' as const,
      hostname: '0.0.0.0',
      token: 'harness-secret',
      serveWebShell: false,
      hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
      managedRuntimeBrokerUrl: 'http://runtime-broker:4182',
      managedRuntimeBrokerToken: 'broker-secret',
    };
    const validate = (
      hostedHarnessRequireLoopback: boolean,
      managedRuntimeBrokerRequireTls: boolean,
    ) =>
      validateHostedHarnessProfile({
        ...optionsForPrivateNetwork,
        hostedHarnessRequireLoopback,
        managedRuntimeBrokerRequireTls,
      });

    expect(() => validate(true, false)).toThrow('loopback --hostname');
    expect(() => validate(false, true)).toThrow('must use HTTPS');
    expect(() => validate(false, false)).not.toThrow();
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

  it.each([
    { managedRuntimeBrokerToken: 'secret' },
    { managedRuntimeBrokerRequireTls: false },
    { hostedHarnessRequireLoopback: false },
  ])('rejects hosted options outside hosted mode: %j', (option) => {
    expect(() =>
      validateHostedHarnessProfile({
        ...options,
        ...option,
      }),
    ).toThrow('require --profile hosted-harness');
  });
});
