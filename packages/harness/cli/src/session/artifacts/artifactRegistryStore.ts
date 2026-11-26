/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ArtifactRegistryPersistence,
  PersistedArtifactRegistryState,
} from './artifactRegistryState.js';

export const ARTIFACT_REGISTRY_SEGMENT_KEY = 'remote-artifact-registry-v1';

export interface SessionStateSegmentStore {
  getSegment(segmentKey: string): Promise<unknown>;
  setSegment(
    segmentKey: string,
    value: unknown,
    options?: { encrypted?: boolean },
  ): Promise<unknown>;
}

export class SessionStateArtifactRegistryPersistence
  implements ArtifactRegistryPersistence
{
  constructor(private readonly store: SessionStateSegmentStore) {}

  async load(): Promise<unknown> {
    return this.store.getSegment(ARTIFACT_REGISTRY_SEGMENT_KEY);
  }

  async save(state: PersistedArtifactRegistryState): Promise<void> {
    await this.store.setSegment(ARTIFACT_REGISTRY_SEGMENT_KEY, state);
  }
}
