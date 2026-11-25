/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message as TranscriptMessage } from '../../protocol/transcript/message.js';
import {
  EDIT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../tools/tool-names.js';
import { collectAutoMemoryWritePaths } from './autoDreamService.js';

function assistantToolUse(
  id: string,
  name: string,
  filePath: string,
): TranscriptMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name,
          input: { file_path: filePath },
        },
      ],
    },
  } as unknown as TranscriptMessage;
}

function toolResult(id: string, isError: boolean): TranscriptMessage {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: isError ? 'failed' : 'ok',
          is_error: isError,
        },
      ],
    },
  } as unknown as TranscriptMessage;
}

describe('collectAutoMemoryWritePaths', () => {
  it('counts only write/edit tools with successful tool results', () => {
    const cwd = '/tmp/test-dream-project';
    const memoryDir = path.join(cwd, 'memory');
    const okPath = path.join(memoryDir, 'ok.md');
    const failedPath = path.join(memoryDir, 'failed.md');
    const missingResultPath = path.join(memoryDir, 'missing.md');

    expect(
      collectAutoMemoryWritePaths(
        [
          assistantToolUse('write-ok', WRITE_FILE_TOOL_NAME, okPath),
          assistantToolUse('edit-failed', EDIT_TOOL_NAME, failedPath),
          assistantToolUse(
            'write-missing',
            WRITE_FILE_TOOL_NAME,
            missingResultPath,
          ),
          toolResult('write-ok', false),
          toolResult('edit-failed', true),
        ],
        memoryDir,
        cwd,
      ),
    ).toEqual([okPath]);
  });
});
