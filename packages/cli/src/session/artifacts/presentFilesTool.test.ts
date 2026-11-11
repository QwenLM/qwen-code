/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PresentFilesTool } from './presentFilesTool.js';
import { PRESENT_FILES_TOOL_NAME } from './artifactProtocol.js';

const ARTIFACT = {
  path: '/workspace/reports/中文 报告 (最终).md',
  display_path: 'reports/中文 报告 (最终).md',
  name: '中文 报告 (最终).md',
  kind: 'presented' as const,
  relative_path: 'reports/中文 报告 (最终).md',
  size: 12,
  mime: 'text/markdown',
  mtime: 42,
};

describe('PresentFilesTool', () => {
  it('describes requested file outputs as deliverables without including incidental files', () => {
    const tool = new PresentFilesTool(vi.fn());

    expect(tool.description).toContain(
      'even when they do not explicitly ask to download, attach, send, or present it',
    );
    expect(tool.description).toContain(
      'Do not deliver incidental source-code edits, temporary or intermediate files',
    );
    expect(tool.description).toContain('failed or incomplete outputs');
  });

  it('exposes the Web-compatible tool name and returns structured file metadata', async () => {
    const present = vi.fn().mockResolvedValue([ARTIFACT]);
    const tool = new PresentFilesTool(present);

    const result = await tool
      .build({
        files: [{ file_path: 'reports/中文 报告 (最终).md' }],
      })
      .execute(new AbortController().signal);

    expect(tool.name).toBe(PRESENT_FILES_TOOL_NAME);
    expect(present).toHaveBeenCalledWith(['reports/中文 报告 (最终).md']);
    expect(result.error).toBeUndefined();
    expect(result.toolUseResult).toEqual({
      type: 'present_files',
      files: [{ ...ARTIFACT, file_path: ARTIFACT.path }],
      isHardFailure: false,
    });
  });

  it('does not report success until the injected shared-runtime projection finishes', async () => {
    let finishProjection!: (artifacts: readonly [typeof ARTIFACT]) => void;
    const projection = new Promise<readonly [typeof ARTIFACT]>((resolve) => {
      finishProjection = resolve;
    });
    const present = vi.fn(() => projection);
    const tool = new PresentFilesTool(present);
    let settled = false;

    const execution = tool
      .build({ files: [{ file_path: ARTIFACT.path }] })
      .execute(new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();

    expect(present).toHaveBeenCalledExactlyOnceWith([ARTIFACT.path]);
    expect(settled).toBe(false);

    finishProjection([ARTIFACT]);
    await expect(execution).resolves.toMatchObject({
      toolUseResult: {
        type: 'present_files',
        files: [{ file_path: ARTIFACT.path }],
        isHardFailure: false,
      },
    });
  });

  it('returns a hard tool failure when validation or snapshot publication fails', async () => {
    const tool = new PresentFilesTool(
      vi.fn().mockRejectedValue(new Error('artifact snapshot failed')),
    );

    const result = await tool
      .build({ files: [{ file_path: 'report.md' }] })
      .execute(new AbortController().signal);

    expect(result.error?.message).toBe('artifact snapshot failed');
    expect(result.toolUseResult).toEqual({
      type: 'present_files',
      files: [],
      isHardFailure: true,
    });
  });

  it('requires at least one exact file path', () => {
    const tool = new PresentFilesTool(vi.fn());

    expect(tool.validateToolParams({ files: [] })).not.toBeNull();
    expect(
      tool.validateToolParams({
        files: [{ file_path: '' }],
      }),
    ).not.toBeNull();
  });
});
