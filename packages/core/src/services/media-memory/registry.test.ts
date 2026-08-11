/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MediaResourceRegistry } from './registry.js';

const BINDING = {
  fileId: 'f-movie',
  fileVersionId: 'v-movie-1',
  rootFileId: 'f-movie',
  fileRef: '/movies/breaking-surface.mkv',
  mediaType: 'video' as const,
};

describe('MediaResourceRegistry', () => {
  it('mints an opaque handle that resolves back to the binding', () => {
    const registry = new MediaResourceRegistry();
    const bound = registry.bind(BINDING);
    expect(bound.resourceId).toMatch(/^media-1-[0-9a-f]{8}$/);
    expect(registry.resolve(bound.resourceId)).toEqual(bound);
    expect(registry.resolveVersion('v-movie-1')).toEqual(bound);
  });

  it('is idempotent per fileVersionId', () => {
    const registry = new MediaResourceRegistry();
    const first = registry.bind(BINDING);
    const second = registry.bind(BINDING);
    expect(second.resourceId).toBe(first.resourceId);
  });

  it('issues distinct handles for distinct versions', () => {
    const registry = new MediaResourceRegistry();
    const first = registry.bind(BINDING);
    const second = registry.bind({ ...BINDING, fileVersionId: 'v-movie-2' });
    expect(second.resourceId).not.toBe(first.resourceId);
  });

  it('never resolves a handle it did not issue', () => {
    const registry = new MediaResourceRegistry();
    registry.bind(BINDING);
    expect(registry.resolve('media-1-deadbeef')).toBeUndefined();
    expect(registry.resolve('/movies/breaking-surface.mkv')).toBeUndefined();
    expect(registry.resolveVersion('v-unknown')).toBeUndefined();
  });
});
