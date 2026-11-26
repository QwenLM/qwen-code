/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createToolFileStateCache } from '../utils/fileStateCache.js';
const fileReadState = createToolFileStateCache();
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { detectLineEnding } from '../utils/textUtils.js';
import { WriteFileTool } from './write-file.js';
import { EditTool } from './edit.js';
import type { Config } from '../config/config.js';

import type { ToolRegistry } from './tool-registry.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';

const rootDir = path.resolve(os.tmpdir(), 'gemini-cli-line-ending-test-root');

// --- MOCKS ---
vi.mock('./jit-context.js', () => ({
  activateConditionalSkillsForPath: vi.fn(),
  discoverJitContext: vi.fn().mockResolvedValue(undefined),
}));

// Mock Config
const fsService = new StandardFileSystemService();
const mockConfigInternal = {
  fileReadState,
  getTargetDir: () => rootDir,
  getPermissionMode: vi.fn(() => 'default'),
  setPermissionMode: vi.fn(),
  getFileSystemService: () => fsService,
  getWorkspaceContext: () => new WorkspaceContext(rootDir),
  getApiKey: () => 'test-key',
  getModel: () => 'test-model',
  getDebugMode: () => false,
  getQuestion: () => undefined,
  getMcpServerCommand: () => undefined,
  getMcpServers: () => undefined,
  getUserAgent: () => 'test-agent',
  getUserMemory: () => '',
  getMemoryMdFileCount: () => 0,
  getActiveModel: () => 'test-model',
  validatePathAccess: vi.fn().mockReturnValue(null),
  validateSettingsContent: vi.fn(() => null),
  getToolRegistry: () =>
    ({
      registerTool: vi.fn(),
      discoverTools: vi.fn(),
    }) as unknown as ToolRegistry,
  isInteractive: () => false,
  isAutoMemoryUserScopeEnabled: () => false,
  isAutoMemoryProjectScopeEnabled: () => false,
  isPlanMode: () => false,
  getHookSystem: () => undefined,
  storage: {
    getPlansDir: () => '/tmp/plans',
    getProjectMemoryTempDir: () => path.join(rootDir, 'memory'),
  },
};
const mockConfig = mockConfigInternal as unknown as Config;

// --- END MOCKS ---

function seedFileStateCache(filePath: string, content: string): void {
  const fileStat = fs.statSync(filePath);
  fileReadState.set(filePath, {
    content,
    timestamp: Math.floor(fileStat.mtimeMs),
    offset: undefined,
    limit: undefined,
  });
}

describe('Line Ending Preservation', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'line-ending-test-external-'),
    );
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }

    fileReadState.clear();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('detectLineEnding', () => {
    it('should detect CRLF', () => {
      expect(detectLineEnding('line1\r\nline2')).toBe('\r\n');
      expect(detectLineEnding('line1\r\n')).toBe('\r\n');
    });

    it('should detect LF', () => {
      expect(detectLineEnding('line1\nline2')).toBe('\n');
      expect(detectLineEnding('line1\n')).toBe('\n');
      expect(detectLineEnding('line1')).toBe('\n'); // Default to LF if no newline
    });
  });

  describe('WriteFileTool', () => {
    let tool: WriteFileTool;
    const abortSignal = new AbortController().signal;

    beforeEach(() => {
      tool = new WriteFileTool(mockConfig);
    });

    it('should preserve CRLF when overwriting an existing file', async () => {
      const filePath = path.join(rootDir, 'crlf_file.txt');
      const originalContent = 'line1\r\nline2\r\n';
      fs.writeFileSync(filePath, originalContent); // Write with CRLF (or however Node writes binary buffer)
      // Ensure strictly CRLF
      fs.writeFileSync(filePath, Buffer.from('line1\r\nline2\r\n'));
      seedFileStateCache(filePath, originalContent);

      // Proposed content from LLM (usually LF)
      const proposedContent = 'line1\nline2\nline3\n';

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);

      await invocation.execute(abortSignal);

      const writtenContent = fs.readFileSync(filePath, 'utf8');
      // Expect all newlines to be CRLF
      expect(writtenContent).toBe('line1\r\nline2\r\nline3\r\n');
    });

    it('should use OS EOL for new files', async () => {
      const filePath = path.join(rootDir, 'new_os_eol_file.txt');
      const proposedContent = 'line1\nline2\n';

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);

      await invocation.execute(abortSignal);

      const writtenContent = fs.readFileSync(filePath, 'utf8');

      if (os.EOL === '\r\n') {
        expect(writtenContent).toBe('line1\r\nline2\r\n');
      } else {
        expect(writtenContent).toBe('line1\nline2\n');
      }
    });
  });

  describe('EditTool', () => {
    let tool: EditTool;
    const abortSignal = new AbortController().signal;

    beforeEach(() => {
      tool = new EditTool(mockConfig);
    });

    it('should preserve CRLF when editing a file', async () => {
      const filePath = path.join(rootDir, 'edit_crlf.txt');
      const originalContent = 'line1\r\nline2\r\nline3\r\n';
      fs.writeFileSync(filePath, Buffer.from(originalContent));
      seedFileStateCache(filePath, originalContent);

      const oldString = 'line2';
      const newString = 'modified';

      const params = {
        file_path: filePath,
        old_string: oldString,
        new_string: newString,
      };
      const invocation = tool.build(params);

      await invocation.execute(abortSignal);

      const writtenContent = fs.readFileSync(filePath, 'utf8');

      expect(writtenContent).toBe('line1\r\nmodified\r\nline3\r\n');
    });
  });
});
