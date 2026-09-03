/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelFactory } from './channel.js';

/**
 * Package-owned attestation that a channel factory merges its
 * `childEnvOverrides` argument into the spawned child's environment.
 *
 * The Conversations runtime's mandatory writer lease depends on a private
 * provenance marker reaching the ACP child, and only the factory decides
 * whether the bridge's overrides are forwarded. Membership is therefore
 * granted solely by `createSpawnChannelFactory` (the production path that
 * performs the merge through `scrubChildEnv`) or, for tests, by the
 * deliberate `internal/testUtils` seam. This is a contract against
 * accidental same-process miswiring, not a security boundary: embedding
 * code can already construct arbitrary runtime objects.
 */
const forwardingFactories = new WeakSet<ChannelFactory>();

export function markChannelFactoryForwardsChildEnv(
  factory: ChannelFactory,
): void {
  forwardingFactories.add(factory);
}

export function channelFactoryForwardsChildEnv(
  factory: ChannelFactory,
): boolean {
  return forwardingFactories.has(factory);
}
