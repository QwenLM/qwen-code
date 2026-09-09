/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MediaResourceRegistry, resolveMediaReference } from './registry.js';

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

  it('resolveByFileRef follows a revert to previously-seen bytes', () => {
    // Read bytes A (v-1), edit to B and re-read (v-2), then revert to A and
    // read again. The third read re-delivers v-1 (its versionId is a
    // deterministic function of content), so `bind` must refresh v-1's
    // recency: the model is now looking at A again, so the path must resolve
    // to v-1, NOT the superseded v-2. Without the recency refresh, byVersionId
    // stays in first-mint order [v-1, v-2] and the path wrongly resolves v-2,
    // mis-attributing any subsequent policy execution to stale bytes.
    const registry = new MediaResourceRegistry();
    const vA = registry.bind({ ...BINDING, fileVersionId: 'v-movie-1' });
    registry.bind({ ...BINDING, fileVersionId: 'v-movie-2' });
    const vAagain = registry.bind({ ...BINDING, fileVersionId: 'v-movie-1' });
    expect(vAagain).toBe(vA); // idempotent: same handle
    expect(registry.resolveByFileRef(BINDING.fileRef)).toBe(vA);
  });

  it('never resolves a handle it did not issue', () => {
    const registry = new MediaResourceRegistry();
    registry.bind(BINDING);
    expect(registry.resolve('media-1-deadbeef')).toBeUndefined();
    expect(registry.resolve('/movies/breaking-surface.mkv')).toBeUndefined();
    expect(registry.resolveVersion('v-unknown')).toBeUndefined();
  });
});

describe('resolveMediaReference', () => {
  const WINDOWS_BINDING = {
    fileId: 'f-win',
    fileVersionId: 'v-win-1',
    rootFileId: 'f-win',
    fileRef: 'C:\\Users\\jane\\clip.mp4',
    mediaType: 'video' as const,
  };

  it('resolves the opaque handle form verbatim', () => {
    const registry = new MediaResourceRegistry();
    const bound = registry.bind(BINDING);
    expect(resolveMediaReference(registry, bound.resourceId)).toBe(bound);
  });

  it('resolves the unescaped absolute-path form (POSIX)', () => {
    const registry = new MediaResourceRegistry();
    const bound = registry.bind(BINDING);
    expect(resolveMediaReference(registry, BINDING.fileRef)).toBe(bound);
  });

  it('resolves a native Windows path VERBATIM (no escaping to reverse)', () => {
    // The path form now rides verbatim under its own 【媒体路径】 marker, so
    // the string the model echoes back is byte-for-byte the fileRef the
    // registry stores — an exact match on every OS, with no unescape step to
    // reorder or collide (displayed == raw).
    const registry = new MediaResourceRegistry();
    const bound = registry.bind(WINDOWS_BINDING);
    expect(registry.resolveByFileRef('C:\\Users\\jane\\clip.mp4')).toBe(bound);
    expect(resolveMediaReference(registry, WINDOWS_BINDING.fileRef)).toBe(
      bound,
    );
  });

  it('resolves a path containing a literal backslash to its OWN binding', () => {
    // R1-1: `/tmp/proj/a\b` and `/tmp/proj/ab` are DISTINCT files bound in
    // the same session. The old unescape-before-exact ordering turned the
    // reference `/tmp/proj/a\b` into `/tmp/proj/ab` and resolved the WRONG
    // binding. With the path form verbatim and resolution a pure exact lookup,
    // each reference resolves to its own file.
    const registry = new MediaResourceRegistry();
    const backslash = registry.bind({
      ...BINDING,
      fileId: 'f-bs',
      fileVersionId: 'v-bs',
      rootFileId: 'f-bs',
      fileRef: '/tmp/proj/a\\b',
    });
    const plain = registry.bind({
      ...BINDING,
      fileId: 'f-plain',
      fileVersionId: 'v-plain',
      rootFileId: 'f-plain',
      fileRef: '/tmp/proj/ab',
    });
    expect(resolveMediaReference(registry, '/tmp/proj/a\\b')).toBe(backslash);
    expect(resolveMediaReference(registry, '/tmp/proj/ab')).toBe(plain);
  });

  it('resolves a path whose filename contains the full-width colon', () => {
    // R3-10: `：` is the handle grammar's name/payload separator, so the old
    // escaped display turned `报告：final.mkv` into `报告\：final.mkv` and the
    // raw fileRef never matched what the model echoed. The path form now rides
    // verbatim, so a `：` in the filename resolves with no unescaping.
    const registry = new MediaResourceRegistry();
    const bound = registry.bind({
      ...BINDING,
      fileId: 'f-colon',
      fileVersionId: 'v-colon',
      rootFileId: 'f-colon',
      fileRef: '/movies/报告：final.mkv',
    });
    expect(resolveMediaReference(registry, '/movies/报告：final.mkv')).toBe(
      bound,
    );
  });

  it('returns undefined for a reference that is neither form', () => {
    const registry = new MediaResourceRegistry();
    registry.bind(BINDING);
    expect(resolveMediaReference(registry, 'media-9-deadbeef')).toBeUndefined();
    expect(resolveMediaReference(registry, '/not/bound.mp4')).toBeUndefined();
  });
});
