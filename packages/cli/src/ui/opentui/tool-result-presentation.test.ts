/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getAutoMemoryRoot } from '@qwen-code/qwen-code-core/memory/paths.js';
import { toolResultPresentation } from './tool-result-presentation.js';

describe('toolResultPresentation', () => {
  it.each(['read_file', 'write_file'])(
    'does not count a failed %s as a completed memory operation',
    (name) => {
      const root = '/tmp/focus-presentation-project';
      const file_path = `${getAutoMemoryRoot(root)}/MEMORY.md`;
      expect(
        toolResultPresentation(
          'failed',
          undefined,
          { name, args: { file_path } },
          root,
          true,
        ).isMemoryOp,
      ).toBeUndefined();
    },
  );
  it('retains original read results for full details without replacing the summary', () => {
    const display = 'Read 1 line';
    const presentation = toolResultPresentation(
      display,
      [
        {
          functionResponse: {
            name: 'read_file',
            response: { output: 'FILE_BODY' },
          },
        },
      ],
      { name: 'read_file' },
    );
    expect(presentation).toEqual({ detailedDisplay: 'FILE_BODY' });
    expect(display).toBe('Read 1 line');
  });

  it('preserves nested image and omitted-image notices without copying binary payloads', () => {
    const presentation = toolResultPresentation('Image result', [
      {
        functionResponse: {
          name: 'image_tool',
          response: {},
          parts: Array.from({ length: 6 }, () => ({
            inlineData: { mimeType: 'image/png', data: 'AAAA' },
          })),
        },
      },
    ]);
    expect(presentation).toEqual({
      imageMimeTypes: ['image/png', 'image/png', 'image/png', 'image/png'],
      omittedImageCount: 2,
    });
    expect(JSON.stringify(presentation)).not.toContain('AAAA');
  });

  it('recognizes task results for any terminal status', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled']) {
      expect(
        toolResultPresentation({ type: 'task_execution', status }),
      ).toEqual({ isSubagent: true });
    }
  });

  it('classifies memory reads and writes only in managed paths', () => {
    const root = '/tmp/focus-presentation-project';
    const file_path = `${getAutoMemoryRoot(root)}/MEMORY.md`;
    expect(
      toolResultPresentation(
        '',
        undefined,
        { name: 'read_file', args: { file_path } },
        root,
      ).isMemoryOp,
    ).toBe('read');
    expect(
      toolResultPresentation(
        '',
        undefined,
        { name: 'write_file', args: { file_path } },
        root,
      ).isMemoryOp,
    ).toBe('write');
    expect(
      toolResultPresentation(
        '',
        undefined,
        { name: 'read_file', args: { file_path: 'src/main.ts' } },
        root,
      ).isMemoryOp,
    ).toBeUndefined();
  });
});
