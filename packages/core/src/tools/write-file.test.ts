/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AlreadyReadFileAttachment } from '../attachments/models/file-attachments.js';
import { FileAttachment } from '../attachments/models/file-attachments.js';
import { createPermissionManager } from '../test-utils/config.js';
import { permissionRulesFromStartup } from '../permissions/settings/startup-rules.js';
import type { ToolUseContext } from './tool-types.js';
import type { Message } from '../protocol/transcript/message.js';
import {
  createToolFileStateCache,
  getFileStateResult,
} from '../utils/fileStateCache.js';
const fileReadState = createToolFileStateCache();
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WriteFileTool,
  FILE_UNEXPECTEDLY_MODIFIED_ERROR,
  type WriteFileToolParams,
} from './write-file.js';
import { ToolErrorType } from './tool-error.js';
import { type FileDiff } from './tools.js';
import type { Config } from '../config/config.js';
import {
  initializeShellSession,
  runWithShellSession,
  runWithCwdOverride,
  setCwd,
} from '../utils/Shell.js';
import type { ToolRegistry } from './tool-registry.js';
import path from 'node:path';
import { isSubpath } from '../utils/paths.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { ReadFileTool } from './read-file.js';
import { recordShellFileReads } from './shell.js';
import * as fileWriteUtils from '../utils/fileWriteUtils.js';
import { executeToolWithHooks } from '../core/coreToolHookTriggers.js';
import {
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from './tool-names.js';

const rootDir = path.resolve(os.tmpdir(), 'gemini-cli-test-root');
const plansDir = path.resolve(os.tmpdir(), 'gemini-cli-test-plans');
const memoryDir = path.resolve(
  os.tmpdir(),
  'gemini-cli-test-config-home',
  '.qwen',
  'projects',
  'test',
  'memory',
);

// --- MOCKS ---
vi.mock('./jit-context.js', () => ({
  activateConditionalSkillsForPath: vi.fn(),
  discoverJitContext: vi.fn().mockResolvedValue(undefined),
}));

// Mock Config
const fsService = new StandardFileSystemService();
let mockConfig: Config;
const mockConfigInternal = {
  fileReadState,
  getTargetDir: () => rootDir,
  getPermissionMode: vi.fn(() => 'default'),
  setPermissionMode: vi.fn(),
  getFileSystemService: () => fsService,
  getWorkspaceContext: () => new WorkspaceContext(rootDir, [plansDir]),
  getApiKey: () => 'test-key',
  getModel: () => 'test-model',
  getDebugMode: () => false,
  getQuestion: () => undefined,

  getMcpServerCommand: () => undefined,
  getMcpServers: () => undefined,
  getUserAgent: () => 'test-agent',
  getUserMemory: () => '',
  getMemoryMdFileCount: () => 0,
  getToolRegistry: () =>
    ({
      registerTool: vi.fn(),
      discoverTools: vi.fn(),
    }) as unknown as ToolRegistry,
  isInteractive: () => false,
  getHookSystem: () => undefined,
  isPlanMode: vi.fn(() => false),
  isAutoMemoryEnabled: () => false,
  isAutoMemoryUserScopeEnabled: vi.fn(() => false),
  getActiveModel: () => 'test-model',
  validateSettingsContent: () => null,
  storage: {
    getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
    getPlansDir: vi.fn().mockReturnValue(plansDir),
    getProjectMemoryTempDir: vi.fn().mockReturnValue(memoryDir),
  },
};

// --- END MOCKS ---

/**
 * Helper: seed the FileStateCache so that the write tool's
 * read-before-write validation passes for an existing file.
 */
function seedFileStateCache(filePath: string, content: string): void {
  const fileStat = fs.statSync(filePath);
  const fileStateCache = fileReadState;
  fileStateCache.set(filePath, {
    content,
    timestamp: Math.floor(fileStat.mtimeMs),
    offset: undefined,
    limit: undefined,
  });
}

describe('WriteFileTool', () => {
  it('validates and writes relative paths under the session cwd after cd', async () => {
    const child = path.join(fs.realpathSync(rootDir), 'sub');
    fs.mkdirSync(child);
    fs.mkdirSync(path.join(child, 'directory'));
    runWithShellSession(mockConfig, () => setCwd(child));
    expect(
      tool.validateToolParams({ file_path: 'directory', content: 'x' }),
    ).toContain('Path is a directory');
    const invocation = tool.build({
      file_path: 'note.txt',
      content: 'child content',
    });
    expect(invocation.toolLocations()[0].path).toBe(
      path.join(child, 'note.txt'),
    );
    runWithShellSession(mockConfig, () => setCwd(rootDir));
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(path.join(child, 'note.txt'), 'utf8')).toBe(
      'child content',
    );
    expect(fs.existsSync(path.join(rootDir, 'note.txt'))).toBe(false);
  });

  it('keeps writes in an agent cwd independent of another session', () => {
    const second = { ...mockConfig } as Config;
    initializeShellSession(second, plansDir);
    const params = { file_path: 'note.txt', content: 'x' };
    const child = path.join(rootDir, 'agent');
    expect(
      runWithCwdOverride(child, () =>
        tool.build({ ...params }),
      ).toolLocations()[0].path,
    ).toBe(path.join(child, 'note.txt'));
    expect(
      new WriteFileTool(second).build({ ...params }).toolLocations()[0].path,
    ).toBe(path.join(plansDir, 'note.txt'));
    expect(tool.build(params).toolLocations()[0].path).toBe(
      path.join(rootDir, 'note.txt'),
    );
  });

  it('checks permissions against the pinned child file even if cwd changes before approval', async () => {
    const child = path.join(fs.realpathSync(rootDir), 'sub');
    fs.mkdirSync(child);
    runWithShellSession(mockConfig, () => setCwd(child));
    const input = { file_path: 'note.txt', content: 'x' };
    const invocation = tool.build(input);
    expect(input.file_path).toBe(invocation.toolLocations()[0].path);
    runWithShellSession(mockConfig, () => setCwd(rootDir));
    const permission = createPermissionManager({
      cwd: fs.realpathSync(rootDir),
      permissionMode: 'acceptEdits',
      rules: {
        allow: {},
        ask: {},
        deny: { projectSettings: ['Edit(/sub/**)'] },
      },
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const decision = await permission.check({
      toolName: 'Write',
      input,
      toolUseId: 'child-write',
      signal: new AbortController().signal,
    });
    expect(decision.kind).toBe('deny');
    expect(fs.existsSync(input.file_path)).toBe(false);
  });

  it('refuses Write recovery after restoring malformed multi-result replacement metadata', async () => {
    const { restoreToolFileReadState } = await import(
      '../attachments/transcript-state.js'
    );
    const files = ['malformed-a.txt', 'malformed-b.txt'].map((name) =>
      path.join(rootDir, name),
    );
    for (const file of files) fs.writeFileSync(file, 'visible');
    const calls = files.map((file, index) => ({
      type: 'tool_use',
      id: `read-${index}`,
      name: 'Read',
      input: { file_path: file },
    }));
    restoreToolFileReadState(
      fileReadState,
      [
        { type: 'assistant', message: { content: calls } },
        {
          type: 'user',
          timestamp: new Date().toISOString(),
          readOutputReplacement: path.join(rootDir, 'unrelated.txt'),
          message: {
            role: 'user',
            content: calls.map((call) => ({
              type: 'tool_result',
              tool_use_id: call.id,
              content: '1\tvisible',
            })),
          },
          toolUseResult: files.map((filePath) => ({
            file: { filePath, content: 'visible' },
          })),
        },
      ] as unknown as Message[],
      rootDir,
    );
    const permission = createPermissionManager({
      cwd: rootDir,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const execution: ToolUseContext = {
      signal: new AbortController().signal,
      fileReadState,
      agentLoopContext: Object.assign(Object.create(mockConfig), {
        permission,
        toolRegistry: { getTool: () => ({}) },
      }),
    };
    for (const file of files) {
      const result = await tool.build({
        file_path: file,
        content: 'replacement',
      }).executeWithContext!(execution);
      expect(result.error?.message).toContain('File has not been read yet');
      expect(fs.readFileSync(file, 'utf8')).toBe('visible');
    }
    const { ReadFileTool } = await import('./read-file.js');
    await new ReadFileTool(mockConfig).build({ file_path: files[1] })
      .executeWithContext!(execution);
    const written = await tool.build({
      file_path: files[1],
      content: 'replacement',
    }).executeWithContext!(execution);
    expect(written.error).toBeUndefined();
    expect(fs.readFileSync(files[1], 'utf8')).toBe('replacement');
  });

  it.each([
    '1\tvisible',
    '',
    { file: { filePath: 'wrong.txt', content: 'visible' } },
  ])(
    'keeps hook-replaced Read partial through the scheduler and resume: %j',
    async (replacement) => {
      const { ReadFileTool } = await import('./read-file.js');
      const { createAttachmentContext } = await import(
        '../attachments/get-attachments.js'
      );
      const { restoreAttachmentTranscriptState } = await import(
        '../attachments/transcript-state.js'
      );
      const { isFullFileRead } = await import('../utils/fileStateCache.js');
      const { executeToolWithHooks } = await import(
        '../core/coreToolHookTriggers.js'
      );
      const { PostToolUseHookOutput } = await import('../hooks/types.js');
      const {
        completedToolCallToResult,
        convertToolResultToCompletedToolCall,
      } = await import('../tool-executor/index.js');
      const { createToolResultMessage } = await import(
        '../protocol/transcript/conversions.js'
      );
      const { splitUserForSdk } = await import(
        '../engine/headless-projection.js'
      );
      const file = path.join(rootDir, 'hook-output.txt');
      fs.writeFileSync(file, 'visible\nhidden');
      const live = createAttachmentContext(rootDir);
      const readTool = new ReadFileTool(mockConfig);
      const invocation = readTool.build({ file_path: file });
      const hookConfig = {
        ...mockConfig,
        getHookSystem: () => ({
          firePostToolUseEvent: async () => ({
            finalOutput: new PostToolUseHookOutput({
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput: replacement,
              },
            }),
          }),
        }),
      } as unknown as Config;
      const read = await executeToolWithHooks(
        invocation,
        'Read',
        {
          signal: new AbortController().signal,
          fileReadState: live.fileReadState,
        },
        readTool,
        hookConfig,
      );
      expect(read.error).toBeUndefined();
      expect(read.toolUseResult).toEqual(replacement);
      expect(read.readOutputReplacement).toBe(file);
      expect(isFullFileRead(live.fileReadState.get(file)!)).toBe(false);
      // The original request can differ from the actual invocation after PreToolUse.
      const request = {
        callId: 'r',
        name: 'Read',
        args: { file_path: 'original.txt' },
        prompt_id: 'p',
        isClientInitiated: false,
      };
      const completed = convertToolResultToCompletedToolCall(
        {
          request,
          tool: readTool,
          invocation,
          result: read,
          error: undefined,
          cancelled: false,
          durationMs: 1,
        },
        'scheduler',
        undefined,
      );
      const result = createToolResultMessage(
        [completedToolCallToResult(completed)],
        'assistant',
      );
      expect(result.readOutputReplacement).toBe(file);
      expect(result.toolUseResult).toEqual(replacement);
      expect(JSON.stringify(splitUserForSdk(result, 'session'))).not.toContain(
        'readOutputReplacement',
      );
      const history = JSON.parse(
        JSON.stringify([
          {
            type: 'assistant',
            timestamp: result.timestamp,
            cwd: rootDir,
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'r',
                  name: 'Read',
                  input: request.args,
                },
              ],
            },
          },
          { ...result, cwd: rootDir },
        ]),
      ) as Message[];
      const resumed = createAttachmentContext(rootDir);
      restoreAttachmentTranscriptState(resumed, history);
      expect(
        resumed.fileReadState.has(path.join(rootDir, 'original.txt')),
      ).toBe(false);
      expect(resumed.fileReadState.has(path.join(rootDir, 'wrong.txt'))).toBe(
        false,
      );
      expect(isFullFileRead(resumed.fileReadState.get(file)!)).toBe(false);
      const ctx = {
        signal: new AbortController().signal,
        fileReadState: resumed.fileReadState,
      };
      const blocked = await tool.build({
        file_path: file,
        content: 'replacement',
      }).executeWithContext!(ctx);
      expect(blocked.error).toBeDefined();
      expect(fs.readFileSync(file, 'utf8')).toBe('visible\nhidden');
      await readTool.build({ file_path: file }).executeWithContext!(ctx);
      const written = await tool.build({
        file_path: file,
        content: 'replacement',
      }).executeWithContext!(ctx);
      expect(written.error).toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
    },
  );

  it.each(['resume', 'compact', 'deferred compact'])(
    'restores Notebook Read for NotebookEdit after %s',
    async (mode) => {
      const { ReadFileTool } = await import('./read-file.js');
      const { NotebookEditTool } = await import('./notebook-edit.js');
      const { createAttachmentContext } = await import(
        '../attachments/get-attachments.js'
      );
      const { restoreAttachmentTranscriptState } = await import(
        '../attachments/transcript-state.js'
      );
      const { createToolResultMessage } = await import(
        '../protocol/transcript/conversions.js'
      );
      const { partToString } = await import('../utils/partUtils.js');
      const file = path.join(rootDir, 'restore-notebook.ipynb');
      fs.writeFileSync(
        file,
        JSON.stringify({
          cells: [
            {
              cell_type: 'code',
              id: 'first',
              execution_count: null,
              metadata: {},
              outputs: [
                { output_type: 'stream', name: 'stdout', text: ['1\n'] },
              ],
              source: ['print(1)'],
            },
            {
              cell_type: 'markdown',
              id: 'second',
              metadata: {},
              source: ['Explanation'],
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
      );
      const live = createAttachmentContext(rootDir);
      const read = await new ReadFileTool(mockConfig).build({
        file_path: file,
        offset: 2,
        limit: 1,
      }).executeWithContext!({
        signal: new AbortController().signal,
        fileReadState: live.fileReadState,
      });
      expect(read.error).toBeUndefined();
      const result = createToolResultMessage(
        [
          {
            type: 'tool_result',
            tool_use_id: 'r',
            content: partToString(read.llmContent),
            is_error: false,
            toolUseResult: read.toolUseResult,
          },
        ],
        'assistant',
      );
      let history: readonly Message[] = JSON.parse(
        JSON.stringify([
          {
            type: 'assistant',
            timestamp: result.timestamp,
            cwd: rootDir,
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'r',
                  name: 'Read',
                  input: { file_path: file, offset: 2, limit: 1 },
                },
              ],
            },
          },
          result,
        ]),
      ) as Message[];
      const restored = createAttachmentContext(rootDir);
      if (mode !== 'resume') {
        const { applyPostCompact } = await import(
          '../compression-v2/apply-post-compact.js'
        );
        const { drainPostCompactRestoreAttachments } = await import(
          '../attachments/generators/restore-generators.js'
        );
        const { createAttachmentMessage } = await import(
          '../attachments/factory.js'
        );
        const summary = {
          type: 'user',
          timestamp: result.timestamp,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Summary' }],
          },
        } as Message;
        history = await applyPostCompact(
          history,
          mode === 'compact' ? [summary] : [summary, history[0]],
          {
            config: {
              ...mockConfig,
              getApprovedPlanPath: () => null,
              isPlanMode: () => false,
            } as unknown as Config,
            attachmentCtx: restored,
            replaceMessages: vi.fn(),
            pushAttachments: vi.fn(),
            transcriptParentUuid: () => null,
            setTranscriptParentUuid: vi.fn(),
          },
        );
        if (mode === 'deferred compact') {
          expect(restored.fileReadState.has(file)).toBe(false);
          history = [
            ...history,
            ...drainPostCompactRestoreAttachments(restored).map(
              createAttachmentMessage,
            ),
          ] as Message[];
        }
        expect(restored.fileReadState.has(file)).toBe(true);
        expect(restored.fileReadState.get(file)!.content).toBe(
          live.fileReadState.get(file)!.content,
        );
      }
      const resumed = createAttachmentContext(rootDir);
      restoreAttachmentTranscriptState(
        resumed,
        JSON.parse(JSON.stringify(history)) as Message[],
      );
      expect(resumed.fileReadState.has(file)).toBe(true);
      if (mode === 'resume') {
        expect(resumed.fileReadState.get(file)!.content).toBe(
          live.fileReadState.get(file)!.content,
        );
        expect(resumed.fileReadState.get(file)!.isPartialView).toBe(false);
      }
      const edited = await new NotebookEditTool(mockConfig).build({
        notebook_path: file,
        cell_id: 'first',
        edit_mode: 'replace',
        new_source: 'print(2)',
      }).executeWithContext!({
        signal: new AbortController().signal,
        fileReadState: resumed.fileReadState,
      });
      expect(edited.error).toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toContain('print(2)');
    },
  );

  let tool: WriteFileTool;
  let tempDir: string;

  it('restores a hook-narrowed range across resume and allows Write while unchanged', async () => {
    const { ReadFileTool } = await import('./read-file.js');
    const { createAttachmentContext } = await import(
      '../attachments/get-attachments.js'
    );
    const { restoreAttachmentTranscriptState } = await import(
      '../attachments/transcript-state.js'
    );
    const { isFullFileRead } = await import('../utils/fileStateCache.js');
    const { evaluatePreToolUseHook } = await import(
      '../hooks/preToolUseEvaluation.js'
    );
    const { PreToolUseHookOutput } = await import('../hooks/types.js');
    const file = path.join(rootDir, 'hook-range.txt');
    const original = 'visible\nhidden';
    fs.writeFileSync(file, original);
    const live = createAttachmentContext(rootDir);
    const readTool = new ReadFileTool(mockConfig);
    const input = { file_path: file };
    const hookConfig = {
      ...mockConfig,
      getHookSystem: () => ({
        firePreToolUseEvent: async () => ({
          finalOutput: new PreToolUseHookOutput({
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { ...input, limit: 1 },
            },
          }),
        }),
      }),
    } as unknown as Config;
    const hook = await evaluatePreToolUseHook(
      hookConfig,
      readTool,
      { callId: 'r', name: 'Read', args: input, prompt_id: 'range-test' },
      readTool.build(input),
    );
    if (hook.status !== 'continue' || !hook.newInvocation)
      throw new Error('Expected hook-modified Read');
    const read = await hook.newInvocation.executeWithContext!({
      signal: new AbortController().signal,
      fileReadState: live.fileReadState,
    });
    expect(read.error).toBeUndefined();
    expect(read.toolUseResult).toMatchObject({
      file: { startLine: 1, numLines: 1, totalLines: 2 },
    });
    expect(isFullFileRead(live.fileReadState.get(file)!)).toBe(false);
    const timestamp = new Date().toISOString();
    const history = [
      {
        type: 'assistant',
        timestamp,
        cwd: rootDir,
        message: {
          content: [{ type: 'tool_use', id: 'r', name: 'Read', input }],
        },
      },
      {
        type: 'user',
        timestamp,
        cwd: rootDir,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'r', content: read.llmContent },
          ],
        },
        toolUseResult: read.toolUseResult,
      },
    ] as unknown as Message[];
    const resumed = createAttachmentContext(rootDir);
    restoreAttachmentTranscriptState(resumed, history);
    expect(isFullFileRead(resumed.fileReadState.get(file)!)).toBe(false);
    expect(resumed.fileReadState.get(file)).toMatchObject({
      offset: 1,
      limit: 1,
      isPartialView: false,
    });
    const permission = createPermissionManager({
      cwd: rootDir,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const execution: ToolUseContext = {
      signal: new AbortController().signal,
      fileReadState: resumed.fileReadState,
      agentLoopContext: {
        ...mockConfigInternal,
        permission,
        toolRegistry: { getTool: () => readTool },
      } as unknown as ToolUseContext['agentLoopContext'],
    };
    const write = await tool.build({
      file_path: file,
      content: 'replacement',
    }).executeWithContext!(execution);
    expect(write.error).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });

  it('refuses a full overwrite after a real truncated file attachment', async () => {
    const { createAttachmentContext } = await import(
      '../attachments/get-attachments.js'
    );
    const { generateFileAttachment } = await import(
      '../attachments/generators/file-generators.js'
    );
    const file = path.join(rootDir, 'truncated.txt');
    const original = Array.from(
      { length: 2100 },
      (_, i) => `${String(i).padStart(4, '0')} ${'a'.repeat(43)}`,
    ).join('\n');
    fs.writeFileSync(file, original);
    const attachmentCtx = createAttachmentContext(rootDir);
    const attachment = await generateFileAttachment(
      file,
      'at-mention',
      attachmentCtx,
    );
    expect(attachment).toMatchObject({ type: 'file', truncated: true });
    if (attachment?.type !== 'file')
      throw new Error('Expected file attachment');
    const { createAttachmentMessage } = await import(
      '../attachments/factory.js'
    );
    const { restoreAttachmentTranscriptState } = await import(
      '../attachments/transcript-state.js'
    );
    const { isFullFileRead } = await import('../utils/fileStateCache.js');
    const history = [
      createAttachmentMessage(attachment),
    ] as unknown as Message[];
    const resumed = createAttachmentContext(rootDir);
    restoreAttachmentTranscriptState(resumed, history);
    const next = await generateFileAttachment(file, 'at-mention', resumed);
    expect(next).toMatchObject({ type: 'file', truncated: true });
    if (!next) throw new Error('Expected repeated file attachment');
    const resumedAgain = createAttachmentContext(rootDir);
    restoreAttachmentTranscriptState(resumedAgain, [
      ...history,
      createAttachmentMessage(next) as unknown as Message,
    ]);
    const legacyNotice = createAttachmentMessage(
      new AlreadyReadFileAttachment({
        type: 'already_read_file',
        filename: file,
        displayPath: 'truncated.txt',
        content: attachment.content,
        mtime: attachment.mtime,
      }),
    ) as unknown as Message;
    const legacy = createAttachmentContext(rootDir);
    restoreAttachmentTranscriptState(legacy, [...history, legacyNotice]);
    const orphan = createAttachmentContext(rootDir);
    restoreAttachmentTranscriptState(orphan, [legacyNotice]);
    const permission = createPermissionManager({
      cwd: rootDir,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    for (const ctx of [attachmentCtx, resumed, resumedAgain, legacy, orphan]) {
      expect(isFullFileRead(ctx.fileReadState.get(file)!)).toBe(false);
      const result = await tool.build({
        file_path: file,
        content: 'replacement',
      }).executeWithContext!({
        signal: new AbortController().signal,
        fileReadState: ctx.fileReadState,
        agentLoopContext: {
          ...mockConfigInternal,
          permission,
          toolRegistry: { getTool: () => ({}) },
        } as unknown as ToolUseContext['agentLoopContext'],
      });
      expect(result.error).toBeDefined();
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    }
  });

  it('allows Write after a real full Read replaces a restored partial baseline', async () => {
    const { ReadFileTool } = await import('./read-file.js');
    const { createAttachmentContext } = await import(
      '../attachments/get-attachments.js'
    );
    const { restoreAttachmentTranscriptState } = await import(
      '../attachments/transcript-state.js'
    );
    const { createAttachmentMessage } = await import(
      '../attachments/factory.js'
    );
    const { isFullFileRead } = await import('../utils/fileStateCache.js');
    const file = path.join(rootDir, 'read-after-partial.txt');
    fs.writeFileSync(file, 'visible\nhidden');
    const ctx = createAttachmentContext(rootDir);
    restoreAttachmentTranscriptState(ctx, [
      createAttachmentMessage(
        new FileAttachment({
          type: 'file',
          filename: file,
          displayPath: 'read-after-partial.txt',
          content: 'visible',
          truncated: true,
          mtime: Math.floor(fs.statSync(file).mtimeMs),
        }),
      ) as unknown as Message,
    ]);
    expect(isFullFileRead(ctx.fileReadState.get(file)!)).toBe(false);
    const execution = {
      signal: new AbortController().signal,
      fileReadState: ctx.fileReadState,
    };
    const read = await new ReadFileTool(mockConfig).build({ file_path: file })
      .executeWithContext!(execution);
    expect(read.error).toBeUndefined();
    expect(isFullFileRead(ctx.fileReadState.get(file)!)).toBe(true);
    const write = await tool.build({ file_path: file, content: 'replacement' })
      .executeWithContext!(execution);
    expect(write.error).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });

  it.each(['missing', 'partial', 'stale', 'notebook'])(
    'applies Write recovery policy for %s',
    async (kind) => {
      const file = path.join(
        rootDir,
        kind === 'notebook' ? 'file.ipynb' : 'file.txt',
      );
      fs.writeFileSync(file, 'original');
      if (kind === 'partial')
        fileReadState.set(file, {
          content: 'original',
          timestamp: Math.floor(fs.statSync(file).mtimeMs),
          offset: 1,
          limit: undefined,
          isPartialView: true,
        });
      if (kind === 'stale')
        fileReadState.set(file, {
          content: 'old',
          timestamp: 0,
          offset: 1,
          limit: undefined,
        });
      const permission = createPermissionManager({
        cwd: rootDir,
        checkerDeps: {
          skill: {
            isAllowedForMainSession: () => true,
            isDisabled: () => false,
            hasOnlySafeProperties: () => false,
          },
          mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
        },
      });
      const ctx: ToolUseContext = {
        signal: new AbortController().signal,
        fileReadState,
        agentLoopContext: Object.assign(Object.create(mockConfig), {
          permission,
          toolRegistry: { getTool: () => ({}) },
        }),
      };
      const result = await new WriteFileTool(mockConfig).build({
        file_path: file,
        content: 'replacement',
      }).executeWithContext!(ctx);
      expect(Boolean(result.error)).toBe(kind !== 'missing');
      expect(fs.readFileSync(file, 'utf8')).toBe(
        kind === 'missing' ? 'replacement' : 'original',
      );
    },
  );

  it('keeps --tools Bash Write as availability-only for guarded writes', async () => {
    const permission = createPermissionManager({
      cwd: rootDir,
      rules: permissionRulesFromStartup({
        coreTools: [SHELL_TOOL_NAME, WRITE_FILE_TOOL_NAME],
      }),
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const ctx: ToolUseContext = {
      signal: new AbortController().signal,
      fileReadState,
      agentLoopContext: Object.assign(Object.create(mockConfig), {
        permission,
        toolRegistry: {
          getTool: (name: string) =>
            name === READ_FILE_TOOL_NAME ? undefined : {},
        },
      }),
    };

    const newFile = path.join(rootDir, 'new-without-read.txt');
    const created = await tool.build({
      file_path: newFile,
      content: 'created',
    }).executeWithContext!(ctx);
    expect(created.error).toBeUndefined();
    expect(fs.readFileSync(newFile, 'utf8')).toBe('created');

    const existingFile = path.join(rootDir, 'existing-without-read.txt');
    fs.writeFileSync(existingFile, 'old');
    const unread = await tool.build({
      file_path: existingFile,
      content: 'new',
    }).executeWithContext!(ctx);
    expect(unread.error?.message).toContain('File has not been read yet');
    expect(fs.readFileSync(existingFile, 'utf8')).toBe('old');

    await recordShellFileReads(
      'cat existing-without-read.txt',
      rootDir,
      fileReadState,
      0,
      ctx.signal,
    );
    const afterBashRead = await tool.build({
      file_path: existingFile,
      content: 'new',
    }).executeWithContext!(ctx);
    expect(afterBashRead.error).toBeUndefined();
    expect(fs.readFileSync(existingFile, 'utf8')).toBe('new');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a unique temporary directory for files created outside the root
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'write-file-test-external-'),
    );
    // Ensure the rootDir and plansDir for the tool exists
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const workspaceContext = new WorkspaceContext(rootDir, [plansDir]);
    const mockStorage = {
      getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
      getPlansDir: vi.fn().mockReturnValue(plansDir),
      getProjectMemoryTempDir: vi.fn().mockReturnValue(memoryDir),
    };

    mockConfig = {
      ...mockConfigInternal,
      getWorkspaceContext: () => workspaceContext,
      storage: mockStorage,
      isPathAllowed(this: Config, absolutePath: string): boolean {
        const workspaceContext = this.getWorkspaceContext();
        if (workspaceContext.isPathWithinWorkspace(absolutePath)) {
          return true;
        }

        const projectTempDir = this.storage.getProjectTempDir();
        return isSubpath(path.resolve(projectTempDir), absolutePath);
      },
      validatePathAccess(this: Config, absolutePath: string): string | null {
        if (this.isPathAllowed(absolutePath)) {
          return null;
        }

        const workspaceDirs = this.getWorkspaceContext().getDirectories();
        const projectTempDir = this.storage.getProjectTempDir();
        return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
      },
    } as unknown as Config;

    // Reset mocks before each test
    mockConfigInternal.getPermissionMode.mockReturnValue('default');
    mockConfigInternal.setPermissionMode.mockClear();
    mockConfigInternal.isPlanMode.mockReturnValue(false);
    mockConfigInternal.isAutoMemoryUserScopeEnabled.mockReturnValue(false);

    initializeShellSession(mockConfig, rootDir);
    tool = new WriteFileTool(mockConfig);

    // Clear the file state cache before each test
    fileReadState.clear();
  });

  afterEach(() => {
    // Clean up the temporary directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    if (fs.existsSync(plansDir)) {
      fs.rmSync(plansDir, { recursive: true, force: true });
    }
    if (fs.existsSync(memoryDir)) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('build', () => {
    it('should return an invocation for a valid absolute path within root', () => {
      const params = {
        file_path: path.join(rootDir, 'test.txt'),
        content: 'hello',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);
    });

    it('should return an invocation for a valid relative path within root', () => {
      const params = {
        file_path: 'test.txt',
        content: 'hello',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);
    });

    it('does not enforce workspace boundary at param validation (pipeline decides)', () => {
      const outsidePath = path.resolve(tempDir, 'outside-root.txt');
      const params = {
        file_path: outsidePath,
        content: 'hello',
      };
      // Path boundary is decided by the permission pipeline, not the tool's
      // parameter self-check. build() no longer rejects out-of-workspace paths.
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should throw an error if path is a directory', () => {
      const dirAsFilePath = path.join(rootDir, 'a_directory');
      fs.mkdirSync(dirAsFilePath);
      const params = {
        file_path: dirAsFilePath,
        content: 'hello',
      };
      expect(() => tool.build(params)).toThrow(
        `Path is a directory, not a file: ${dirAsFilePath}`,
      );
    });

    it('should throw an error if the content is null', () => {
      const dirAsFilePath = path.join(rootDir, 'a_directory');
      fs.mkdirSync(dirAsFilePath);
      const params = {
        file_path: dirAsFilePath,
        content: null,
      } as unknown as WriteFileToolParams; // Intentionally non-conforming
      expect(() => tool.build(params)).toThrow('params/content must be string');
    });

    it('should throw error if the file_path is empty', () => {
      const dirAsFilePath = path.join(rootDir, 'a_directory');
      fs.mkdirSync(dirAsFilePath);
      const params = {
        file_path: '',
        content: '',
      };
      expect(() => tool.build(params)).toThrow(`Missing or empty "file_path"`);
    });

    it('should reject unread writes at execution without changing the file', async () => {
      const filePath = path.join(rootDir, 'unread-file.txt');
      fs.writeFileSync(filePath, 'existing content');
      const result = await tool
        .build({ file_path: filePath, content: 'new content' })
        .execute(new AbortController().signal);
      expect(result.error?.message).toContain('File has not been read yet');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('existing content');
    });

    it('should reject an unread file during pre-permission validation', async () => {
      const filePath = path.join(rootDir, 'unread-preflight.txt');
      fs.writeFileSync(filePath, 'existing content');
      const invocation = tool.build({
        file_path: filePath,
        content: 'new content',
      });

      const result = await invocation.validateBeforePermission!({
        signal: new AbortController().signal,
        fileReadState,
      });

      expect(result?.error?.message).toContain('File has not been read yet');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('existing content');
    });

    it('should pass pre-permission validation for a new file', async () => {
      const filePath = path.join(rootDir, 'new-preflight.txt');
      const invocation = tool.build({
        file_path: filePath,
        content: 'new content',
      });

      const result = await invocation.validateBeforePermission!({
        signal: new AbortController().signal,
        fileReadState,
      });

      expect(result).toBeUndefined();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should reject write to existing file with partial view (isPartialView)', async () => {
      const filePath = path.join(rootDir, 'partial-view-file.txt');
      fs.writeFileSync(filePath, 'existing content', 'utf8');

      // Seed cache with isPartialView = true
      const fileStat = fs.statSync(filePath);
      fileReadState.set(filePath, {
        content: 'existing content',
        timestamp: Math.floor(fileStat.mtimeMs),
        offset: undefined,
        limit: undefined,
        isPartialView: true,
      });

      const params = {
        file_path: filePath,
        content: 'new content',
      };
      expect(
        (await tool.build(params).execute(new AbortController().signal)).error
          ?.message,
      ).toContain('File has not been read yet');
    });

    it('should reject write to file modified since last read (staleness)', async () => {
      const filePath = path.join(rootDir, 'stale-file.txt');
      fs.writeFileSync(filePath, 'original content', 'utf8');

      // The file contents, not only its mtime, changed after the cached read.
      fileReadState.set(filePath, {
        content: 'original content',
        timestamp: 0, // Very old timestamp
        offset: undefined,
        limit: undefined,
      });

      fs.writeFileSync(filePath, 'externally modified content', 'utf8');

      const params = {
        file_path: filePath,
        content: 'new content',
      };
      fs.writeFileSync(filePath, 'external content');
      expect(
        (await tool.build(params).execute(new AbortController().signal)).error
          ?.message,
      ).toContain('File has been modified since');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('external content');
    });

    it('should allow write to existing file that has been read and is fresh', () => {
      const filePath = path.join(rootDir, 'fresh-file.txt');
      fs.writeFileSync(filePath, 'existing content', 'utf8');
      seedFileStateCache(filePath, 'existing content');

      const params = {
        file_path: filePath,
        content: 'new content',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
    });

    it('should allow write to new file without read', () => {
      const filePath = path.join(rootDir, 'brand-new-file.txt');
      // File does not exist, no read required
      const params = {
        file_path: filePath,
        content: 'new content',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
    });
  });

  describe('execute', () => {
    const abortSignal = new AbortController().signal;

    it('should write a new file with a relative path', async () => {
      const relativePath = 'execute_relative_new_file.txt';
      const filePath = path.join(rootDir, relativePath);
      const content = 'Content for relative path file.';

      const params = { file_path: relativePath, content };
      const invocation = tool.build(params);

      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('File created successfully at:');
      expect(fs.existsSync(filePath)).toBe(true);
      const writtenContent = await fsService.readTextFile(filePath);
      expect(writtenContent).toBe(content);
    });

    it('should return error if readOriginalContent returns an error during execute', async () => {
      const filePath = path.join(rootDir, 'execute_error_file.txt');
      const params = { file_path: filePath, content: 'test content' };
      fs.writeFileSync(filePath, 'original', { mode: 0o000 });
      seedFileStateCache(filePath, 'original');

      vi.spyOn(fileWriteUtils, 'readFileWithMetadata').mockImplementationOnce(
        () => {
          throw new Error('Simulated read error for execute');
        },
      );

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('Error checking existing file');
      expect(result.returnDisplay).toMatch(/Error checking existing file/);
      expect(result.returnDisplay).toMatch(/Simulated read error for execute/);
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);

      fs.chmodSync(filePath, 0o600);
    });

    it('should write a new file with raw content (no LLM correction) and return diff', async () => {
      const filePath = path.join(rootDir, 'execute_new_file.txt');
      const content = 'New content for execute.';

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);

      const result = await invocation.execute(abortSignal);

      // Simple create message
      expect(result.llmContent).toContain('File created successfully at:');
      expect(result.llmContent).toContain('no need to read it back');
      expect(result.toolUseResult).toMatchObject({ content, filePath });
      expect(fs.existsSync(filePath)).toBe(true);
      const writtenContent = await fsService.readTextFile(filePath);
      // Raw content written as-is, no correction
      expect(writtenContent).toBe(content);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileName).toBe('execute_new_file.txt');
      expect(display.fileDiff).toMatch(/--- execute_new_file.txt\tOriginal/);
      expect(display.fileDiff).toMatch(/\+\+\+ execute_new_file.txt\tWritten/);
      expect(display.fileDiff).toMatch(
        content.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      );
    });

    it('should overwrite an existing file with raw content and return diff', async () => {
      const filePath = path.join(rootDir, 'execute_existing_file.txt');
      const initialContent = 'Initial content for execute.';
      const proposedContent = 'Proposed overwrite for execute.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedFileStateCache(filePath, initialContent);

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);

      const result = await invocation.execute(abortSignal);

      // Simple update message
      expect(result.llmContent).toContain('has been updated successfully.');
      expect(result.llmContent).toContain('no need to read it back');
      expect(result.toolUseResult).toMatchObject({
        content: proposedContent,
        filePath,
      });
      const writtenContent = await fsService.readTextFile(filePath);
      // Raw content written, no correction
      expect(writtenContent).toBe(proposedContent);
      expect(result.fileWrite).toEqual({
        filePath,
        workspacePath: rootDir,
        originalContent: initialContent,
        proposedContent,
        writtenContent: proposedContent,
      });
      const display = result.returnDisplay as FileDiff;
      expect(display.fileName).toBe('execute_existing_file.txt');
      expect(display.fileDiff).toMatch(
        initialContent.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      );
      expect(display.fileDiff).toMatch(
        proposedContent.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      );
    });

    it('keeps the AI proposal separate from user-modified written content', async () => {
      const filePath = path.join(rootDir, 'execute_user_modified.txt');
      const initialContent = 'Initial content.';
      const proposedContent = 'AI proposed content.';
      const writtenContent = 'User modified content.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedFileStateCache(filePath, initialContent);

      const result = await tool
        .build({
          file_path: filePath,
          content: writtenContent,
          modified_by_user: true,
          ai_proposed_content: proposedContent,
        })
        .execute(abortSignal);

      expect(result.fileWrite).toEqual({
        filePath,
        workspacePath: rootDir,
        originalContent: initialContent,
        proposedContent,
        writtenContent,
      });
      expect(fs.readFileSync(filePath, 'utf8')).toBe(writtenContent);
      expect(result.llmContent).not.toContain('no need to read it back');
    });

    it.each([false, true])(
      'uses the invocation cache for feedback (input modified by hook=%s)',
      async (inputModifiedByHook) => {
        const filePath = path.join(rootDir, 'context-feedback.txt');
        const cache = createToolFileStateCache();
        const result = await tool.build({
          file_path: filePath,
          content: 'written',
        }).executeWithContext!({
          signal: abortSignal,
          fileReadState: cache,
          inputModifiedByHook,
        });
        expect(result.error).toBeUndefined();
        expect(
          String(result.llmContent).includes('no need to read it back'),
        ).toBe(!inputModifiedByHook);
        expect(
          String(result.llmContent).includes(
            'hook modified the write parameters',
          ),
        ).toBe(inputModifiedByHook);
        expect(cache.get(filePath)?.contentNotInModelContext).toBe(
          inputModifiedByHook,
        );
        expect(fileReadState.has(filePath)).toBe(false);
        expect(getFileStateResult(result)?.cache).toBe(cache);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('written');
      },
    );

    it('keeps write success without the hint if post-write stat fails', async () => {
      const filePath = path.join(rootDir, 'stat-feedback.txt');
      const stat = vi.spyOn(fsPromises, 'stat');
      const writeTextContent = fileWriteUtils.writeTextContent;
      const write = vi
        .spyOn(fileWriteUtils, 'writeTextContent')
        .mockImplementationOnce(async (...args) => {
          await writeTextContent(...args);
          stat.mockRejectedValueOnce(new Error('stat failed'));
        });
      try {
        const result = await tool
          .build({ file_path: filePath, content: 'written' })
          .execute(abortSignal);
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain('File created successfully');
        expect(result.llmContent).not.toContain('no need to read it back');
        expect(fileReadState.has(filePath)).toBe(false);
        expect(getFileStateResult(result)).toBeUndefined();
        expect(fs.readFileSync(filePath, 'utf8')).toBe('written');
      } finally {
        write.mockRestore();
        stat.mockRestore();
      }
    });

    it('does not bind a write result to a state replaced before feedback is built', async () => {
      const filePath = path.join(rootDir, 'replaced-feedback.txt');
      let laterState: ReturnType<typeof fileReadState.get>;
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireFileChangedEvent: async () => {
          fileReadState.set(filePath, {
            ...fileReadState.get(filePath)!,
            content: 'later state',
          });
          laterState = fileReadState.get(filePath);
        },
      } as unknown as ReturnType<Config['getHookSystem']>);
      const result = await tool.build({
        file_path: filePath,
        content: 'written',
      }).executeWithContext!({ signal: abortSignal });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).not.toContain('no need to read it back');
      expect(getFileStateResult(result)).toBeUndefined();
      expect(fileReadState.get(filePath)).toBe(laterState);
    });

    it('withdraws a real Write hint when PostToolUse changes content but preserves mtime', async () => {
      const filePath = path.join(rootDir, 'post-hook-feedback.txt');
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireFileChangedEvent: async () => undefined,
        firePostToolUseEvent: async () => {
          const timestamp = fileReadState.get(filePath)!.timestamp;
          fs.writeFileSync(filePath, 'formatted');
          fs.utimesSync(filePath, new Date(timestamp), new Date(timestamp));
          return {
            success: true,
            allOutputs: [],
            errors: [],
            totalDuration: 0,
          };
        },
      } as unknown as ReturnType<Config['getHookSystem']>);
      const result = await executeToolWithHooks(
        tool.build({ file_path: filePath, content: 'written' }),
        WRITE_FILE_TOOL_NAME,
        { signal: abortSignal },
        tool,
        mockConfig,
      );
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('hook changed the file');
      expect(result.hookNotices).toEqual([
        expect.stringContaining('hook changed the file'),
      ]);
      expect(result.llmContent).not.toContain('no need to read it back');
      expect(fileReadState.get(filePath)).toMatchObject({
        content: 'formatted',
        contentNotInModelContext: true,
      });
      expect(result.toolUseResult).toMatchObject({ content: 'written' });
    });

    it('should create directory if it does not exist', async () => {
      const dirPath = path.join(rootDir, 'new_dir_for_write');
      const filePath = path.join(dirPath, 'file_in_new_dir.txt');
      const content = 'Content in new directory';

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);

      await invocation.execute(abortSignal);

      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });

    it.each([
      {
        modified_by_user: true,
        shouldIncludeMessage: true,
        testCase: 'when modified_by_user is true',
      },
      {
        modified_by_user: false,
        shouldIncludeMessage: false,
        testCase: 'when modified_by_user is false',
      },
      {
        modified_by_user: undefined,
        shouldIncludeMessage: false,
        testCase: 'when modified_by_user is not provided',
      },
    ])(
      'should $testCase include modification message',
      async ({ modified_by_user, shouldIncludeMessage }) => {
        const filePath = path.join(rootDir, `new_file_${modified_by_user}.txt`);
        const content = 'New file content';

        const params: WriteFileToolParams = {
          file_path: filePath,
          content,
          ...(modified_by_user !== undefined && { modified_by_user }),
        };
        const invocation = tool.build(params);
        const result = await invocation.execute(abortSignal);

        if (shouldIncludeMessage) {
          expect(result.llmContent).toMatch(/User modified the `content`/);
        } else {
          expect(result.llmContent).not.toMatch(/User modified the `content`/);
        }
      },
    );

    it('should return simple LLM message for new file (no diff snippet)', async () => {
      const filePath = path.join(rootDir, 'content_check.txt');
      const content = 'This is the content that should be returned.';

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);

      const result = await invocation.execute(abortSignal);

      // LLM gets simple "File created" message, not a diff
      expect(result.llmContent).toContain('File created successfully at:');
      expect(result.llmContent).not.toContain('Here is the updated code:');
    });

    it('should return simple LLM message for updated file (no diff snippet)', async () => {
      const filePath = path.join(rootDir, 'update_check.txt');
      const originalContent = 'Original content.';
      fs.writeFileSync(filePath, originalContent, 'utf8');
      seedFileStateCache(filePath, originalContent);

      const newContent = 'Updated content.';
      const params = { file_path: filePath, content: newContent };
      const invocation = tool.build(params);

      const result = await invocation.execute(abortSignal);

      // LLM gets simple "updated successfully" message, not a diff
      expect(result.llmContent).toContain('has been updated successfully.');
      expect(result.llmContent).not.toContain('Here is the updated code:');
    });

    it('should update FileStateCache after successful write', async () => {
      const filePath = path.join(rootDir, 'cache_update_test.txt');
      const content = 'Cache update test content.';

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);

      await invocation.execute(abortSignal);

      // Verify the cache was updated with the written content
      const fileStateCache = fileReadState;
      const cachedState = fileStateCache.get(filePath);
      expect(cachedState).toBeDefined();
      expect(cachedState!.content).toBe(content);
      expect(cachedState!.offset).toBeUndefined();
      expect(cachedState!.limit).toBeUndefined();
    });
  });

  describe('workspace boundary validation', () => {
    it('should validate paths are within workspace root', () => {
      const params = {
        file_path: path.join(rootDir, 'file.txt'),
        content: 'test content',
      };
      expect(() => tool.build(params)).not.toThrow();
    });

    it('does not reject paths outside workspace root at param validation', () => {
      const params = {
        file_path: path.join(tempDir, 'outside-workspace.txt'),
        content: 'test content',
      };
      // Boundary enforcement moved to the permission pipeline.
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should allow paths within the plans directory', () => {
      const params = {
        file_path: path.join(plansDir, 'my-plan.md'),
        content: '# My Plan',
      };
      expect(() => tool.build(params)).not.toThrow();
    });

    it('does not reject plans-directory-escaping paths at param validation', () => {
      const params = {
        file_path: path.join(plansDir, '..', 'escaped.txt'),
        content: 'malicious',
      };
      // Boundary enforcement moved to the permission pipeline.
      expect(() => tool.build(params)).not.toThrow();
    });

    it.each([
      ['forward slashes', '//network-share/output.txt'],
      ['backslashes', '\\\\server\\share\\file.txt'],
    ])(
      'should accept a UNC path with %s without probing the filesystem',
      (_label, filePath) => {
        // The verdict belongs to the permission layer, which denies network
        // writes. Validation returning null is the proof that it never stat'ed
        // the path — that call is the SMB handshake this change exists to
        // avoid, and reaching it would have produced a validation error.
        const params = { file_path: filePath, content: 'test' };
        expect(tool.validateToolParams(params)).toBeNull();
      },
    );
  });

  describe('specific error types for write failures', () => {
    const abortSignal = new AbortController().signal;

    it.each([
      {
        errorCode: 'EACCES',
        errorType: ToolErrorType.PERMISSION_DENIED,
        errorMessage: 'Permission denied',
        expectedMessagePrefix: 'Permission denied writing to file',
        mockFsExistsSync: false,
        restoreAllMocks: false,
      },
      {
        errorCode: 'ENOSPC',
        errorType: ToolErrorType.NO_SPACE_LEFT,
        errorMessage: 'No space left on device',
        expectedMessagePrefix: 'No space left on device',
        mockFsExistsSync: false,
        restoreAllMocks: false,
      },
      {
        errorCode: 'EISDIR',
        errorType: ToolErrorType.TARGET_IS_DIRECTORY,
        errorMessage: 'Is a directory',
        expectedMessagePrefix: 'Target is a directory, not a file',
        mockFsExistsSync: true,
        restoreAllMocks: false,
      },
      {
        errorCode: undefined,
        errorType: ToolErrorType.FILE_WRITE_FAILURE,
        errorMessage: 'Generic write error',
        expectedMessagePrefix: 'Error writing to file',
        mockFsExistsSync: false,
        restoreAllMocks: false,
      },
    ])(
      'should return $errorType error when write fails with $errorCode',
      async ({
        errorCode,
        errorType,
        errorMessage,
        expectedMessagePrefix,
        mockFsExistsSync,
      }) => {
        const filePath = path.join(rootDir, `${errorType}_file.txt`);
        const content = 'test content';

        let existsSyncSpy: // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ReturnType<typeof vi.spyOn<any, 'existsSync'>> | undefined = undefined;

        try {
          if (mockFsExistsSync) {
            const originalExistsSync = fs.existsSync;
            existsSyncSpy = vi
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .spyOn(fs as any, 'existsSync')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .mockImplementation((path: any) =>
                path === filePath ? false : originalExistsSync(path),
              );
          }

          vi.spyOn(fileWriteUtils, 'writeTextContent').mockImplementationOnce(
            () => {
              const error = new Error(errorMessage) as NodeJS.ErrnoException;
              if (errorCode) error.code = errorCode;
              return Promise.reject(error);
            },
          );

          const params = { file_path: filePath, content };
          const invocation = tool.build(params);
          const result = await invocation.execute(abortSignal);

          expect(result.error?.type).toBe(errorType);
          const errorSuffix = errorCode ? ` (${errorCode})` : '';
          const expectedMessage = errorCode
            ? `${expectedMessagePrefix}: ${filePath}${errorSuffix}`
            : `${expectedMessagePrefix}: ${errorMessage}`;
          expect(result.llmContent).toContain(expectedMessage);
          expect(result.returnDisplay).toContain(expectedMessage);
        } finally {
          if (existsSyncSpy) {
            existsSyncSpy.mockRestore();
          }
        }
      },
    );
  });

  describe('read-state validation parity', () => {
    const signal = new AbortController().signal;

    it.each([1999, 2000, 2001])(
      'preserves default-page write guards after cache compaction (%i lines)',
      async (totalLines) => {
        const file = path.join(rootDir, 'default-page-write.txt');
        const content = Array.from(
          { length: totalLines },
          (_, i) => `line ${i + 1}`,
        ).join('\n');
        fs.writeFileSync(file, content);
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: file })
          .execute(signal);
        expect(read.error).toBeUndefined();
        const baseline = fileReadState.get(file)!;
        expect(baseline.content).toBe('');
        // Exercise the fingerprint path as well as the unchanged-mtime path.
        if (totalLines <= 2000) {
          fs.utimesSync(file, new Date(), new Date(baseline.timestamp + 2000));
        }
        const invocation = tool.build({
          file_path: file,
          content: 'replacement',
        });
        const preflight = await invocation.validateBeforePermission!({
          signal,
          fileReadState,
        });
        const result = await invocation.execute(signal);
        if (totalLines > 2000) {
          expect(baseline.isPartialView).toBe(true);
          expect(preflight?.error?.message).toContain(
            'File has not been read yet',
          );
          expect(result.error?.message).toContain('File has not been read yet');
          expect(fs.readFileSync(file, 'utf8')).toBe(content);
        } else {
          expect(preflight).toBeUndefined();
          expect(result.error).toBeUndefined();
          expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
        }
      },
    );

    it.each([undefined, 100])(
      'allows Write after a full Read compacts a large file (limit=%s)',
      async (limit) => {
        const file = path.join(rootDir, 'large-full-read.txt');
        fs.writeFileSync(file, `${'a'.repeat(5000)}\nsecond line`);
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: file, limit })
          .execute(signal);
        expect(read.error).toBeUndefined();
        expect(fileReadState.get(file)!.content).toBe('');
        const invocation = tool.build({
          file_path: file,
          content: 'replacement',
        });
        expect(
          await invocation.validateBeforePermission!({ signal, fileReadState }),
        ).toBeUndefined();
        const result = await invocation.execute(signal);
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
      },
    );

    it.each([false, true])(
      'checks content fingerprints after a compacted full Read (changed=%s)',
      async (changed) => {
        const file = path.join(rootDir, 'large-stale-read.txt');
        const content = `${'a'.repeat(5000)}\nsecond line`;
        fs.writeFileSync(file, content);
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: file })
          .execute(signal);
        expect(read.error).toBeUndefined();
        const previous = fileReadState.get(file)!;
        expect(previous.content).toBe('');
        if (changed) fs.writeFileSync(file, `${content}\nexternal change`);
        fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
        const result = await tool
          .build({ file_path: file, content: 'replacement' })
          .execute(signal);
        if (changed) {
          expect(result.error?.type).toBe(
            ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
          );
          expect(fs.readFileSync(file, 'utf8')).toBe(
            `${content}\nexternal change`,
          );
        } else {
          expect(result.error).toBeUndefined();
          expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
        }
      },
    );

    it.each([1, 2])(
      'allows Write after an unchanged explicit range Read (offset=%s)',
      async (offset) => {
        const file = path.join(rootDir, 'large-partial-read.txt');
        const content = `${'a'.repeat(5000)}\n${'b'.repeat(5000)}`;
        fs.writeFileSync(file, content);
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: file, offset, limit: 1 })
          .execute(signal);
        expect(read.error).toBeUndefined();
        expect(fileReadState.get(file)!.content).toBe('');
        const invocation = tool.build({
          file_path: file,
          content: 'replacement',
        });
        expect(
          await invocation.validateBeforePermission!({ signal, fileReadState }),
        ).toBeUndefined();
        const result = await invocation.execute(signal);
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
      },
    );

    it.each([false, true])(
      'rechecks a compacted explicit-range baseline when mtime changes (after preflight=%s)',
      async (afterPreflight) => {
        const file = path.join(rootDir, 'large-range-touched.txt');
        const content = `${'a'.repeat(5000)}\nsecond line`;
        fs.writeFileSync(file, content);
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: file, limit: 100 })
          .execute(signal);
        expect(read.error).toBeUndefined();
        const baseline = fileReadState.get(file)!;
        expect(baseline.content).toBe('');
        const invocation = tool.build({
          file_path: file,
          content: 'replacement',
        });
        if (afterPreflight) {
          expect(
            await invocation.validateBeforePermission!({
              signal,
              fileReadState,
            }),
          ).toBeUndefined();
        }
        fs.utimesSync(file, new Date(), new Date(baseline.timestamp + 2000));
        const preflight = await invocation.validateBeforePermission!({
          signal,
          fileReadState,
        });
        expect(preflight?.error?.type).toBe(
          ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
        );
        const result = await invocation.execute(signal);
        expect(result.error?.type).toBe(
          ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
        );
        expect(fs.readFileSync(file, 'utf8')).toBe(content);
      },
    );

    it.each([false, true])(
      'accepts unchanged BOM content (touch after build=%s)',
      async (touchAfterBuild) => {
        const file = path.join(rootDir, 'bom-state.txt');
        fs.writeFileSync(file, '\uFEFForiginal\r\ncontent');
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: file })
          .execute(signal);
        expect(read.error).toBeUndefined();
        const previous = fileReadState.get(file)!;
        expect(previous.content).toBe('original\ncontent');
        const touch = () =>
          fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
        if (!touchAfterBuild) touch();
        const invocation = tool.build({
          file_path: file,
          content: '\uFEFFupdated\ncontent',
        });
        if (touchAfterBuild) touch();
        const result = await invocation.execute(signal);
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(file, 'utf8')).toBe('\uFEFFupdated\r\ncontent');
        expect(fileReadState.get(file)?.content).toBe('updated\ncontent');
      },
    );

    it('rejects changed BOM content after a full Read', async () => {
      const file = path.join(rootDir, 'bom-changed.txt');
      fs.writeFileSync(file, '\uFEFForiginal\r\ncontent');
      await new ReadFileTool(mockConfig)
        .build({ file_path: file })
        .execute(signal);
      const previous = fileReadState.get(file)!;
      fs.writeFileSync(file, '\uFEFFexternally changed\r\ncontent');
      fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
      const result = await tool
        .build({ file_path: file, content: 'replacement' })
        .execute(signal);
      expect(result.error).toBeDefined();
    });

    it.each([undefined, 100])(
      'accepts mtime-only changes before build after a full Read (limit=%s)',
      async (limit) => {
        const file = path.join(rootDir, 'full-read.txt');
        fs.writeFileSync(file, 'original\r\ncontent\r\n');
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: file, limit })
          .execute(signal);
        expect(read.error).toBeUndefined();
        const previous = fileReadState.get(file)!;
        expect(previous.offset).toBe(1);
        fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
        const result = await tool
          .build({ file_path: file, content: 'updated\ncontent\n' })
          .execute(signal);
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(file, 'utf8')).toBe('updated\r\ncontent\r\n');
      },
    );

    it('keeps a normalized read state after writing CRLF content', async () => {
      const file = path.join(rootDir, 'write-crlf-state.txt');
      expect(
        (
          await tool
            .build({ file_path: file, content: 'first\r\nsecond\r\n' })
            .execute(signal)
        ).error,
      ).toBeUndefined();
      const previous = fileReadState.get(file)!;
      fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
      expect(() =>
        tool.build({ file_path: file, content: 'replacement' }),
      ).not.toThrow();
    });

    it('does not treat an unchanged partial Read as a complete file', async () => {
      const file = path.join(rootDir, 'partial-read.txt');
      fs.writeFileSync(file, 'first\nsecond\nthird');
      await new ReadFileTool(mockConfig)
        .build({ file_path: file, limit: 1 })
        .execute(signal);
      const previous = fileReadState.get(file)!;
      fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
      const result = await tool
        .build({ file_path: file, content: 'replacement' })
        .execute(signal);
      expect(result.error).toBeDefined();
      expect(fs.readFileSync(file, 'utf8')).toBe('first\nsecond\nthird');
    });

    it('fails closed when full-content verification cannot read the file', async () => {
      const file = path.join(rootDir, 'verification-error.txt');
      fs.writeFileSync(file, 'original');
      seedFileStateCache(file, 'original');
      const previous = fileReadState.get(file)!;
      fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
      const spy = vi
        .spyOn(fileWriteUtils, 'readFileWithMetadata')
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('read denied'), { code: 'EACCES' });
        });
      try {
        const result = await tool
          .build({ file_path: file, content: 'replacement' })
          .execute(signal);
        expect(result.error?.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(file, 'utf8')).toBe('original');
    });

    it.each([false, true])(
      'preserves a file changed during history work (initially missing=%s)',
      async (missing) => {
        const file = path.join(rootDir, 'history-change.txt');
        if (!missing) {
          fs.writeFileSync(file, 'original');
          seedFileStateCache(file, 'original');
        }
        const timestamp = fileReadState.get(file)?.timestamp ?? Date.now();
        const invocation = tool.build({
          file_path: file,
          content: 'model content',
        });
        const result = await invocation.executeWithContext!({
          signal,
          messageId: 'history',
          fileHistory: {
            trackEdit: async () => {
              fs.writeFileSync(file, 'external content');
              fs.utimesSync(file, new Date(), new Date(timestamp + 2000));
            },
          },
        } as unknown as ToolUseContext);
        expect(result.error?.type).toBe(
          missing
            ? ToolErrorType.FILE_WRITE_FAILURE
            : ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
        );
        expect(fs.readFileSync(file, 'utf8')).toBe('external content');
      },
    );

    it('allows an mtime-only change during history work after a full Read', async () => {
      const file = path.join(rootDir, 'history-touch.txt');
      fs.writeFileSync(file, 'original');
      await new ReadFileTool(mockConfig)
        .build({ file_path: file })
        .execute(signal);
      const previous = fileReadState.get(file)!;
      const result = await tool.build({
        file_path: file,
        content: 'model content',
      }).executeWithContext!({
        signal,
        messageId: 'history',
        fileHistory: {
          trackEdit: async () => {
            fs.utimesSync(
              file,
              new Date(),
              new Date(previous.timestamp + 2000),
            );
          },
        },
      } as unknown as ToolUseContext);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toBe('model content');
    });
  });

  describe('second staleness check in execute', () => {
    const abortSignal = new AbortController().signal;

    it('should reject write when file was modified between validation and execution', async () => {
      const filePath = path.join(rootDir, 'staleness_race.txt');
      const originalContent = 'original content';
      fs.writeFileSync(filePath, originalContent, 'utf8');
      seedFileStateCache(filePath, originalContent);

      const params = { file_path: filePath, content: 'new content' };
      const invocation = tool.build(params);

      // Simulate external modification after validation but before execute:
      // Update the file on disk so its mtime is newer than the cached timestamp.
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.writeFileSync(filePath, 'externally modified content', 'utf8');

      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe(ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED);
      expect(result.llmContent).toBe(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
    });

    it('should allow write when file content matches despite newer mtime (full read fallback)', async () => {
      const filePath = path.join(rootDir, 'staleness_content_match.txt');
      const content = 'same content';
      fs.writeFileSync(filePath, content, 'utf8');
      seedFileStateCache(filePath, content);

      const params = { file_path: filePath, content: 'updated content' };
      // Build while cache is fresh (validation passes)
      const invocation = tool.build(params);

      // Now simulate: between validation and execute, the file was "touched"
      // but content is unchanged. Update mtime to be newer than cached timestamp.
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.writeFileSync(filePath, content, 'utf8');

      const result = await invocation.execute(abortSignal);

      // Second staleness check compares content for full reads; content matches,
      // so the write should succeed.
      expect(result.llmContent).toContain('has been updated successfully.');
      expect(result.error).toBeUndefined();
    });
  });

  describe('encoding and line ending preservation', () => {
    const abortSignal = new AbortController().signal;

    it('should preserve CRLF line endings for existing files', async () => {
      const filePath = path.join(rootDir, 'crlf_file.txt');
      // Write a file with CRLF endings directly (raw bytes)
      fs.writeFileSync(filePath, 'line1\r\nline2\r\nline3\r\n', 'utf8');
      seedFileStateCache(filePath, 'line1\nline2\nline3\n'); // LF-normalized in cache

      const params = {
        file_path: filePath,
        content: 'new line1\nnew line2\nnew line3\n',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      // Read back raw bytes to verify CRLF was preserved
      const rawContent = fs.readFileSync(filePath, 'utf8');
      expect(rawContent).toBe('new line1\r\nnew line2\r\nnew line3\r\n');
    });

    it('should use LF line endings for new files', async () => {
      const filePath = path.join(rootDir, 'new_lf_file.txt');
      const params = {
        file_path: filePath,
        content: 'line1\nline2\nline3\n',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      const rawContent = fs.readFileSync(filePath, 'utf8');
      expect(rawContent).toBe('line1\nline2\nline3\n');
      // No CRLF should be introduced
      expect(rawContent).not.toContain('\r\n');
    });
  });

  describe('plan mode memory writes', () => {
    const abortSignal = new AbortController().signal;

    it('allows memory writes and bypasses the plan-file redirect', async () => {
      vi.mocked(mockConfig.isPlanMode).mockReturnValue(true);

      const memoryFilePath = path.join(memoryDir, 'preference.md');
      const planFilePath = path.join(plansDir, 'preference.md');
      fs.writeFileSync(memoryFilePath, 'old memory', 'utf8');
      fs.writeFileSync(planFilePath, 'draft plan', 'utf8');
      seedFileStateCache(memoryFilePath, 'old memory');

      const params = {
        file_path: memoryFilePath,
        content: 'new memory',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(memoryFilePath, 'utf8')).toBe('new memory');
      expect(fs.readFileSync(planFilePath, 'utf8')).toBe('draft plan');
    });
  });

  describe('atomic write and symlink handling', () => {
    const abortSignal = new AbortController().signal;

    it('should write through symlink to target file', async () => {
      const targetPath = path.join(rootDir, 'symlink_target.txt');
      const linkPath = path.join(rootDir, 'symlink_link.txt');
      const content = 'content via symlink';

      fs.writeFileSync(targetPath, 'original target content', 'utf8');
      fs.symlinkSync(targetPath, linkPath);
      seedFileStateCache(linkPath, 'original target content');

      const params = { file_path: linkPath, content };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      // Target file should have the new content
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(content);
      // Symlink should still exist
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    });

    it('should preserve file permissions after atomic write', async () => {
      const filePath = path.join(rootDir, 'perms_file.txt');
      fs.writeFileSync(filePath, 'original', 'utf8');
      fs.chmodSync(filePath, 0o755);
      seedFileStateCache(filePath, 'original');

      const params = { file_path: filePath, content: 'updated' };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      const stats = fs.statSync(filePath);
      // Check that execute permission is preserved (0o755 & 0o111 = 0o111)
      expect(stats.mode & 0o111).toBe(0o111);
    });
  });
});
