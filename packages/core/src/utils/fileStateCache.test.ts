/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  createToolFileStateCache,
  isFileContentInContext,
  isFullFileRead,
  isSameFileContent,
  mergeFileStateCaches,
  type FileState,
  trackFileStateResult,
  markFileStateResultPartial,
} from './fileStateCache.js';

const state = (content: string, extra: Partial<FileState> = {}): FileState => ({
  content,
  timestamp: 1,
  offset: 1,
  limit: undefined,
  ...extra,
});

describe('file read baselines', () => {
  it('recognizes default first-line reads and conservatively handles ranges', () => {
    expect(isFullFileRead(state('a'))).toBe(true);
    expect(isFullFileRead(state('a', { offset: 2 }))).toBe(false);
    expect(isFullFileRead(state('a', { limit: 2 }))).toBe(true);
    expect(isFullFileRead(state('a', { limit: 1 }))).toBe(false);
    expect(isFullFileRead(state('', { limit: 2 }))).toBe(false);
    expect(isFullFileRead(state('', { limit: 2, contentLength: 5000 }))).toBe(
      false,
    );
    expect(isFullFileRead(state('a', { isPartialView: true }))).toBe(false);
    expect(
      isFileContentInContext(state('a', { contentNotInModelContext: true })),
    ).toBe(false);
  });

  it('retains large-file fingerprints through metadata updates and cloning', () => {
    const cache = createToolFileStateCache();
    const text = 'a'.repeat(8192);
    cache.set('/file', state(text));
    expect(cache.get('/file')!.content).toBe('');
    cache.set('/file', {
      ...cache.get('/file')!,
      contentNotInModelContext: true,
    });
    const cloned = cloneFileStateCache(cache);
    expect(cloned.compactContent).toBe(true);
    expect(cloned.get('/file')).not.toBe(cache.get('/file'));
    expect(isSameFileContent(cloned.get('/file')!, text)).toBe(true);
    expect(isSameFileContent(cloned.get('/file')!, '')).toBe(false);
    cloned.set('/file', {
      ...cloned.get('/file')!,
      contentNotInModelContext: false,
    });
    expect(cache.get('/file')!.contentNotInModelContext).toBe(true);
    expect(
      isSameFileContent(
        mergeFileStateCaches(cache, cloned).get('/file')!,
        text,
      ),
    ).toBe(true);
  });

  it.each([
    { offset: 1, limit: undefined, isPartialView: false, full: true },
    { offset: 1, limit: 3, isPartialView: false, full: false },
    { offset: 1, limit: 2, isPartialView: false, full: false },
    { offset: 2, limit: undefined, isPartialView: false, full: false },
    { offset: 1, limit: undefined, isPartialView: true, full: false },
  ])(
    'preserves compacted read completeness through cache operations ($offset, $limit, $isPartialView)',
    ({ offset, limit, isPartialView, full }) => {
      const cache = createToolFileStateCache();
      cache.set(
        '/file',
        state(`${'a'.repeat(5000)}\nb`, { offset, limit, isPartialView }),
      );
      expect(cache.get('/file')!.content).toBe('');
      expect(isFullFileRead(cache.get('/file')!)).toBe(full);
      cache.set('/file', { ...cache.get('/file')!, timestamp: 2 });
      const cloned = cloneFileStateCache(cache);
      const merged = mergeFileStateCaches(createToolFileStateCache(), cloned);
      expect(isFullFileRead(merged.get('/file')!)).toBe(full);
      expect(isFileContentInContext(merged.get('/file')!)).toBe(full);
      if (full) {
        markFileStateResultPartial(trackFileStateResult({}, merged, '/file'));
        expect(isFullFileRead(merged.get('/file')!)).toBe(false);
      }
      cache.set('/file', state('changed', { limit: 1 }));
      expect(isFullFileRead(cache.get('/file')!)).toBe(false);
    },
  );

  it('preserves attachment bodies and sticky keepContent without retaining stale content', () => {
    const text = 'a'.repeat(8192);
    const attachments = createFileStateCacheWithSizeLimit(100);
    attachments.set('/file', state(text));
    expect(attachments.get('/file')!.content).toBe(text);
    const tools = createToolFileStateCache();
    tools.set('/file', state(text, { keepContent: true }));
    tools.set('/file', { ...tools.get('/file')!, content: '' });
    expect(tools.get('/file')!.content).toBe(text);
    tools.set('/file', state('changed'));
    expect(tools.get('/file')!.keepContent).toBe(true);
    expect(isSameFileContent(tools.get('/file')!, 'changed')).toBe(true);
    expect(isSameFileContent(tools.get('/file')!, text)).toBe(false);
  });

  it('normalizes BOM and CRLF for comparisons and retains more than 100 tool records', () => {
    const cache = createToolFileStateCache();
    cache.set('/first', state('\uFEFFa\r\nb'));
    for (let i = 0; i < 150; i++) cache.set(`/file-${i}`, state('x'));
    expect(isSameFileContent(cache.get('/first')!, 'a\nb')).toBe(true);
    const other = createToolFileStateCache();
    expect(other.get('/first')).toBeUndefined();
  });
  it('does not let an older truncated output overwrite a newer Read', () => {
    const cache = createToolFileStateCache();
    cache.set('/file', state('old'));
    const oldResult = trackFileStateResult({}, cache, '/file');
    cache.set('/file', state('new'));
    markFileStateResultPartial(oldResult);
    expect(cache.get('/file')?.content).toBe('new');
    expect(cache.get('/file')?.isPartialView).toBeUndefined();
  });
});
