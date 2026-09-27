/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { MediaResourceRegistry } from './registry.js';

it('keeps an issued handle bound to its original locator and type', () => {
  const registry = new MediaResourceRegistry();
  const original = {
    fileId: 'file',
    fileVersionId: 'version',
    rootFileId: 'file',
    fileRef: '/original/video.mp4',
    mediaType: 'video' as const,
  };
  const first = registry.bind({ ...original });
  const rebound = registry.bind({
    ...original,
    fileRef: '/other/audio.mp3',
    mediaType: 'audio',
  });

  expect(rebound).toBe(first);
  expect(registry.resolve(first.resourceId)).toEqual({
    ...original,
    resourceId: first.resourceId,
  });
  expect(registry.resolveByFileRef(original.fileRef)).toBe(first);
  expect(registry.resolveByFileRef('/other/audio.mp3')).toBeUndefined();
});
