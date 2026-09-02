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

  it('keeps the first binding when a version is rebound with different fields', () => {
    // fileVersionId IS the identity here, so the version wins over the
    // details: the binding a handle was minted with is the one the harness
    // will resolve for the rest of the session. Overwriting `fileRef` in
    // place would silently repoint a handle the model already holds at
    // other bytes; minting a second handle for one version would break the
    // correlation across recall calls that the idempotency exists for.
    const registry = new MediaResourceRegistry();
    const first = registry.bind(BINDING);
    const second = registry.bind({
      ...BINDING,
      fileRef: '/objects/sha256/promoted.mp4',
      mediaType: 'audio',
    });

    expect(second).toBe(first);
    expect(second).toEqual({ ...BINDING, resourceId: first.resourceId });
    expect(registry.resolve(first.resourceId)).toMatchObject({
      fileRef: BINDING.fileRef,
      mediaType: 'video',
    });
    // The rejected locator was never indexed either, so a path-based
    // recovery cannot resolve it back to this handle.
    expect(
      registry.resolveByFileRef('/objects/sha256/promoted.mp4'),
    ).toBeUndefined();
    expect(registry.resolveByFileRef(BINDING.fileRef)).toBe(first);
  });

  it('issues distinct handles for distinct versions', () => {
    const registry = new MediaResourceRegistry();
    const first = registry.bind(BINDING);
    const second = registry.bind({ ...BINDING, fileVersionId: 'v-movie-2' });
    expect(second.resourceId).not.toBe(first.resourceId);
  });

  it('resolveByFileRef returns the LATEST version bound at a locator', () => {
    // Two versions of the same file at one path (re-read after the bytes
    // changed) mint distinct handles. A path-form annotation names the file,
    // not a version, so the reversal must pick the version the model is
    // currently looking at — the most recently bound one — rather than the
    // first ever bound.
    const registry = new MediaResourceRegistry();
    const first = registry.bind(BINDING);
    const second = registry.bind({ ...BINDING, fileVersionId: 'v-movie-2' });
    expect(second.resourceId).not.toBe(first.resourceId);
    expect(registry.resolveByFileRef(BINDING.fileRef)).toBe(second);
  });

  it('never resolves a handle it did not issue', () => {
    const registry = new MediaResourceRegistry();
    registry.bind(BINDING);
    expect(registry.resolve('media-1-deadbeef')).toBeUndefined();
    expect(registry.resolve('/movies/breaking-surface.mkv')).toBeUndefined();
    expect(registry.resolveVersion('v-unknown')).toBeUndefined();
  });
});
