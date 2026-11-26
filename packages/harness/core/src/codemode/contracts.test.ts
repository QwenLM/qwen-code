/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  editContract,
  globContract,
  grepContract,
  mcpContract,
  programmaticErrorMessage,
  projectProgrammaticResult,
  readContract,
  readImageContract,
  shellContract,
  textContract,
  writeContract,
} from './contracts.js';
import { TaskCreateTool, TaskListTool } from '../tools/taskTools.js';
import { WebFetchTool } from '../tools/web-fetch.js';
import { AskUserTool } from '../tools/ask-user.js';
import { EnterPlanModeTool } from '../tools/enter-plan-mode.js';
import { TaskStopTool } from '../tools/task-stop.js';
import { CronCreateTool } from '../tools/cron-create.js';
import { CronListTool } from '../tools/cron-list.js';
import { CronDeleteTool } from '../tools/cron-delete.js';
import { GetGoalTool } from '../tools/goalTools.js';
import { NotebookEditTool } from '../tools/notebook-edit.js';
import { ListAgentsTool } from '../messaging/list-agents-tool.js';
import type { ToolResult } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { JsonValue, ProgrammaticContract } from './types.js';
import { McpCallTool } from '../tools/mcp-lazy/mcp-call-tool.js';
import { makeFakeConfig } from '../test-utils/config.js';

const result = (value: unknown): ToolResult => ({
  llmContent: 'original secret',
  returnDisplay: '',
  toolUseResult: value,
});
describe('programmatic result contracts', () => {
  it('projects tools without structured results as the text the model sees', () => {
    expect(
      projectProgrammaticResult(textContract, {
        llmContent: [{ text: 'Task #1 created' }, { text: ': subject' }],
        returnDisplay: '',
        toolUseResult: { private: true },
      }),
    ).toEqual({ text: 'Task #1 created: subject' });
    const config = makeFakeConfig();
    for (const Tool of [TaskCreateTool, TaskListTool, WebFetchTool])
      expect(new Tool(config as never).programmatic).toBe(textContract);
  });

  it('keeps interactive and orchestrating tools model-only', () => {
    const config = makeFakeConfig();
    for (const tool of [
      new AskUserTool(),
      new EnterPlanModeTool(config),
      new TaskStopTool(config),
    ])
      expect(tool.exposureHints.modelOnly).toBe(true);
    expect(new TaskCreateTool(config).exposureHints.modelOnly).toBeUndefined();
  });

  it('defers rarely used script-callable tools by default', () => {
    const config = makeFakeConfig();
    for (const tool of [
      new CronCreateTool(config),
      new CronDeleteTool(config),
      new NotebookEditTool(config),
      new ListAgentsTool(config),
    ])
      expect(tool.exposureHints).toEqual({ defaultDeferred: true });
  });

  it('declares parameterless reads whose schema costs nothing to inline', () => {
    const config = makeFakeConfig();
    for (const tool of [new CronListTool(config), new GetGoalTool(config)])
      expect(tool.exposureHints.defaultDeferred).toBeUndefined();
  });

  it('bounds final error text and never exposes semantic or non-text fallback data', () => {
    const failed: ToolResult = {
      llmContent: [
        { text: 'Missing required argument projectId' },
        { inlineData: { data: 'private-image', mimeType: 'image/png' } },
        { text: '\n' + 'x'.repeat(5000) },
      ],
      returnDisplay: 'private display',
      toolUseResult: 'private pre-hook data',
      isError: true,
    };
    const message = programmaticErrorMessage(mcpContract, failed);
    expect(message).toHaveLength(4000);
    expect(message).toMatch(/^Missing required argument projectId\n/);
    expect(message).not.toContain('private');
    expect(
      programmaticErrorMessage(mcpContract, {
        ...failed,
        error: {
          type: ToolErrorType.EXECUTION_FAILED,
          message: 'hook blocked',
        },
      }),
    ).toBe('hook blocked');
    expect(
      programmaticErrorMessage(mcpContract, { ...failed, llmContent: '' }),
    ).toBe('Tool call did not succeed');
  });

  it('projects only post-hook Bash output and preserves truncation and file-state notices', () => {
    const semantic = {
      kind: 'completed',
      stdout: 'redacted tail',
      stderr: '',
      exitCode: 1,
      signal: null,
      staleReadFileStateHint: 'Re-read changed files',
      persistedOutput: {
        path: '/tmp/output',
        originalSizeBytes: 500,
        savedSizeBytes: 400,
        truncated: true,
        preview: 'unprojected preview',
      },
    };
    const projected = projectProgrammaticResult(
      shellContract,
      result(semantic),
    );
    expect(projected).toEqual({
      output: 'redacted tail',
      stderr: '',
      exitCode: 1,
      truncated: true,
      staleReadFileStateHint: 'Re-read changed files',
      persistedOutput: {
        path: '/tmp/output',
        originalSizeBytes: 500,
        savedSizeBytes: 400,
        truncated: true,
      },
    });
    expect(JSON.stringify(projected)).not.toContain('original secret');
    expect(shellContract.acceptsErrorResult?.(result(semantic))).toBe(true);
    expect(
      shellContract.acceptsErrorResult?.(result({ ...semantic, exitCode: 0 })),
    ).toBe(false);
    expect(
      shellContract.acceptsErrorResult?.(result({ ...semantic, signal: 9 })),
    ).toBe(false);
    expect(shellContract.acceptsErrorResult?.(result('hook replaced'))).toBe(
      false,
    );
    expect(() =>
      projectProgrammaticResult(
        shellContract,
        result({ kind: 'cancelled', timedOut: true }),
      ),
    ).toThrow('timed out');
    expect(() =>
      projectProgrammaticResult(
        shellContract,
        result({ kind: 'backgrounded', taskId: 'task-1' }),
      ),
    ).toThrow('task-1');
  });
  it('projects post-hook semantic text and reports partial reads', () => {
    const file = {
      filePath: 'a',
      content: 'redacted',
      startLine: 1,
      numLines: 2,
      totalLines: 2,
    };
    expect(
      projectProgrammaticResult(readContract, result({ type: 'text', file })),
    ).toEqual({ ...file, complete: true });
    expect(
      projectProgrammaticResult(
        readContract,
        result({ type: 'text', file: { ...file, startLine: 2, numLines: 1 } }),
      ),
    ).toMatchObject({ complete: false });
    expect(() =>
      projectProgrammaticResult(readContract, result({ type: 'image' })),
    ).toThrow(/text files/);
    expect(() =>
      projectProgrammaticResult(readContract, result('hook replaced result')),
    ).toThrow();
  });
  it('projects an image read as an image block for image({path}) only', () => {
    expect(
      projectProgrammaticResult(
        readImageContract,
        result({
          type: 'image',
          file: { base64: 'aGVsbG8=', type: 'image/png', originalSize: 5 },
        }),
      ),
    ).toEqual({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
    expect(() =>
      projectProgrammaticResult(
        readImageContract,
        result({ type: 'text', file: { content: 'x' } }),
      ),
    ).toThrow(/Not an image file/);
    for (const mimeType of ['image/svg+xml', 'image/tiff']) {
      expect(() =>
        projectProgrammaticResult(
          readImageContract,
          result({
            type: 'image',
            file: { base64: 'aGVsbG8=', type: mimeType },
          }),
        ),
      ).toThrow();
    }
    // A vision gate answers with text only; the script sees that explanation.
    expect(() =>
      projectProgrammaticResult(readImageContract, {
        llmContent: 'The current model does not support reading image files.',
        returnDisplay: '',
      }),
    ).toThrow(/does not support reading image files/);
  });
  it('requires completeness metadata for searches and never coerces result types', () => {
    const glob = {
      filenames: ['a'],
      numFiles: 1,
      truncated: true,
      totalMatches: 2,
      countIsComplete: true,
    };
    expect(projectProgrammaticResult(globContract, result(glob))).toEqual(glob);
    expect(() =>
      projectProgrammaticResult(
        globContract,
        result({ ...glob, numFiles: '1' }),
      ),
    ).toThrow();
    expect(
      projectProgrammaticResult(
        grepContract,
        result({
          mode: 'content',
          filenames: ['a'],
          numFiles: 1,
          content: 'redacted',
          truncated: true,
        }),
      ),
    ).toMatchObject({ truncated: true });
    expect(() =>
      projectProgrammaticResult(
        grepContract,
        result({ mode: 'content', filenames: [], numFiles: 0 }),
      ),
    ).toThrow();
  });
  it('does not expose obsolete patch fields or fall back to model output', () => {
    const value = {
      filePath: 'a',
      oldString: 'a',
      newString: 'b',
      userModified: false,
      replaceAll: false,
    };
    expect(
      projectProgrammaticResult(
        editContract,
        result({ ...value, originalFile: 'secret', structuredPatch: [] }),
      ),
    ).toEqual(value);
    expect(
      projectProgrammaticResult(
        writeContract,
        result({ type: 'create', filePath: 'a', content: 'b' }),
      ),
    ).toEqual({ type: 'create', filePath: 'a', content: 'b' });
    expect(() =>
      projectProgrammaticResult(writeContract, result(undefined)),
    ).toThrow();
  });
  it.each([NaN, undefined, () => {}, new Date()])(
    'rejects non-JSON projections: %s',
    (value) => {
      const contract: ProgrammaticContract = {
        outputSchema: {},
        project: () => value as JsonValue,
      };
      expect(() => projectProgrammaticResult(contract, result({}))).toThrow();
    },
  );
  it('preserves MCP content alongside structured results and strips only protocol metadata', () => {
    const structuredContent = { rows: [1], _meta: 'business data' };
    const blocks = [
      { type: 'text', text: 'caption', _meta: { secret: 'private' } },
      { type: 'image', mimeType: 'image/png', data: 'AA' },
      {
        type: 'resource',
        resource: {
          uri: 'test://result',
          text: 'body',
          _meta: { secret: true },
        },
      },
    ];
    const projected = projectProgrammaticResult(mcpContract, {
      ...result('display conversion'),
      mcpMeta: { _meta: { private: true } },
      mcpResult: { content: blocks, structuredContent, isError: true },
      isError: true,
    });
    expect(projected).toEqual({
      content: [
        { type: 'text', text: 'caption' },
        blocks[1],
        { type: 'resource', resource: { uri: 'test://result', text: 'body' } },
      ],
      structuredContent,
      isError: true,
    });
    expect(mcpContract.notice?.(projected, {})).toContain(
      'isError=true: caption',
    );
    expect(JSON.stringify(projected)).not.toContain('secret');
    expect(blocks[0]._meta).toBeDefined();
    // Scripts call MCP tools directly; mcp_call serves agents without CodeMode.
    expect(new McpCallTool(makeFakeConfig()).exposureHints.metaTool).toBe(
      'mcp',
    );
  });
  it('uses final MCP hook replacements without restoring stale structured metadata', () => {
    expect(
      projectProgrammaticResult(mcpContract, {
        ...result('redacted'),
        mcpMeta: { structuredContent: { secret: 'pre-hook' } },
      }),
    ).toEqual({
      content: [{ type: 'text', text: 'redacted' }],
      isError: false,
    });
    expect(
      projectProgrammaticResult(
        mcpContract,
        result({ content: [], structuredContent: { redacted: true } }),
      ),
    ).toEqual({
      content: [],
      structuredContent: { redacted: true },
      isError: false,
    });
    expect(() =>
      projectProgrammaticResult(mcpContract, {
        llmContent: 'Error: MCP tool "x" not found.',
        returnDisplay: '',
      }),
    ).toThrow('MCP tool "x" not found');
  });
  it('reports completeness independently of empty content and expected exits', () => {
    const shell = projectProgrammaticResult(
      shellContract,
      result({
        kind: 'completed',
        signal: null,
        stdout: '',
        stderr: '',
        exitCode: 1,
        returnCodeInterpretation: 'No matches found',
      }),
    );
    expect(shell).toMatchObject({
      returnCodeInterpretation: 'No matches found',
    });
    expect(shellContract.notice?.(shell, {})).toBe(
      'Bash exited with code 1; No matches found',
    );
    expect(
      shellContract.notice?.(
        {
          ...(shell as object),
          exitCode: 0,
        } as JsonValue,
        {},
      ),
    ).toBeUndefined();
    const partial = {
      complete: false,
      startLine: 5,
      numLines: 2,
      totalLines: 9,
    };
    expect(readContract.notice?.(partial, {})).toBe(
      'Partial file: startLine=5, numLines=2, totalLines=9',
    );
    // A requested range is expected; only a read the tool cut short is reported.
    expect(
      readContract.notice?.(partial, { offset: 5, limit: 2 }),
    ).toBeUndefined();
    expect(
      readContract.notice?.({ ...partial, totalLines: 6 }, { offset: 5 }),
    ).toBeUndefined();
    expect(readContract.notice?.(partial, { offset: 5, limit: 4 })).toBe(
      'Partial file: startLine=5, numLines=2, totalLines=9',
    );
    const glob = {
      filenames: [],
      numFiles: 0,
      truncated: false,
      totalMatches: 0,
      countIsComplete: true,
    };
    expect(
      globContract.notice?.(
        projectProgrammaticResult(globContract, result(glob)),
        {},
      ),
    ).toBeUndefined();
    expect(
      globContract.notice?.({ ...glob, countIsComplete: false }, {}),
    ).toContain('lower bound');
    const grep = {
      mode: 'content',
      filenames: [],
      numFiles: 0,
      truncated: false,
    };
    expect(
      grepContract.notice?.(
        projectProgrammaticResult(grepContract, result(grep)),
        {},
      ),
    ).toBeUndefined();
    expect(grepContract.notice?.({ ...grep, appliedOffset: 10 }, {})).toContain(
      'offset=10',
    );
    expect(
      grepContract.notice?.({ ...grep, appliedOffset: 10 }, { offset: 10 }),
    ).toBeUndefined();
    expect(grepContract.notice?.({ ...grep, truncated: true }, {})).toContain(
      'truncated=true',
    );
  });
});
