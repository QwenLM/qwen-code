/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { constrainAgentPermissions } from '../permissions/agent-tool-constraints.js';
import { WriteFileTool } from './write-file.js';
import { recordShellFileReads } from './shell.js';
import {
  createPermissionManager,
  emptyPermissionRules,
} from '../test-utils/config.js';
import { PermissionModes } from '../permissions/manager/decision/index.js';
import type { ToolUseContext } from './tool-types.js';
import {
  createToolFileStateCache,
  getFileStateResult,
} from '../utils/fileStateCache.js';
const fileReadState = createToolFileStateCache();
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EditTool,
  type EditToolParams,
  applyReplacement,
  calculateReplacement,
} from './edit.js';
import { type FileDiff } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import path from 'node:path';
import { isSubpath } from '../utils/paths.js';
import fs from 'node:fs';
import os from 'node:os';
import type { Config } from '../config/config.js';
import {
  initializeShellSession,
  runWithShellSession,
  runWithCwdOverride,
  setCwd,
} from '../utils/Shell.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { setTestSessionPermission } from '../test-utils/config.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { ReadFileTool } from './read-file.js';
import { notTextWriteRefusal } from '../utils/fileWriteUtils.js';
import type { PermissionRules } from '../permissions/manager/decision/index.js';

vi.mock('./jit-context.js', () => ({
  activateConditionalSkillsForPath: vi.fn(),
  discoverJitContext: vi.fn().mockResolvedValue(undefined),
}));

function seedFileStateCache(filePath: string, content: string): void {
  const fileStat = fs.statSync(filePath);
  fileReadState.set(filePath, {
    content,
    timestamp: Math.floor(fileStat.mtimeMs),
    offset: undefined,
    limit: undefined,
  });
}

describe('EditTool', () => {
  let tool: EditTool;
  let tempDir: string;
  let rootDir: string;
  let memoryDir: string;
  let mockConfig: Config;
  let fileSystemService: StandardFileSystemService;

  beforeEach(() => {
    vi.restoreAllMocks();
    fileReadState.clear();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-test-'));
    rootDir = path.join(tempDir, 'root');
    memoryDir = path.join(tempDir, '.qwen', 'projects', 'test', 'memory');
    fs.mkdirSync(rootDir);
    fs.mkdirSync(memoryDir, { recursive: true });

    fileSystemService = new StandardFileSystemService();

    mockConfig = {
      fileReadState,
      getTargetDir: () => rootDir,
      getPermissionMode: vi.fn(() => 'default'),
      setPermissionMode: vi.fn(),
      getWorkspaceContext: () => createMockWorkspaceContext(rootDir),
      getFileSystemService: () => fileSystemService,
      getApiKey: () => 'test-api-key',
      getModel: () => 'test-model',
      getDebugMode: () => false,
      getQuestion: () => undefined,
              getMcpServerCommand: () => undefined,
      getMcpServers: () => undefined,
      getUserAgent: () => 'test-agent',
      getUserMemory: () => '',
      getMemoryMdFileCount: () => 0,
      getToolRegistry: () => ({}) as any,
      isInteractive: () => false,
      getHookSystem: () => undefined,
      isPlanMode: vi.fn(() => false),
      isAutoMemoryUserScopeEnabled: vi.fn(() => false),
      isAutoMemoryEnabled: vi.fn(() => false),
      validateSettingsContent: vi.fn(() => null),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
        getPlansDir: vi.fn().mockReturnValue('/tmp/plans'),
        getProjectMemoryTempDir: vi.fn().mockReturnValue(memoryDir),
      },
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

    initializeShellSession(mockConfig, rootDir);
    tool = new EditTool(mockConfig);
  });

  it('edits the file under the effective cwd after cd without touching its root namesake', async () => {
    const child = path.join(fs.realpathSync(rootDir), 'sub');
    fs.mkdirSync(child);
    const childFile = path.join(child, 'same.txt');
    const rootFile = path.join(rootDir, 'same.txt');
    fs.writeFileSync(childFile, 'old child');
    fs.writeFileSync(rootFile, 'old root');
    runWithShellSession(mockConfig, () => setCwd(child));
    const read = await new ReadFileTool(mockConfig)
      .build({ file_path: 'same.txt' })
      .execute(new AbortController().signal);
    expect(read.error).toBeUndefined();
    const invocation = tool.build({
      file_path: 'same.txt',
      old_string: 'old child',
      new_string: 'new child',
    });
    expect(invocation.toolLocations()[0].path).toBe(childFile);
    runWithShellSession(mockConfig, () => setCwd(rootDir));
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(childFile, 'utf8')).toBe('new child');
    expect(fs.readFileSync(rootFile, 'utf8')).toBe('old root');
  });

  it('resolves edits against an isolated agent cwd', () => {
    const child = path.join(rootDir, 'agent');
    const params = { file_path: 'new.txt', old_string: '', new_string: 'new' };
    const invocation = runWithCwdOverride(child, () =>
      tool.build({ ...params }),
    );
    expect(invocation.toolLocations()[0].path).toBe(
      path.join(child, 'new.txt'),
    );
    expect(tool.build(params).toolLocations()[0].path).toBe(
      path.join(rootDir, 'new.txt'),
    );
  });

  function recoveryContext(
    rules = emptyPermissionRules(),
    modelKey = 'model-a',
  ): ToolUseContext {
    const permission = createPermissionManager({
      cwd: rootDir,
      rules,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    return {
      signal: new AbortController().signal,
      fileReadState,
      modelKey,
      agentLoopContext: Object.assign(Object.create(mockConfig), {
        permission,
        toolRegistry: { getTool: () => ({}) },
      }),
    };
  }
  it.each([false, true])(
    'keeps valid reads with a custom checker while enforcing explicit deny (%s)',
    async (denied) => {
      const file = path.join(rootDir, 'custom-check.txt');
      fs.writeFileSync(file, 'old');
      seedFileStateCache(file, 'old');
      const ctx = recoveryContext({
        allow: {},
        ask: {},
        deny: denied ? { userSettings: ['Read'] } : {},
      });
      const check = vi.fn(() => ({ kind: 'allow' as const }));
      Object.defineProperty(ctx.agentLoopContext, 'checkPermissionOptions', {
        value: () => ({ toolCheckerMap: new Map([['Read', { check }]]) }),
      });
      const result = await tool.build({
        file_path: file,
        old_string: 'old',
        new_string: 'new',
      }).executeWithContext!(ctx);
      expect(Boolean(result.error)).toBe(denied);
      expect(fs.readFileSync(file, 'utf8')).toBe(denied ? 'old' : 'new');
      expect(check).not.toHaveBeenCalled();
    },
  );

  it.each(['model-a', 'arbitrary-vendor-model'])(
    'recovers an unread exact edit for %s without claiming the entire file was seen',
    async (model) => {
      const file = path.join(rootDir, 'recover.txt');
      fs.writeFileSync(file, 'old\nuntouched');
      const result = await tool.build({
        file_path: file,
        old_string: 'old',
        new_string: 'new',
      }).executeWithContext!(recoveryContext(undefined, model));
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toBe('new\nuntouched');
      expect(fileReadState.get(file)?.contentNotInModelContext).toBe(true);
    },
  );
  it('recalculates after history preparation and preserves unrelated external changes', async () => {
    const file = path.join(rootDir, 'race.txt');
    fs.writeFileSync(file, 'old\noriginal');
    seedFileStateCache(file, 'old\noriginal');
    const ctx: ToolUseContext = {
      ...recoveryContext(),
      messageId: 'message',
      fileHistory: {
        trackEdit: async () => {
          fs.writeFileSync(file, 'old\nexternal');
          fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
        },
      } as any,
    };
    const result = await tool.build({
      file_path: file,
      old_string: 'old',
      new_string: 'new',
    }).executeWithContext!(ctx);
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('new\nexternal');
    expect(fileReadState.get(file)?.contentNotInModelContext).toBe(true);
  });
  it.each(['missing', 'ambiguous'])(
    'does not recover a %s replacement',
    async (kind) => {
      const file = path.join(rootDir, 'no-recovery.txt');
      const text = kind === 'missing' ? 'other' : 'old old';
      fs.writeFileSync(file, text);
      const result = await tool.build({
        file_path: file,
        old_string: 'old',
        new_string: 'new',
      }).executeWithContext!(recoveryContext());
      expect(result.error).toBeDefined();
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    },
  );
  it('honors new Read deny on a valid baseline and preserves explicit ask even in Yolo', async () => {
    const file = path.join(rootDir, 'denied.txt');
    fs.writeFileSync(file, 'old');
    seedFileStateCache(file, 'old');
    const deny = recoveryContext({
      allow: {},
      deny: { userSettings: ['Read'] },
      ask: {},
    });
    expect(
      (
        await tool.build({
          file_path: file,
          old_string: 'old',
          new_string: 'new',
        }).executeWithContext!(deny)
      ).error,
    ).toBeDefined();
    const ask = recoveryContext({
      allow: {},
      deny: {},
      ask: { userSettings: ['Read'] },
    });
    ask.agentLoopContext!.permission!.setPermissionMode(PermissionModes.Yolo);
    fileReadState.clear();
    expect(
      (
        await tool.build({
          file_path: file,
          old_string: 'old',
          new_string: 'new',
        }).executeWithContext!(ask)
      ).error,
    ).toBeDefined();
    seedFileStateCache(file, 'old');
    expect(
      (
        await tool.build({
          file_path: file,
          old_string: 'old',
          new_string: 'new',
        }).executeWithContext!(ask)
      ).error,
    ).toBeUndefined();
  });
  it('does not internally recover without the actual Read tool but accepts a valid record', async () => {
    const file = path.join(rootDir, 'no-read.txt');
    fs.writeFileSync(file, 'old');
    const ctx = recoveryContext();
    vi.spyOn(ctx.agentLoopContext!.toolRegistry, 'getTool').mockReturnValue(
      undefined,
    );
    expect(
      (
        await tool.build({
          file_path: file,
          old_string: 'old',
          new_string: 'new',
        }).executeWithContext!(ctx)
      ).error,
    ).toBeDefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    seedFileStateCache(file, 'old');
    expect(
      (
        await tool.build({
          file_path: file,
          old_string: 'old',
          new_string: 'new',
        }).executeWithContext!(ctx)
      ).error,
    ).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });
  it.each([
    ['你好', String.raw`\u4f60\u597d`, String.raw`\u4f60\u4eec`, '你们'],
    [String.raw`\u4F60\u597D`, '你好', '你们', String.raw`\u4F60\u4EEC`],
  ])(
    'matches Unicode representations and preserves disk style',
    async (disk, old_string, new_string, expected) => {
      const file = path.join(rootDir, 'unicode.txt');
      fs.writeFileSync(file, disk);
      seedFileStateCache(file, disk);
      const result = await tool
        .build({ file_path: file, old_string, new_string })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toBe(expected);
    },
  );

  afterEach(() => {
    fileReadState.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('staleness after a real Read', () => {
    it.each(['Edit', 'Write'])(
      'preserves a concurrent change during %s temporary-file preparation',
      async (name) => {
        const file = path.join(rootDir, 'late-write.txt');
        fs.writeFileSync(file, 'hello world');
        seedFileStateCache(file, 'hello world');
        const stat = fs.promises.stat;
        let changed = false;
        const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
          ...args: Parameters<typeof stat>
        ) => {
          const result = await stat(...args);
          if (
            !changed &&
            fs.realpathSync(String(args[0])) === fs.realpathSync(file)
          ) {
            changed = true;
            fs.writeFileSync(file, 'external concurrent change');
          }
          return result;
        }) as typeof stat);
        try {
          const invocation =
            name === 'Edit'
              ? tool.build({
                  file_path: file,
                  old_string: 'hello',
                  new_string: 'goodbye',
                })
              : new WriteFileTool(mockConfig).build({
                  file_path: file,
                  content: 'replacement',
                });
          const result = await invocation.execute(new AbortController().signal);
          expect(changed).toBe(true);
          expect(result.error?.type).toBe(
            ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
          );
          expect(fs.readFileSync(file, 'utf8')).toBe(
            'external concurrent change',
          );
        } finally {
          spy.mockRestore();
        }
      },
    );

    it('accepts unchanged BOM content after Read and preserves BOM on Edit', async () => {
      const filePath = path.join(rootDir, 'bom-edit.txt');
      fs.writeFileSync(filePath, '\uFEFFhello world\r\nsecond line');
      const signal = new AbortController().signal;
      await new ReadFileTool(mockConfig)
        .build({ file_path: filePath })
        .execute(signal);
      const timestamp = fileReadState.get(filePath)!.timestamp;
      fs.utimesSync(filePath, new Date(), new Date(timestamp + 2000));
      const result = await tool
        .build({
          file_path: filePath,
          old_string: 'hello',
          new_string: 'goodbye',
        })
        .execute(signal);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        '\uFEFFgoodbye world\r\nsecond line',
      );
      expect(fileReadState.get(filePath)?.content).toBe(
        'goodbye world\nsecond line',
      );
    });

    it.each([undefined, 0, 1])(
      'allows unchanged content after mtime advances (offset=%s)',
      async (offset) => {
        const filePath = path.join(rootDir, 'read-then-edit.txt');
        fs.writeFileSync(filePath, 'hello world\nsecond line');
        const read = await new ReadFileTool(mockConfig)
          .build({
            file_path: filePath,
            ...(offset === undefined ? {} : { offset }),
          })
          .execute(new AbortController().signal);
        expect(read.error).toBeUndefined();
        const timestamp = fileReadState.get(filePath)!.timestamp;
        fs.utimesSync(filePath, new Date(), new Date(timestamp + 2000));

        const result = await tool
          .build({
            file_path: filePath,
            old_string: 'hello',
            new_string: 'goodbye',
          })
          .execute(new AbortController().signal);
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(filePath, 'utf8')).toBe(
          'goodbye world\nsecond line',
        );
      },
    );

    it.each([
      { range: {}, content: 'hello world\nchanged externally' },
      { range: { limit: 1 }, content: 'hello world\nsecond line' },
      { range: { offset: 2 }, content: 'hello world\nsecond line' },
    ])(
      'still rejects stale or partial reads: %j',
      async ({ range, content }) => {
        const filePath = path.join(rootDir, 'read-then-edit.txt');
        fs.writeFileSync(filePath, 'hello world\nsecond line');
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: filePath, ...range })
          .execute(new AbortController().signal);
        expect(read.error).toBeUndefined();
        const timestamp = fileReadState.get(filePath)!.timestamp;
        fs.writeFileSync(filePath, content);
        fs.utimesSync(filePath, new Date(), new Date(timestamp + 2000));

        const result = await tool
          .build({
            file_path: filePath,
            old_string: 'world',
            new_string: 'moon',
          })
          .execute(new AbortController().signal);
        expect(result.error?.type).toBe(
          ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
        );
        expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
      },
    );
  });

  describe('BOM preservation', () => {
    it('keeps the memory scope guard when preserving an existing BOM', async () => {
      const filePath = path.join(memoryDir, 'pinned.md');
      const original = '\uFEFF---\nname: pinned\ntype: project\n---\nproject fact\n';
      fs.writeFileSync(filePath, original);
      seedFileStateCache(filePath, original);
      const result = await tool.build({
        file_path: filePath,
        old_string: original,
        new_string: '---\nname: pinned\ntype: user\n---\nuser fact\n',
      }).execute(new AbortController().signal);
      expect(result.error).toBeDefined();
      expect(result.llmContent).toContain('must be saved in the user-scope');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
    });

    it.each(['utf8', 'utf16le'] as const)(
      'reads and preserves %s BOM through Write and Edit',
      async (encoding) => {
        const filePath = path.join(rootDir, 'bom-preserved.cs');
        const signal = new AbortController().signal;
        fs.writeFileSync(filePath, '\uFEFF刷新时间\r\nfooter\r\n', encoding);
        const read = await new ReadFileTool(mockConfig)
          .build({ file_path: filePath }).execute(signal);
        expect(read.error).toBeUndefined();
        expect(read.llmContent).toContain('刷新时间');
        expect(read.llmContent).not.toContain('\uFFFD');

        const writeTool = new WriteFileTool(mockConfig);
        for (const content of ['开始时间\nfooter\n', '\uFEFF再次开始\nfooter\n']) {
          const written = await writeTool.build({ file_path: filePath, content }).execute(signal);
          expect(written.error).toBeUndefined();
          const expected = content.startsWith('\uFEFF') ? content : `\uFEFF${content}`;
          expect(fs.readFileSync(filePath)).toEqual(Buffer.from(expected.replaceAll('\n', '\r\n'), encoding));
          expect(written.fileWrite?.writtenContent).toBe(expected);
        }

        const edited = await tool.build({
          file_path: filePath,
          old_string: '\uFEFF再次开始',
          new_string: '修改时间',
        }).execute(signal);
        expect(edited.error).toBeUndefined();
        expect(fs.readFileSync(filePath)).toEqual(Buffer.from('\uFEFF修改时间\r\nfooter\r\n', encoding));
        expect(edited.fileWrite?.writtenContent).toBe('\uFEFF修改时间\nfooter\n');

        const reread = await new ReadFileTool(mockConfig)
          .build({ file_path: filePath }).execute(signal);
        expect(reread.error).toBeUndefined();
        expect(reread.llmContent).toContain('修改时间');
        expect(reread.llmContent).not.toContain('Edit and Write will refuse it');
      },
    );

    it.each(['utf8', 'utf16le'] as const)(
      'preserves a BOM-only %s file on an empty-old-string Edit',
      async (encoding) => {
        const filePath = path.join(rootDir, 'bom-only.cs');
        fs.writeFileSync(filePath, '\uFEFF', encoding);
        const result = await tool.build({
          file_path: filePath,
          old_string: '',
          new_string: '刷新时间',
        }).execute(new AbortController().signal);
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(filePath)).toEqual(Buffer.from('\uFEFF刷新时间', encoding));
      },
    );
  });

  describe('non-UTF-8 files', () => {
    // '// 刷新时间' followed by an ASCII line, encoded as GBK (CP936).
    const gbk = Buffer.concat([
      Buffer.from('// '),
      Buffer.from([0xcb, 0xa2, 0xd0, 0xc2, 0xca, 0xb1, 0xbc, 0xe4]),
      Buffer.from('\r\nhello world\r\n'),
    ]);

    it('Read flags the file and Edit/Write refuse without touching its bytes', async () => {
      const filePath = path.join(rootDir, 'legacy.cs');
      fs.writeFileSync(filePath, gbk);
      const signal = new AbortController().signal;

      const read = await new ReadFileTool(mockConfig)
        .build({ file_path: filePath })
        .execute(signal);
      expect(read.error).toBeUndefined();
      expect(read.llmContent).toContain('\uFFFD');
      expect(read.llmContent).toContain(
        '[This file is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary. Its undecodable bytes show above as U+FFFD.',
      );

      const edit = tool.build({
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
      });
      const validation = await edit.validateBeforePermission!({
        signal,
        fileReadState,
      });
      expect(validation?.error?.type).toBe(ToolErrorType.FILE_NOT_TEXT);
      const edited = await edit.execute(signal);
      expect(edited.error?.type).toBe(ToolErrorType.FILE_NOT_TEXT);
      expect(edited.llmContent).toContain('so nothing was written');

      const written = await new WriteFileTool(mockConfig)
        .build({ file_path: filePath, content: 'replacement' })
        .execute(signal);
      expect(written.error?.type).toBe(ToolErrorType.FILE_NOT_TEXT);
      expect(written.llmContent).toContain('so nothing was written');

      expect(fs.readFileSync(filePath)).toEqual(gbk);
    });

    it.each(['Edit', 'Write'])(
      '%s refuses when the file turns non-UTF-8 just before the write',
      async (name) => {
        const filePath = path.join(rootDir, 'turns-legacy.cs');
        fs.writeFileSync(filePath, 'hello world');
        seedFileStateCache(filePath, 'hello world');
        const stat = fs.promises.stat;
        let changed = false;
        const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
          ...args: Parameters<typeof stat>
        ) => {
          const result = await stat(...args);
          if (
            !changed &&
            fs.realpathSync(String(args[0])) === fs.realpathSync(filePath)
          ) {
            changed = true;
            fs.writeFileSync(filePath, gbk);
          }
          return result;
        }) as typeof stat);
        try {
          const invocation =
            name === 'Edit'
              ? tool.build({
                  file_path: filePath,
                  old_string: 'hello',
                  new_string: 'goodbye',
                })
              : new WriteFileTool(mockConfig).build({
                  file_path: filePath,
                  content: 'replacement',
                });
          const result = await invocation.execute(new AbortController().signal);
          expect(changed).toBe(true);
          expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_TEXT);
          expect(result.llmContent).toBe(notTextWriteRefusal('not_utf8'));
          expect(fs.readFileSync(filePath)).toEqual(gbk);
        } finally {
          spy.mockRestore();
        }
      },
    );
  });

  describe('conditional unread/stale recovery', () => {
    let filePath: string;
    let rules: PermissionRules;
    let recoveryCtx: ToolUseContext;

    beforeEach(() => {
      filePath = path.join(rootDir, 'recover.txt');
      fs.writeFileSync(filePath, 'hello world\noriginal footer');
      rules = { allow: {}, deny: {}, ask: {} };
      recoveryCtx = recoveryContext(rules);
      setTestSessionPermission(
        mockConfig,
        recoveryCtx.agentLoopContext!.permission,
      );
    });

    async function changeAfterRead(content: string): Promise<void> {
      const read = await new ReadFileTool(mockConfig).build({
        file_path: filePath,
      }).executeWithContext!(recoveryCtx);
      expect(read.error).toBeUndefined();
      const timestamp = fileReadState.get(filePath)!.timestamp;
      fs.writeFileSync(filePath, content);
      fs.utimesSync(filePath, new Date(), new Date(timestamp + 2000));
    }

    async function edit(allow_multiple = false) {
      return tool.build({
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
        allow_multiple,
      }).executeWithContext!(recoveryCtx);
    }

    it('recovers a unique exact edit while preserving unrelated external changes', async () => {
      await changeAfterRead('hello world\nexternal footer');
      expect((await edit()).error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'goodbye world\nexternal footer',
      );
    });

    it('allows an exact edit without a previous Read only when Read is allowed', async () => {
      expect((await edit()).error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'goodbye world\noriginal footer',
      );
    });

    it.each(['deny', 'ask'] as const)(
      'does not bypass a Read %s on a stale file',
      async (behavior) => {
        await changeAfterRead('hello world\nexternal footer');
        rules[behavior] = { session: ['Read'] };
        expect((await edit()).error).toBeDefined();
        expect(fs.readFileSync(filePath, 'utf8')).toBe(
          'hello world\nexternal footer',
        );
      },
    );

    it('does not bypass a path-specific read denial', async () => {
      rules.deny = { session: [`Read(/${filePath})`] };
      expect((await edit()).error).toBeDefined();
    });

    it('rejects ambiguous stale matches for a single replacement', async () => {
      await changeAfterRead('hello world\nhello from another writer');
      expect((await edit()).error).toBeDefined();
    });

    it('recovers all stale matches when allow_multiple is true', async () => {
      await changeAfterRead('hello world\nhello from another writer');
      expect((await edit(true)).error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'goodbye world\ngoodbye from another writer',
      );
    });

    it('rejects a changed target rather than applying a fuzzy stale edit', async () => {
      await changeAfterRead('HELLO world\nexternal footer');
      expect((await edit()).error).toBeDefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'HELLO world\nexternal footer',
      );
    });

    it('fails closed when the permission probe fails', async () => {
      await changeAfterRead('hello world\nexternal footer');
      mockConfig.permission!.getRules = vi.fn(() => {
        throw new Error('permission unavailable');
      });
      expect((await edit()).error).toBeDefined();
    });

    it('does not recover an unread Edit when the active agent forbids Read', async () => {
      const permission = constrainAgentPermissions(mockConfig.permission!, [
        'Read',
      ]);
      const result = await tool.build({
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
      }).executeWithContext!({
        ...recoveryCtx,
        signal: new AbortController().signal,
        agentLoopContext: {
          permission,
          toolRegistry: { getTool: () => ({ name: 'Read' }) },
        },
      } as unknown as ToolUseContext);
      expect(result.error).toBeDefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'hello world\noriginal footer',
      );
    });

    it('preserves a real full Read across a Bash slice and an mtime-only change', async () => {
      fs.writeFileSync(filePath, 'hello\nhello\n');
      await new ReadFileTool(mockConfig).build({ file_path: filePath })
        .executeWithContext!(recoveryCtx);
      const previous = fileReadState.get(filePath)!;
      expect(previous.offset).toBe(1);
      await recordShellFileReads(
        'head -n 1 recover.txt',
        rootDir,
        fileReadState,
        0,
        recoveryCtx.signal,
      );
      expect(fileReadState.get(filePath)).toBe(previous);
      fs.utimesSync(filePath, new Date(), new Date(previous.timestamp + 2000));
      // This must use the existing complete view, without a recovery grant.
      rules.ask = { session: ['Read'] };
      expect((await edit(true)).error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('goodbye\ngoodbye\n');
    });

    it('uses normal quote matching when recovering a stale edit', async () => {
      await changeAfterRead('say “hello”\nexternal footer');
      const result = await tool.build({
        file_path: filePath,
        old_string: '"hello"',
        new_string: '"goodbye"',
      }).executeWithContext!(recoveryCtx);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toContain('external footer');
      expect(fs.readFileSync(filePath, 'utf8')).toContain('goodbye');
    });

    it('serializes same-file edits across asynchronous history work', async () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = tool.build({
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
      }).executeWithContext!({
        ...recoveryCtx,
        signal: new AbortController().signal,
        messageId: 'first',
        fileHistory: {
          trackEdit: async () => {
            entered();
            await blocked;
          },
        },
      } as unknown as ToolUseContext);
      await started;
      const second = tool.build({
        file_path: filePath,
        old_string: 'original footer',
        new_string: 'updated footer',
      }).executeWithContext!(recoveryCtx);
      release();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.error)).toEqual([
        undefined,
        undefined,
      ]);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'goodbye world\nupdated footer',
      );
    });

    it('shares the same path lock between Write and Edit', async () => {
      seedFileStateCache(filePath, fs.readFileSync(filePath, 'utf8'));
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = new WriteFileTool(mockConfig).build({
        file_path: filePath,
        content: 'hello world\nwritten footer',
      }).executeWithContext!({
        ...recoveryCtx,
        signal: new AbortController().signal,
        messageId: 'write',
        fileHistory: {
          trackEdit: async () => {
            entered();
            await blocked;
          },
        },
      } as unknown as ToolUseContext);
      await started;
      const second = edit();
      release();
      expect(
        (await Promise.all([first, second])).map((result) => result.error),
      ).toEqual([undefined, undefined]);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'goodbye world\nwritten footer',
      );
    });

    it('recognizes a complete limited Read for mtime-only changes', async () => {
      await new ReadFileTool(mockConfig).build({
        file_path: filePath,
        offset: 1,
        limit: 100,
      }).executeWithContext!(recoveryCtx);
      const previous = fileReadState.get(filePath)!;
      fs.utimesSync(filePath, new Date(), new Date(previous.timestamp + 2000));
      rules.ask = { session: ['Read'] };
      expect((await edit()).error).toBeUndefined();
    });

    it('rechecks contents after an asynchronous history hook', async () => {
      await changeAfterRead('hello world\nexternal footer');
      const result = await tool.build({
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
      }).executeWithContext!({
        ...recoveryCtx,
        signal: new AbortController().signal,
        messageId: 'recover-message',
        fileHistory: {
          trackEdit: async () => {
            fs.writeFileSync(filePath, 'concurrent content');
          },
        },
      } as unknown as ToolUseContext);
      expect(result.error).toBeDefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('concurrent content');
    });
  });

  describe('applyReplacement', () => {
    it('returns newString for a new file', () => {
      expect(applyReplacement(null, 'old', 'new', true)).toBe('new');
    });

    it('replaces only the first occurrence when editing an existing file', () => {
      expect(applyReplacement('hello old world old', 'old', 'new', false)).toBe(
        'hello new world old',
      );
    });

    it('preserves literal dollar sequences', () => {
      expect(
        applyReplacement('foo bar foo baz', 'foo', "test$'end", false),
      ).toBe("test$'end bar foo baz");
    });
  });

  describe('calculateReplacement', () => {
    const abortSignal = new AbortController().signal;

    it('performs an exact replacement', async () => {
      const result = await calculateReplacement(mockConfig, {
        params: {
          file_path: 'test.txt',
          old_string: 'world',
          new_string: 'moon',
        },
        currentContent: 'hello world',
        abortSignal,
      });

      expect(result.newContent).toBe('hello moon');
      expect(result.occurrences).toBe(1);
      expect(result.finalOldString).toBe('world');
      expect(result.finalNewString).toBe('moon');
    });

    it('normalizes quotes during matching and preserves curly quote style', async () => {
      const result = await calculateReplacement(mockConfig, {
        params: {
          file_path: 'test.txt',
          old_string: '"hello"',
          new_string: '"world"',
        },
        currentContent: 'She said “hello” to him',
        abortSignal,
      });

      expect(result.newContent).toBe('She said “world” to him');
      expect(result.occurrences).toBe(1);
    });

    it('replaces all matches only when allow_multiple is enabled', async () => {
      const result = await calculateReplacement(mockConfig, {
        params: {
          file_path: 'test.txt',
          old_string: 'foo',
          new_string: 'bar',
          allow_multiple: true,
        },
        currentContent: 'foo foo foo',
        abortSignal,
      });

      expect(result.newContent).toBe('bar bar bar');
      expect(result.occurrences).toBe(3);
    });

    it('returns the original content when multiple matches exist but allow_multiple is disabled', async () => {
      const result = await calculateReplacement(mockConfig, {
        params: {
          file_path: 'test.txt',
          old_string: 'foo',
          new_string: 'bar',
        },
        currentContent: 'foo foo',
        abortSignal,
      });

      expect(result.newContent).toBe('foo foo');
      expect(result.occurrences).toBe(2);
    });

    it('returns zero occurrences when no match is found', async () => {
      const result = await calculateReplacement(mockConfig, {
        params: {
          file_path: 'test.txt',
          old_string: 'nomatch',
          new_string: 'moon',
        },
        currentContent: 'hello world',
        abortSignal,
      });

      expect(result.newContent).toBe('hello world');
      expect(result.occurrences).toBe(0);
    });
  });

  describe('validateToolParams', () => {
    it('accepts a valid path', () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'test.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(params)).toBeNull();
    });

    it('does not require instruction', () => {
      expect(() =>
        tool.build({
          file_path: path.join(rootDir, 'test.txt'),
          old_string: 'old',
          new_string: 'new',
        }),
      ).not.toThrow();
    });

    it('rejects identical old_string and new_string', () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'test.txt'),
        old_string: 'same',
        new_string: 'same',
      };
      expect(tool.validateToolParams(params)).toBe(
        'No changes to make: old_string and new_string are exactly the same.',
      );
    });

    it('rejects notebook files', () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'test.ipynb'),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(params)).toBe(
        'File must be a Jupyter notebook (.ipynb file). Use the NotebookEdit tool to edit notebook files.',
      );
    });
  });

  describe('getDescription', () => {
    it('displays workspace-internal path as relative', () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'src', 'app.ts'),
        old_string: 'a',
        new_string: 'b',
      };
      const invocation = (tool as any).createInvocation(params);
      expect(invocation.getDescription()).not.toContain('..');
      expect(invocation.getDescription()).toContain('src');
    });

    it('does not display ../.. for workspace-external paths', () => {
      const externalPath = path.resolve(rootDir, '..', '..', 'external.ts');
      const params: EditToolParams = {
        file_path: externalPath,
        old_string: 'a',
        new_string: 'b',
      };
      const invocation = (tool as any).createInvocation(params);
      const desc = invocation.getDescription();
      expect(desc).not.toMatch(/\.\.[/\\]\.\./);
    });
  });

  describe('execute', () => {
    const testFile = 'execute_me.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('edits an existing file after the file has been read', async () => {
      const initialContent = 'This is some old text.';
      const newContent = 'This is some new text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedFileStateCache(filePath, initialContent);

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toMatch(/Successfully modified file/);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(newContent);
      expect(result.fileWrite).toEqual({
        filePath,
        workspacePath: rootDir,
        originalContent: initialContent,
        proposedContent: newContent,
        writtenContent: newContent,
      });
      const display = result.returnDisplay as FileDiff;
      expect(display.fileDiff).toMatch(initialContent);
      expect(display.fileDiff).toMatch(newContent);
      expect(display.fileName).toBe(testFile);
    });

    it('reconstructs the complete AI proposal separately from user-modified edit content', async () => {
      const initialContent = 'This is old text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedFileStateCache(filePath, initialContent);

      const result = await tool
        .build({
          file_path: filePath,
          old_string: 'old',
          new_string: 'user modified',
          modified_by_user: true,
          ai_proposed_content: 'AI proposed',
        })
        .execute(new AbortController().signal);

      expect(result.fileWrite).toEqual({
        filePath,
        workspacePath: rootDir,
        originalContent: initialContent,
        proposedContent: 'This is AI proposed text.',
        writtenContent: 'This is user modified text.',
      });
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'This is user modified text.',
      );
    });

    it('rejects editing an existing unread file', async () => {
      fs.writeFileSync(filePath, 'Some content.', 'utf8');

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'Some',
        new_string: 'Other',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED);
      expect(result.llmContent).toMatch(/File has not been read yet/);
    });

    it('rejects an unread file during pre-permission validation', async () => {
      fs.writeFileSync(filePath, 'Some content.', 'utf8');
      const invocation = tool.build({
        file_path: filePath,
        old_string: 'Some',
        new_string: 'Other',
      });
      const execute = vi.spyOn(invocation, 'execute');

      const result = await invocation.validateBeforePermission!({
        signal: new AbortController().signal,
        fileReadState,
      });

      expect(result?.error?.type).toBe(
        ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
      );
      expect(result?.llmContent).toMatch(/File has not been read yet/);
      expect(execute).not.toHaveBeenCalled();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('Some content.');
    });

    it('passes pre-permission validation after the file has been read', async () => {
      const initialContent = 'Some content.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedFileStateCache(filePath, initialContent);
      const invocation = tool.build({
        file_path: filePath,
        old_string: 'Some',
        new_string: 'Other',
      });

      const result = await invocation.validateBeforePermission!({
        signal: new AbortController().signal,
        fileReadState,
      });

      expect(result).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(initialContent);
    });

    it('rejects ambiguous matches before permission', async () => {
      fs.writeFileSync(filePath, 'same same');
      seedFileStateCache(filePath, 'same same');
      const result = await tool.build({ file_path: filePath, old_string: 'same', new_string: 'other' })
        .validateBeforePermission!({ signal: new AbortController().signal, fileReadState });
      expect(result?.error?.type).toBe(ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH);
    });

    it.each([false, true])(
      'keeps large edit receipts short while preserving patches (replace all: %s)',
      async (replaceAll) => {
        const original = replaceAll ? 'old\nmiddle\nold\n' : 'old\n';
        const replacement = 'const value = "new-code";\n'.repeat(1000);
        fs.writeFileSync(filePath, original);
        seedFileStateCache(filePath, original);
        const result = await tool
          .build({
            file_path: filePath,
            old_string: 'old',
            new_string: replacement,
            allow_multiple: replaceAll,
          })
          .execute(new AbortController().signal);

        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain(`(${replaceAll ? 2 : 1} replacements)`);
        expect(result.llmContent).toContain('no need to read it back');
        expect(String(result.llmContent).length).toBeLessThan(500);
        expect(result.llmContent).not.toContain('new-code');
        expect((result.returnDisplay as FileDiff).fileDiff).toContain('new-code');
        expect(result.toolUseResult).toMatchObject({
          newString: replacement,
          structuredPatch: expect.any(Array),
          replaceAll,
        });
        expect(fs.readFileSync(filePath, 'utf8')).toBe(
          original.replaceAll('old', replacement),
        );
      },
    );

    it('does not echo new-file content in the model receipt', async () => {
      const content = 'new-file-content\n'.repeat(1000);
      const result = await tool
        .build({
          file_path: filePath,
          old_string: '',
          new_string: content,
        })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Created new file:');
      expect(result.llmContent).toContain('no need to read it back');
      expect(result.llmContent).not.toContain('new-file-content');
      expect(String(result.llmContent).length).toBeLessThan(500);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });

    it('does not borrow a later cache state when building edit feedback', async () => {
      fs.writeFileSync(filePath, 'old');
      seedFileStateCache(filePath, 'old');
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
        old_string: 'old',
        new_string: 'new',
      }).executeWithContext!({ signal: new AbortController().signal });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).not.toContain('no need to read it back');
      expect(getFileStateResult(result)).toBeUndefined();
      expect(fileReadState.get(filePath)).toBe(laterState);
    });

    it('allows another range to be read after editing a partially read file', async () => {
      fs.writeFileSync(filePath, 'old\nunseen footer');
      const ctx = recoveryContext();
      const readTool = new ReadFileTool(mockConfig);
      const initialRead = await readTool.build({
        file_path: filePath,
        limit: 1,
      }).executeWithContext!(ctx);
      expect(initialRead.error).toBeUndefined();
      const result = await tool.build({
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      }).executeWithContext!(ctx);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).not.toContain('no need to read it back');
      expect(fileReadState.get(filePath)?.contentNotInModelContext).toBe(true);
      const nextRead = await readTool.build({
        file_path: filePath,
        offset: 2,
        limit: 1,
      }).executeWithContext!(ctx);
      expect(nextRead.error).toBeUndefined();
      expect(nextRead.llmContent).toContain('unseen footer');
    });

    it.each(['user', 'hook', 'stale', 'partial-read'] as const)(
      'does not claim unseen content is current after %s changes',
      async (source) => {
        const original = 'old\n';
        fs.writeFileSync(filePath, original);
        seedFileStateCache(filePath, original);
        if (source === 'stale') {
          fileReadState.set(filePath, {
            ...fileReadState.get(filePath)!,
            timestamp: 0,
          });
          fs.writeFileSync(filePath, 'old\nunseen surrounding change\n');
        }
        if (source === 'partial-read') {
          fileReadState.set(filePath, {
            ...fileReadState.get(filePath)!,
            isPartialView: true,
          });
        }
        const result = await tool.build({
          file_path: filePath,
          old_string: 'old',
          new_string: 'new',
          modified_by_user: source === 'user',
        }).executeWithContext!({
          ...recoveryContext(),
          inputModifiedByHook: source === 'hook',
        });
        expect(result.error).toBeUndefined();
        expect(result.llmContent).not.toContain('no need to read it back');
        if (source === 'user') expect(result.llmContent).toContain('user modified');
        if (source === 'hook') expect(result.llmContent).toContain('hook modified');
        if (source === 'stale')
          expect(result.llmContent).toContain('file changed since your last read');
        expect(fileReadState.get(filePath)?.contentNotInModelContext).toBe(true);
      },
    );

    it('preserves CRLF line endings when editing a file', async () => {
      const initialContent = 'line one\r\nline two\r\n';
      const newContent = 'line one\r\nline three\r\n';
      fs.writeFileSync(filePath, Buffer.from(initialContent));
      seedFileStateCache(filePath, initialContent);

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'line two',
        new_string: 'line three',
      };

      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fs.readFileSync(filePath, 'utf8')).toBe(newContent);
    });

    it('creates a new file when old_string is empty', async () => {
      const newContent = 'new line one\r\nnew line two\r\n';
      const params: EditToolParams = {
        file_path: filePath,
        old_string: '',
        new_string: newContent,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(newContent);
    });
  });

  describe('path resolution', () => {
    it.each(['nested directory', 'trusted directory'])(
      'does not redirect a missing relative target to a same-named file in a %s',
      async (location) => {
        const otherDir = path.join(
          location === 'nested directory' ? rootDir : tempDir,
          'other',
        );
        fs.mkdirSync(otherDir);
        const otherFile = path.join(otherDir, 'shared.ts');
        fs.writeFileSync(otherFile, 'old content');
        seedFileStateCache(otherFile, 'old content');
        mockConfig.getWorkspaceContext = () =>
          createMockWorkspaceContext(rootDir, [otherDir]);

        const invocation = tool.build({
          file_path: 'shared.ts',
          old_string: 'old',
          new_string: 'new',
        });
        expect(invocation.toolLocations()).toEqual([
          { path: path.join(rootDir, 'shared.ts') },
        ]);
        const result = await invocation.execute(new AbortController().signal);

        expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
        expect(fs.readFileSync(otherFile, 'utf8')).toBe('old content');
        expect(fs.existsSync(path.join(rootDir, 'shared.ts'))).toBe(false);
      },
    );

    it('edits an explicitly requested relative path after normalization', async () => {
      const nestedDir = path.join(rootDir, 'src');
      fs.mkdirSync(nestedDir);
      const filePath = path.join(nestedDir, 'shared.ts');
      fs.writeFileSync(filePath, 'old content');
      seedFileStateCache(filePath, 'old content');
      const invocation = tool.build({
        file_path: '  ./src/../src/shared.ts  ',
        old_string: 'old',
        new_string: 'new',
      });

      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('new content');
    });

    it('expands home-relative paths without searching workspace directories', () => {
      const invocation = tool.build({
        file_path: '~/shared.ts',
        old_string: 'old',
        new_string: 'new',
      });
      expect(invocation.toolLocations()).toEqual([
        { path: path.join(os.homedir(), 'shared.ts').normalize('NFC') },
      ]);
    });

    it('creates the requested relative file even when a nested file has the same name', async () => {
      const otherDir = path.join(rootDir, 'other');
      fs.mkdirSync(otherDir);
      const otherFile = path.join(otherDir, 'shared.ts');
      fs.writeFileSync(otherFile, 'existing content');
      const invocation = tool.build({
        file_path: 'shared.ts',
        old_string: '',
        new_string: 'new content',
      });

      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(path.join(rootDir, 'shared.ts'), 'utf8')).toBe(
        'new content',
      );
      expect(fs.readFileSync(otherFile, 'utf8')).toBe('existing content');
    });
  });

  describe('error scenarios', () => {
    const testFile = 'error_test.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('returns FILE_NOT_FOUND when editing a missing file', async () => {
      const invocation = tool.build({
        file_path: filePath,
        old_string: 'any',
        new_string: 'new',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    });

    it('returns ATTEMPT_TO_CREATE_EXISTING_FILE when old_string is empty on a non-empty file', async () => {
      fs.writeFileSync(filePath, 'existing content', 'utf8');

      const invocation = tool.build({
        file_path: filePath,
        old_string: '',
        new_string: 'new content',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(
        ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE,
      );
    });

    it('returns EDIT_NO_OCCURRENCE_FOUND when the target text is absent', async () => {
      fs.writeFileSync(filePath, 'content', 'utf8');
      seedFileStateCache(filePath, 'content');

      const invocation = tool.build({
        file_path: filePath,
        old_string: 'not-found',
        new_string: 'new',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_OCCURRENCE_FOUND);
    });

    it('returns EDIT_EXPECTED_OCCURRENCE_MISMATCH when multiple matches exist', async () => {
      fs.writeFileSync(filePath, 'one one two', 'utf8');
      seedFileStateCache(filePath, 'one one two');

      const invocation = tool.build({
        file_path: filePath,
        old_string: 'one',
        new_string: 'new',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(
        ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
      );
    });
  });

  describe('allow_multiple', () => {
    const testFile = 'replacements_test.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it.each([
      {
        name: 'succeeds when allow_multiple is true and there are multiple occurrences',
        content: 'foo foo foo',
        allow_multiple: true,
        shouldSucceed: true,
        finalContent: 'bar bar bar',
      },
      {
        name: 'fails when allow_multiple is false and there are multiple occurrences',
        content: 'foo foo foo',
        allow_multiple: false,
        shouldSucceed: false,
        expectedError: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
      },
      {
        name: 'fails when there are no occurrences',
        content: 'baz',
        allow_multiple: true,
        shouldSucceed: false,
        expectedError: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
      },
    ])(
      'should $name',
      async ({
        content,
        allow_multiple,
        shouldSucceed,
        finalContent,
        expectedError,
      }) => {
        fs.writeFileSync(filePath, content, 'utf8');
        seedFileStateCache(filePath, content);

        const params: EditToolParams = {
          file_path: filePath,
          old_string: 'foo',
          new_string: 'bar',
          allow_multiple,
        };
        const invocation = tool.build(params);
        const result = await invocation.execute(new AbortController().signal);

        if (shouldSucceed) {
          expect(result.error).toBeUndefined();
          expect(fs.readFileSync(filePath, 'utf8')).toBe(finalContent);
        } else {
          expect(result.error?.type).toBe(expectedError);
        }
      },
    );
  });

  describe('JIT context discovery', () => {
    it('does not trigger JIT discovery on a failed edit', async () => {
      const { discoverJitContext } = await import('./jit-context.js');
      vi.mocked(discoverJitContext).mockClear();

      const filePath = path.join(rootDir, 'jit-disabled-edit-test.txt');
      fs.writeFileSync(filePath, 'some old text here', 'utf8');
      seedFileStateCache(filePath, 'some old text here');

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'nonexistent',
        new_string: 'new',
      };

      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(discoverJitContext).not.toHaveBeenCalled();
    });
  });

  describe('plan mode', () => {
    it('allows edits to the plans directory when plan mode is enabled', async () => {
      const mockProjectTempDir = path.join(tempDir, 'project');
      fs.mkdirSync(mockProjectTempDir);
      vi.mocked(mockConfig.storage.getProjectTempDir).mockReturnValue(
        mockProjectTempDir,
      );

      const plansDir = path.join(mockProjectTempDir, 'plans');
      fs.mkdirSync(plansDir);

      vi.mocked(mockConfig.isPlanMode).mockReturnValue(true);
      vi.mocked(mockConfig.storage.getPlansDir).mockReturnValue(plansDir);

      const filePath = path.join(rootDir, 'test-file.txt');
      const planFilePath = path.join(plansDir, 'test-file.txt');
      const initialContent = 'some initial content';
      fs.writeFileSync(planFilePath, initialContent, 'utf8');
      seedFileStateCache(planFilePath, initialContent);

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'initial',
        new_string: 'new',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toMatch(/Successfully modified file/);
      expect(fs.readFileSync(planFilePath, 'utf8')).toBe('some new content');
    });

    it('allows memory edits and bypasses the plan-file redirect', async () => {
      const mockProjectTempDir = path.join(tempDir, 'project');
      fs.mkdirSync(mockProjectTempDir);
      vi.mocked(mockConfig.storage.getProjectTempDir).mockReturnValue(
        mockProjectTempDir,
      );

      const plansDir = path.join(mockProjectTempDir, 'plans');
      fs.mkdirSync(plansDir);

      vi.mocked(mockConfig.isPlanMode).mockReturnValue(true);
      vi.mocked(mockConfig.storage.getPlansDir).mockReturnValue(plansDir);

      const memoryFilePath = path.join(memoryDir, 'preference.md');
      const planFilePath = path.join(plansDir, 'preference.md');
      fs.writeFileSync(memoryFilePath, 'some old memory', 'utf8');
      fs.writeFileSync(planFilePath, 'draft plan', 'utf8');
      seedFileStateCache(memoryFilePath, 'some old memory');

      const params: EditToolParams = {
        file_path: memoryFilePath,
        old_string: 'old',
        new_string: 'new',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toMatch(/Successfully modified file/);
      expect(fs.readFileSync(memoryFilePath, 'utf8')).toBe('some new memory');
      expect(fs.readFileSync(planFilePath, 'utf8')).toBe('draft plan');
    });
  });
});
