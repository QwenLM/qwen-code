/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_REGISTRY_SEGMENT_KEY,
  SessionStateArtifactRegistryPersistence,
} from './artifactRegistryStore.js';

describe('SessionStateArtifactRegistryPersistence', () => {
  it('uses the versioned artifact segment to load', async () => {
    const store = {
      getSegment: async (key: string) => ({ key }),
      setSegment: async () => undefined,
    };
    await expect(
      new SessionStateArtifactRegistryPersistence(store).load(),
    ).resolves.toEqual({ key: ARTIFACT_REGISTRY_SEGMENT_KEY });
  });
  it('uses default encrypted store behavior when saving', async () => {
    const calls: unknown[][] = [];
    const store = {
      getSegment: async () => undefined,
      setSegment: async (...args: unknown[]) => {
        calls.push(args);
      },
    };
    await new SessionStateArtifactRegistryPersistence(store).save({
      version: 1,
      records: [],
    });
    expect(calls).toEqual([
      [ARTIFACT_REGISTRY_SEGMENT_KEY, { version: 1, records: [] }],
    ]);
  });
  it('exposes a stable segment name', () =>
    expect(ARTIFACT_REGISTRY_SEGMENT_KEY).toBe('remote-artifact-registry-v1'));
});
