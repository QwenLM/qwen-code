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

describe('unimplemented deployment profiles', () => {
  it('leaves the ordinary daemon available', () => {
    expect(() => validateHostedHarnessProfile(options)).not.toThrow();
  });

  it('rejects hosted mode even with complete deployment credentials', () => {
    expect(() =>
      validateHostedHarnessProfile({
        ...options,
        profile: 'hosted-harness',
        token: 'harness-secret',
        serveWebShell: false,
        managedRuntimeBrokerUrl: 'http://127.0.0.1:8080',
        managedRuntimeBrokerToken: 'broker-secret',
        hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow('Broker-backed session loop is not implemented');
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
