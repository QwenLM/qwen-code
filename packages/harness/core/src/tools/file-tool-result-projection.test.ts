/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_EXTERNAL_FILE_TOOL_DIFF_BYTES,
  projectFileToolResultForExternalUse,
} from './file-tool-result-projection.js';

describe('projectFileToolResultForExternalUse', () => {
  it('projects Edit results without complete file or replacement contents', () => {
    const projected = projectFileToolResultForExternalUse({
      filePath: '/workspace/example.ts',
      oldString: 'old',
      newString: 'new',
      originalFile: 'const value = "old";\n',
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-const value = "old";', '+const value = "new";'],
        },
      ],
      userModified: false,
      replaceAll: false,
    });

    expect(projected).toEqual({
      success: true,
      file_path: '/workspace/example.ts',
      diff:
        '@@ -1,1 +1,1 @@\n-const value = "old";\n+const value = "new";\n',
      additions: 1,
      deletions: 1,
    });
    expect(projected).not.toHaveProperty('originalFile');
    expect(projected).not.toHaveProperty('oldString');
    expect(projected).not.toHaveProperty('newString');
    expect(projected).not.toHaveProperty('structuredPatch');
  });

  it('projects Write results with byte count instead of file bodies', () => {
    const projected = projectFileToolResultForExternalUse({
      type: 'create',
      filePath: '/workspace/你好.txt',
      content: '你好',
      structuredPatch: [],
      originalFile: null,
    });

    expect(projected).toEqual({
      success: true,
      file_path: '/workspace/你好.txt',
      bytesWritten: 6,
      additions: 0,
      deletions: 0,
    });
    expect(projected).not.toHaveProperty('content');
    expect(projected).not.toHaveProperty('originalFile');
    expect(projected).not.toHaveProperty('structuredPatch');
  });

  it('bounds large UTF-8 diffs while retaining complete line statistics', () => {
    const addedLines = Array.from({ length: 100_000 }, () => '+你好');
    const projected = projectFileToolResultForExternalUse({
      filePath: '/workspace/large.txt',
      oldString: '',
      newString: 'large',
      originalFile: '',
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: addedLines.length,
          lines: addedLines,
        },
      ],
      userModified: false,
      replaceAll: false,
    }) as Record<string, unknown>;

    expect(projected['diff_truncated']).toBe(true);
    expect(projected['additions']).toBe(addedLines.length);
    expect(Buffer.byteLength(projected['diff'] as string, 'utf8')).toBeLessThanOrEqual(
      MAX_EXTERNAL_FILE_TOOL_DIFF_BYTES,
    );
    expect(projected['diff']).not.toContain('\uFFFD');
  });

  it('leaves unrelated tool results unchanged', () => {
    const result = { filePath: '/workspace/example.ts', content: 'partial' };
    expect(projectFileToolResultForExternalUse(result)).toBe(result);
  });
});
