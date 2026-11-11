/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { canonicalizeTranscriptPath } from './transcript-path-canonicalizer.js';
import type { TranscriptPathFileSystem } from './transcript-path-file-system.js';

function createMockFileSystem(
  realpaths: Record<string, string>,
  missing: string[] = [],
): TranscriptPathFileSystem {
  return {
    realpath: vi.fn(async (p) => {
      if (missing.includes(p)) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return realpaths[p] ?? p;
    }),
  };
}

describe('canonicalizeTranscriptPath', () => {
  it('returns the realpath for existing files', async () => {
    const fs = createMockFileSystem({ '/tmp/t.jsonl': '/real/t.jsonl' });
    const result = await canonicalizeTranscriptPath('/tmp/t.jsonl', fs);
    expect(result).toBe('/real/t.jsonl');
  });

  it('falls back to canonicalizing the nearest existing ancestor', async () => {
    const fs = createMockFileSystem(
      { '/work': '/real/work' },
      ['/work/missing/file.jsonl', '/work/missing'],
    );
    const result = await canonicalizeTranscriptPath('/work/missing/file.jsonl', fs);
    expect(fs.realpath).toHaveBeenCalledWith('/work/missing/file.jsonl');
    expect(fs.realpath).toHaveBeenCalledWith('/work/missing');
    expect(fs.realpath).toHaveBeenCalledWith('/work');
    expect(result).toBe('/real/work/missing/file.jsonl');
  });

  it('returns the absolute path when no ancestor exists', async () => {
    const fs = createMockFileSystem({}, ['/noent/entirely/file.jsonl', '/noent/entirely', '/noent']);
    const result = await canonicalizeTranscriptPath('/noent/entirely/file.jsonl', fs);
    expect(result).toBe('/noent/entirely/file.jsonl');
  });
});
