/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildRipgrepFileFilter } from './ripgrepCrawler.js';
import { loadIgnoreRules } from './ignore.js';
import {
  cleanupTmpDir,
  createTmpDir,
} from '../../test-utils/file-system-test-helpers.js';

describe('buildRipgrepFileFilter', () => {
  it('treats a bare "." or "./" as a no-op filter (does not throw)', async () => {
    // Regression: on Windows, ripgrep emits paths with backslashes (".\\foo"),
    // which the crawler converts to posix ("./foo") but previously forgot to
    // strip the leading "./". The filter's ancestor-directory walk then fed
    // "./" into the `ignore` library, which throws RangeError on an
    // unrelativised path. That RangeError escaped the stdout data handler,
    // wrecked the stream, and produced silent empty results under CI.
    const tmpDir = await createTmpDir({ 'a.txt': '' });
    try {
      const filter = buildRipgrepFileFilter(
        loadIgnoreRules({
          projectRoot: tmpDir,
          useGitignore: false,
          useQwenignore: false,
          ignoreDirs: [],
        }),
      );

      expect(() => filter('.')).not.toThrow();
      expect(() => filter('./')).not.toThrow();
      expect(() => filter('')).not.toThrow();
      // And — paths with a stray leading "./" (as from a mis-normalised
      // Windows input) must not trip the dir-walker either.
      expect(() => filter('./src/foo.ts')).not.toThrow();
    } finally {
      await cleanupTmpDir(tmpDir);
    }
  });
});
