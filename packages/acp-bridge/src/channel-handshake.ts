/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  InitializeRequest,
  InitializeResponse,
} from '@agentclientprotocol/sdk';
import { PRIVATE_PARENT_CAPABILITY_META_KEY } from '@qwen-code/qwen-code-core';
import {
  ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
  ACTIVE_WORK_HEARTBEAT_META_KEY,
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HOLD_CATEGORIES,
  CHANNEL_LIVENESS_META_KEY,
  CHANNEL_LIVENESS_VERSION,
  CHANNEL_STARTUP_PROFILE_META_KEY,
  CHANNEL_STARTUP_PROFILE_VERSION,
  clampActiveWorkIntervalMs,
  type ActiveWorkHoldCategory,
} from './bridgeTypes.js';
import {
  EXTERNAL_TOOL_GUARD_READY_META_KEY,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
} from './externalToolGuard.js';

interface NegotiatedChannelCapabilities {
  activeWork?: {
    intervalMs: number;
    categories: readonly ActiveWorkHoldCategory[];
  };
  channelLiveness: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createChannelInitializeRequest(
  privateParentCapability: string,
  delegateReadTextFileToClient: boolean,
): InitializeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    _meta: {
      [ACTIVE_WORK_HEARTBEAT_META_KEY]: {
        v: ACTIVE_WORK_HEARTBEAT_VERSION,
        intervalMs: ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
        categories: [...ACTIVE_WORK_HOLD_CATEGORIES],
      },
      [CHANNEL_STARTUP_PROFILE_META_KEY]: {
        v: CHANNEL_STARTUP_PROFILE_VERSION,
      },
      [CHANNEL_LIVENESS_META_KEY]: {
        v: CHANNEL_LIVENESS_VERSION,
      },
      [PRIVATE_PARENT_CAPABILITY_META_KEY]: privateParentCapability,
    },
    clientCapabilities: {
      _meta: { 'qwen.goalProposals': true },
      fs: {
        readTextFile: delegateReadTextFileToClient,
        writeTextFile: true,
      },
    },
    clientInfo: { name: 'qwen-serve-bridge', version: '0' },
  };
}

export function negotiateChannelCapabilities(
  response: InitializeResponse,
  requireExternalToolGuard: boolean,
): NegotiatedChannelCapabilities {
  if (requireExternalToolGuard) {
    const guardAck = response._meta?.[EXTERNAL_TOOL_GUARD_READY_META_KEY];
    if (guardAck !== EXTERNAL_TOOL_GUARD_REQUIRED_VALUE) {
      throw new Error(
        `ACP child did not acknowledge the required external tool guard (received: ${JSON.stringify(guardAck)}).`,
      );
    }
  }
  let activeWork: NegotiatedChannelCapabilities['activeWork'];
  const activeWorkCapability = isRecord(response._meta)
    ? response._meta[ACTIVE_WORK_HEARTBEAT_META_KEY]
    : undefined;
  if (
    isRecord(activeWorkCapability) &&
    activeWorkCapability['v'] === ACTIVE_WORK_HEARTBEAT_VERSION
  ) {
    const advertised = activeWorkCapability['categories'];
    // Take the child's cadence rather than demanding it match ours,
    // but clamp it: an out-of-range value would either flood the
    // transport or make the freshness grade meaningless.
    activeWork = {
      intervalMs: clampActiveWorkIntervalMs(activeWorkCapability['intervalMs']),
      categories: Array.isArray(advertised)
        ? ACTIVE_WORK_HOLD_CATEGORIES.filter((category) =>
            advertised.includes(category),
          )
        : [],
    };
  }
  const channelLivenessCapability = isRecord(response._meta)
    ? response._meta[CHANNEL_LIVENESS_META_KEY]
    : undefined;
  return {
    activeWork,
    channelLiveness:
      isRecord(channelLivenessCapability) &&
      channelLivenessCapability['v'] === CHANNEL_LIVENESS_VERSION,
  };
}
