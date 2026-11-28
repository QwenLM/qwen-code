/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import type { ServeOptions } from './types.js';
import {
  HOSTED_HARNESS_WORK_URL_ENV,
  isHostedHarnessCapabilityDigest,
} from './hosted-harness-contract.js';
import { resolveHostedHarnessWorkUrl } from './hosted-harness-work-poll.js';
import { isLoopbackBind } from './loopback-binds.js';

export function validateHostedHarnessProfile(
  opts: Omit<ServeOptions, 'workspace'>,
): void {
  if (
    opts.experimentalManagedAgents ||
    opts.experimentalManagedRuntimeWorker ||
    opts.experimentalManagedRuntimeAutoLocal ||
    opts.experimentalManagedRuntimeUrl !== undefined ||
    opts.experimentalManagedRuntimeToken !== undefined
  ) {
    throw new Error(
      'Experimental Managed Gateway and Runtime worker modes are not implemented.',
    );
  }
  if (opts.profile !== 'hosted-harness') {
    if (
      opts.managedRuntimeBrokerUrl === undefined &&
      opts.managedRuntimeBrokerToken === undefined &&
      opts.hostedHarnessCapabilityDigest === undefined
    ) {
      return;
    }
    throw new Error('Hosted Harness options require --profile hosted-harness.');
  }
  if (!isLoopbackBind(opts.hostname)) {
    throw new Error('--profile hosted-harness requires a loopback --hostname.');
  }
  if (opts.mode !== 'http-bridge') {
    throw new Error('--profile hosted-harness requires --http-bridge.');
  }
  if (!opts.token?.trim()) {
    throw new Error('--profile hosted-harness requires a bearer token.');
  }
  if (opts.serveWebShell !== false) {
    throw new Error('--profile hosted-harness requires --no-web.');
  }
  if (
    opts.enableSessionShell ||
    opts.channelSelection !== undefined ||
    opts.clientMcpOverWs ||
    opts.cdpTunnelOverWs
  ) {
    throw new Error(
      '--profile hosted-harness does not serve shells, channels, or WebSocket tunnels.',
    );
  }
  if (opts.allowOrigins?.length) {
    throw new Error(
      '--profile hosted-harness does not accept browser origins.',
    );
  }
  if (opts.experimentalPairedEngines) {
    throw new Error(
      '--profile hosted-harness does not pair execution engines.',
    );
  }
  if (
    opts.managedRuntimeBrokerUrl !== undefined ||
    opts.managedRuntimeBrokerToken !== undefined
  ) {
    if (
      !opts.managedRuntimeBrokerUrl ||
      !opts.managedRuntimeBrokerToken?.trim()
    ) {
      throw new Error('Hosted Runtime Broker requires both URL and token.');
    }
    resolveManagedRuntimeBrokerBaseUrl(opts.managedRuntimeBrokerUrl);
  }
  if (
    !opts.hostedHarnessCapabilityDigest ||
    !isHostedHarnessCapabilityDigest(opts.hostedHarnessCapabilityDigest)
  ) {
    throw new Error(
      '--profile hosted-harness requires a sha256 capability digest.',
    );
  }
  const workUrl = process.env[HOSTED_HARNESS_WORK_URL_ENV];
  if (workUrl !== undefined) {
    resolveHostedHarnessWorkUrl(workUrl);
    // Only a pool member may claim, and claims are loaded through this
    // process's own plain loopback listener.
    if (process.env['QWEN_HOSTED_HARNESS_INSTANCE_ID'] === undefined)
      throw new Error(
        `${HOSTED_HARNESS_WORK_URL_ENV} requires QWEN_HOSTED_HARNESS_INSTANCE_ID.`,
      );
    if (opts.tlsCert !== undefined)
      throw new Error(`${HOSTED_HARNESS_WORK_URL_ENV} does not support TLS.`);
  }
}
