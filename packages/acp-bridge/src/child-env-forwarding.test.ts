/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  PRIVATE_CONVERSATIONS_RUNTIME_ENABLE,
  PRIVATE_CONVERSATIONS_RUNTIME_ENV,
} from '@qwen-code/qwen-code-core';
import type { ChannelFactory } from './channel.js';
import { channelFactoryForwardsChildEnv } from './child-env-forwarding.js';
import {
  createSpawnChannelFactory,
  defaultSpawnChannelFactory,
} from './spawnChannel.js';
import { createAcpSessionBridge } from './bridge.js';
import { attestChannelFactoryForwardsChildEnv } from './internal/testUtils.js';

const MARKER_OVERRIDES = {
  [PRIVATE_CONVERSATIONS_RUNTIME_ENV]: PRIVATE_CONVERSATIONS_RUNTIME_ENABLE,
} as const;

const neverSpawns: ChannelFactory = async () => {
  throw new Error('never spawned');
};

describe('child-env forwarding capability', () => {
  it('marks every factory produced by createSpawnChannelFactory', () => {
    expect(channelFactoryForwardsChildEnv(createSpawnChannelFactory())).toBe(
      true,
    );
    expect(
      channelFactoryForwardsChildEnv(
        createSpawnChannelFactory({ onDiagnosticLine: () => undefined }),
      ),
    ).toBe(true);
  });

  it('marks the default factory because the same helper creates it', () => {
    expect(channelFactoryForwardsChildEnv(defaultSpawnChannelFactory)).toBe(
      true,
    );
  });

  it('does not mark an arbitrary factory shape', () => {
    expect(channelFactoryForwardsChildEnv(neverSpawns)).toBe(false);
  });

  it('lets a test fake attest deliberately through the test seam', () => {
    const fake: ChannelFactory = async () => {
      throw new Error('never spawned');
    };
    expect(channelFactoryForwardsChildEnv(fake)).toBe(false);
    attestChannelFactoryForwardsChildEnv(fake);
    expect(channelFactoryForwardsChildEnv(fake)).toBe(true);
  });
});

describe('bridge mandatory-lease attestation', () => {
  it('attests when the exact marker meets a forwarding factory', () => {
    const bridge = createAcpSessionBridge({
      boundWorkspace: '/work/conversations',
      childEnvOverrides: { ...MARKER_OVERRIDES },
    });
    expect(bridge.mandatoryLeaseAttested).toBe(true);
  });

  it('does not attest a marker-shaped map with an unattested factory', () => {
    const bridge = createAcpSessionBridge({
      boundWorkspace: '/work/conversations',
      childEnvOverrides: { ...MARKER_OVERRIDES },
      channelFactory: neverSpawns,
    });
    expect(bridge.mandatoryLeaseAttested).toBe(false);
  });

  it('does not attest a forwarding factory without the exact marker', () => {
    expect(
      createAcpSessionBridge({
        boundWorkspace: '/work/conversations',
      }).mandatoryLeaseAttested,
    ).toBe(false);
    expect(
      createAcpSessionBridge({
        boundWorkspace: '/work/conversations',
        childEnvOverrides: {
          [PRIVATE_CONVERSATIONS_RUNTIME_ENV]: 'yes',
        },
      }).mandatoryLeaseAttested,
    ).toBe(false);
  });

  it('attests a deliberately marked test factory carrying the marker', () => {
    const fake: ChannelFactory = async () => {
      throw new Error('never spawned');
    };
    attestChannelFactoryForwardsChildEnv(fake);
    const bridge = createAcpSessionBridge({
      boundWorkspace: '/work/conversations',
      childEnvOverrides: { ...MARKER_OVERRIDES },
      channelFactory: fake,
    });
    expect(bridge.mandatoryLeaseAttested).toBe(true);
  });
});
