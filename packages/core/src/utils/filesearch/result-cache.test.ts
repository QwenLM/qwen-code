/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, test, expect, vi } from 'vitest';
import { ResultCache } from './result-cache.js';

afterEach(() => {
  vi.doUnmock('picomatch');
  vi.resetModules();
});

test('ResultCache basic usage', async () => {
  const files = [
    'foo.txt',
    'bar.js',
    'baz.md',
    'subdir/file.txt',
    'subdir/other.js',
    'subdir/nested/file.md',
  ];
  const cache = new ResultCache(files);
  const { files: resultFiles, isExactMatch } = await cache.get('*.js');
  expect(resultFiles).toEqual(files);
  expect(isExactMatch).toBe(false);
});

test('ResultCache cache hit/miss', async () => {
  const files = ['foo.txt', 'bar.js', 'baz.md'];
  const cache = new ResultCache(files);
  // First call: miss
  const { files: result1Files, isExactMatch: isExactMatch1 } =
    await cache.get('*.js');
  expect(result1Files).toEqual(files);
  expect(isExactMatch1).toBe(false);

  // Simulate FileSearch applying the filter and setting the result
  cache.set('*.js', ['bar.js']);

  // Second call: hit
  const { files: result2Files, isExactMatch: isExactMatch2 } =
    await cache.get('*.js');
  expect(result2Files).toEqual(['bar.js']);
  expect(isExactMatch2).toBe(true);
});

test('ResultCache best base query', async () => {
  const files = ['foo.txt', 'foobar.js', 'baz.md'];
  const cache = new ResultCache(files);

  // Cache a broader query
  cache.set('foo', ['foo.txt', 'foobar.js']);

  // Search for a more specific query that starts with the broader one
  const { files: resultFiles, isExactMatch } = await cache.get('foobar');
  expect(resultFiles).toEqual(['foo.txt', 'foobar.js']);
  expect(isExactMatch).toBe(false);
});

test('ResultCache does not use glob prefix matches as base queries', async () => {
  const files = ['app.js', 'component.jsx'];
  const cache = new ResultCache(files);

  cache.set('*.js', ['app.js']);

  const { files: resultFiles, isExactMatch } = await cache.get('*.jsx');
  expect(resultFiles).toEqual(files);
  expect(isExactMatch).toBe(false);
});

test('ResultCache does not reuse plain prefix when query becomes glob', async () => {
  const files = ['foo.txt', 'foobar.js', 'baz.md'];
  const cache = new ResultCache(files);

  cache.set('foo', ['foo.txt', 'foobar.js']);

  const { files: resultFiles, isExactMatch } = await cache.get('foo*');
  expect(resultFiles).toEqual(files);
  expect(isExactMatch).toBe(false);
});

test('ResultCache does not reuse glob cached key as prefix for plain query', async () => {
  vi.resetModules();
  // Isolate the cached-key guard; real glob keys usually make prefix queries
  // glob queries too, which would be stopped by the query guard first.
  vi.doMock('picomatch', () => ({
    default: {
      scan: (query: string) => ({ isGlob: query === 'foo' }),
    },
  }));

  const { ResultCache: ResultCacheWithMockedGlobScan } = await import(
    './result-cache.js'
  );
  const files = ['foo.txt', 'foobar.js', 'baz.md'];
  const cache = new ResultCacheWithMockedGlobScan(files);

  cache.set('foo', ['foo.txt']);

  const { files: resultFiles, isExactMatch } = await cache.get('foobar');
  expect(resultFiles).toEqual(files);
  expect(isExactMatch).toBe(false);
});
