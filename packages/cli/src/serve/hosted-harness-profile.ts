/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServeOptions } from './types.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './broker-managed-runtime-provider.js';
import { isHostedHarnessCapabilityDigest } from './hosted-harness-contract.js';
import { isLoopbackBind } from './loopback-binds.js';

export function validateHostedHarnessProfile(
  opts: Omit<ServeOptions, 'workspace'>,
  environment: {
    readonly serverToken: string;
    readonly brokerUrl: string;
    readonly brokerToken: string;
    readonly capabilityDigest: string;
  },
): void {
  if (opts.profile !== 'hosted-harness') return;
  if (!isLoopbackBind(opts.hostname)) {
    throw new Error('--profile hosted-harness requires a loopback --hostname.');
  }
  if (opts.mode !== 'http-bridge') {
    throw new Error('--profile hosted-harness requires --http-bridge.');
  }
  if (!opts.token?.trim()) {
    throw new Error(
      `--profile hosted-harness requires a Harness bearer token. Set ` +
        `${environment.serverToken} or pass --token.`,
    );
  }
  if (opts.serveWebShell !== false) {
    throw new Error('--profile hosted-harness requires --no-web.');
  }
  if (opts.enableSessionShell === true) {
    throw new Error(
      '--profile hosted-harness conflicts with --enable-session-shell.',
    );
  }
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    throw new Error(
      '--profile hosted-harness does not accept browser origins.',
    );
  }
  if (
    opts.clientMcpOverWs === true ||
    opts.cdpTunnelOverWs === true ||
    opts.channelSelection !== undefined
  ) {
    throw new Error(
      '--profile hosted-harness conflicts with client MCP, CDP tunnel, and channel hosting.',
    );
  }
  if (
    opts.experimentalManagedAgents ||
    opts.experimentalManagedRuntimeWorker ||
    opts.experimentalManagedRuntimeAutoLocal ||
    opts.experimentalManagedRuntimeUrl !== undefined ||
    opts.experimentalManagedRuntimeToken !== undefined
  ) {
    throw new Error(
      '--profile hosted-harness conflicts with the experimental Managed Gateway and Runtime worker options.',
    );
  }
  if (!opts.managedRuntimeBrokerUrl?.trim()) {
    throw new Error(
      `--profile hosted-harness requires --managed-runtime-broker-url or ${environment.brokerUrl}.`,
    );
  }
  if (!opts.managedRuntimeBrokerToken?.trim()) {
    throw new Error(
      `--profile hosted-harness requires --managed-runtime-broker-token or ${environment.brokerToken}.`,
    );
  }
  resolveManagedRuntimeBrokerBaseUrl(opts.managedRuntimeBrokerUrl);
  if (
    !opts.hostedHarnessCapabilityDigest ||
    !isHostedHarnessCapabilityDigest(opts.hostedHarnessCapabilityDigest)
  ) {
    throw new Error(
      `--profile hosted-harness requires ${environment.capabilityDigest}=sha256:<64 lowercase hex characters>.`,
    );
  }
}
