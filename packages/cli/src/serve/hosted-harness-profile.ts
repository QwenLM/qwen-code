/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServeOptions } from './types.js';

export function validateHostedHarnessProfile(
  opts: Omit<ServeOptions, 'workspace'>,
): void {
  if (opts.profile === 'hosted-harness') {
    throw new Error(
      '--profile hosted-harness is not available: the Broker-backed session loop is not implemented.',
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
      'Experimental Managed Gateway and Runtime worker modes are not implemented.',
    );
  }
  if (
    opts.managedRuntimeBrokerUrl !== undefined ||
    opts.managedRuntimeBrokerToken !== undefined ||
    opts.hostedHarnessCapabilityDigest !== undefined
  ) {
    throw new Error(
      'Managed Runtime Broker options require --profile hosted-harness, which is not available yet.',
    );
  }
}
