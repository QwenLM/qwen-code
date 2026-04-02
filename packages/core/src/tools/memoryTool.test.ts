/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MemoryTool,
  setGeminiMdFilename,
  getCurrentGeminiMdFilename,
  getAllGeminiMdFilenames,
  DEFAULT_CONTEXT_FILENAME,
} from './memoryTool.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';

// Mock dependencies
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn(),
    readFile: vi.fn(),
  };
});

vi.mock('os');

// Mock the memory store module
const mockCreateMemory = vi.hoisted(() => vi.fn());
vi.mock('../memory/memoryStore.js', () => ({
  createMemory: mockCreateMemory,
}));

const MEMORY_SECTION_HEADER = '## Proto Added Memories';

// Define a type for our fsAdapter to ensure consistency
interface FsAdapter {
  readFile: (path: string, encoding: 'utf-8') => Promise<string>;
  writeFile: (path: string, data: string, encoding: 'utf-8') => Promise<void>;
  mkdir: (
    path: string,
    options: { recursive: boolean },
  ) => Promise<string | undefined>;
}

describe('MemoryTool', () => {
  const mockAbortSignal = new AbortController().signal;

  const mockFsAdapter: {
    readFile: Mock<FsAdapter['readFile']>;
    writeFile: Mock<FsAdapter['writeFile']>;
    mkdir: Mock<FsAdapter['mkdir']>;
  } = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(path.join('/mock', 'home'));
    mockFsAdapter.readFile.mockReset();
    mockFsAdapter.writeFile.mockReset().mockResolvedValue(undefined);
    mockFsAdapter.mkdir
      .mockReset()
      .mockResolvedValue(undefined as string | undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset GEMINI_MD_FILENAME to its original value after each test
    setGeminiMdFilename(DEFAULT_CONTEXT_FILENAME);
  });

  describe('setGeminiMdFilename', () => {
    it('should update currentGeminiMdFilename when a valid new name is provided', () => {
      const newName = 'CUSTOM_CONTEXT.md';
      setGeminiMdFilename(newName);
      expect(getCurrentGeminiMdFilename()).toBe(newName);
    });

    it('should not update currentGeminiMdFilename if the new name is empty or whitespace', () => {
      const initialName = getCurrentGeminiMdFilename(); // Get current before trying to change
      setGeminiMdFilename('  ');
      expect(getCurrentGeminiMdFilename()).toBe(initialName);

      setGeminiMdFilename('');
      expect(getCurrentGeminiMdFilename()).toBe(initialName);
    });

    it('should handle an array of filenames', () => {
      const newNames = ['CUSTOM_CONTEXT.md', 'ANOTHER_CONTEXT.md'];
      setGeminiMdFilename(newNames);
      expect(getCurrentGeminiMdFilename()).toBe('CUSTOM_CONTEXT.md');
      expect(getAllGeminiMdFilenames()).toEqual(newNames);
    });
  });

  describe('performAddMemoryEntry (static method)', () => {
    let testFilePath: string;

    beforeEach(() => {
      testFilePath = path.join(os.homedir(), '.qwen', DEFAULT_CONTEXT_FILENAME);
    });

    it('should create section and save a fact if file does not exist', async () => {
      mockFsAdapter.readFile.mockRejectedValue({ code: 'ENOENT' }); // Simulate file not found
      const fact = 'The sky is blue';
      await MemoryTool.performAddMemoryEntry(fact, testFilePath, mockFsAdapter);

      expect(mockFsAdapter.mkdir).toHaveBeenCalledWith(
        path.dirname(testFilePath),
        {
          recursive: true,
        },
      );
      expect(mockFsAdapter.writeFile).toHaveBeenCalledOnce();
      const writeFileCall = mockFsAdapter.writeFile.mock.calls[0];
      expect(writeFileCall[0]).toBe(testFilePath);
      const expectedContent = `${MEMORY_SECTION_HEADER}\n- ${fact}\n`;
      expect(writeFileCall[1]).toBe(expectedContent);
      expect(writeFileCall[2]).toBe('utf-8');
    });

    it('should create section and save a fact if file is empty', async () => {
      mockFsAdapter.readFile.mockResolvedValue(''); // Simulate empty file
      const fact = 'The sky is blue';
      await MemoryTool.performAddMemoryEntry(fact, testFilePath, mockFsAdapter);
      const writeFileCall = mockFsAdapter.writeFile.mock.calls[0];
      const expectedContent = `${MEMORY_SECTION_HEADER}\n- ${fact}\n`;
      expect(writeFileCall[1]).toBe(expectedContent);
    });

    it('should add a fact to an existing section', async () => {
      const initialContent = `Some preamble.\n\n${MEMORY_SECTION_HEADER}\n- Existing fact 1\n`;
      mockFsAdapter.readFile.mockResolvedValue(initialContent);
      const fact = 'New fact 2';
      await MemoryTool.performAddMemoryEntry(fact, testFilePath, mockFsAdapter);

      expect(mockFsAdapter.writeFile).toHaveBeenCalledOnce();
      const writeFileCall = mockFsAdapter.writeFile.mock.calls[0];
      const expectedContent = `Some preamble.\n\n${MEMORY_SECTION_HEADER}\n- Existing fact 1\n- ${fact}\n`;
      expect(writeFileCall[1]).toBe(expectedContent);
    });

    it('should add a fact to an existing empty section', async () => {
      const initialContent = `Some preamble.\n\n${MEMORY_SECTION_HEADER}\n`; // Empty section
      mockFsAdapter.readFile.mockResolvedValue(initialContent);
      const fact = 'First fact in section';
      await MemoryTool.performAddMemoryEntry(fact, testFilePath, mockFsAdapter);

      expect(mockFsAdapter.writeFile).toHaveBeenCalledOnce();
      const writeFileCall = mockFsAdapter.writeFile.mock.calls[0];
      const expectedContent = `Some preamble.\n\n${MEMORY_SECTION_HEADER}\n- ${fact}\n`;
      expect(writeFileCall[1]).toBe(expectedContent);
    });

    it('should add a fact when other ## sections exist and preserve spacing', async () => {
      const initialContent = `${MEMORY_SECTION_HEADER}\n- Fact 1\n\n## Another Section\nSome other text.`;
      mockFsAdapter.readFile.mockResolvedValue(initialContent);
      const fact = 'Fact 2';
      await MemoryTool.performAddMemoryEntry(fact, testFilePath, mockFsAdapter);

      expect(mockFsAdapter.writeFile).toHaveBeenCalledOnce();
      const writeFileCall = mockFsAdapter.writeFile.mock.calls[0];
      // Note: The implementation ensures a single newline at the end if content exists.
      const expectedContent = `${MEMORY_SECTION_HEADER}\n- Fact 1\n- ${fact}\n\n## Another Section\nSome other text.\n`;
      expect(writeFileCall[1]).toBe(expectedContent);
    });

    it('should correctly trim and add a fact that starts with a dash', async () => {
      mockFsAdapter.readFile.mockResolvedValue(`${MEMORY_SECTION_HEADER}\n`);
      const fact = '- - My fact with dashes';
      await MemoryTool.performAddMemoryEntry(fact, testFilePath, mockFsAdapter);
      const writeFileCall = mockFsAdapter.writeFile.mock.calls[0];
      const expectedContent = `${MEMORY_SECTION_HEADER}\n- My fact with dashes\n`;
      expect(writeFileCall[1]).toBe(expectedContent);
    });

    it('should handle error from fsAdapter.writeFile', async () => {
      mockFsAdapter.readFile.mockResolvedValue('');
      mockFsAdapter.writeFile.mockRejectedValue(new Error('Disk full'));
      const fact = 'This will fail';
      await expect(
        MemoryTool.performAddMemoryEntry(fact, testFilePath, mockFsAdapter),
      ).rejects.toThrow('[MemoryTool] Failed to add memory entry: Disk full');
    });
  });

  describe('execute (instance method)', () => {
    let memoryTool: MemoryTool;

    beforeEach(() => {
      memoryTool = new MemoryTool();
      // Setup mock createMemory to return a fake MemoryFile
      mockCreateMemory.mockResolvedValue({
        header: {
          name: 'the sky is blue',
          description: 'The sky is blue',
          type: 'user',
        },
        content: 'The sky is blue',
        filePath: path.join(
          os.homedir(),
          '.proto',
          'memory',
          'user_the-sky-is-blue.md',
        ),
        mtimeMs: Date.now(),
      });
    });

    it('should have correct name, displayName, description, and schema', () => {
      expect(memoryTool.name).toBe('save_memory');
      expect(memoryTool.displayName).toBe('SaveMemory');
      expect(memoryTool.description).toContain(
        'Saves a specific piece of information',
      );
      expect(memoryTool.schema).toBeDefined();
      expect(memoryTool.schema.name).toBe('save_memory');
      expect(memoryTool.schema.parametersJsonSchema).toBeDefined();
    });

    it('should call createMemory and return success for global scope', async () => {
      const params = { fact: 'The sky is blue', scope: 'global' as const };
      const invocation = memoryTool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockCreateMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          content: params.fact,
          scope: 'global',
          type: 'user',
        }),
      );
      expect(result.llmContent).toContain('global memory');
      expect(result.llmContent).toContain(params.fact);
    });

    it('should call createMemory and return success for project scope', async () => {
      const projectFilePath = path.join(
        process.cwd(),
        '.proto',
        'memory',
        'user_the-sky-is-blue.md',
      );
      mockCreateMemory.mockResolvedValue({
        header: {
          name: 'the sky is blue',
          description: 'The sky is blue',
          type: 'user',
        },
        content: 'The sky is blue',
        filePath: projectFilePath,
        mtimeMs: Date.now(),
      });

      const params = { fact: 'The sky is blue', scope: 'project' as const };
      const invocation = memoryTool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockCreateMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          content: params.fact,
          scope: 'project',
          type: 'user',
        }),
      );
      expect(result.llmContent).toContain('project memory');
      expect(result.llmContent).toContain(params.fact);
    });

    it('should return an error if fact is empty', async () => {
      const params = { fact: ' ' }; // Empty fact
      expect(memoryTool.validateToolParams(params)).toBe(
        'Parameter "fact" must be a non-empty string.',
      );
      expect(() => memoryTool.build(params)).toThrow(
        'Parameter "fact" must be a non-empty string.',
      );
    });

    it('should handle errors from createMemory', async () => {
      const params = { fact: 'This will fail', scope: 'global' as const };
      const underlyingError = new Error('Disk full');
      mockCreateMemory.mockRejectedValue(underlyingError);

      const invocation = memoryTool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toBe(
        `Error saving memory: ${underlyingError.message}`,
      );
      expect(result.returnDisplay).toBe(
        `Error saving memory: ${underlyingError.message}`,
      );
      expect(result.error?.type).toBe(
        ToolErrorType.MEMORY_TOOL_EXECUTION_ERROR,
      );
    });

    it('should default to project scope when scope is not specified', async () => {
      const projectFilePath = path.join(
        process.cwd(),
        '.proto',
        'memory',
        'user_test-fact.md',
      );
      mockCreateMemory.mockResolvedValue({
        header: { name: 'test fact', description: 'Test fact', type: 'user' },
        content: 'Test fact',
        filePath: projectFilePath,
        mtimeMs: Date.now(),
      });

      const params = { fact: 'Test fact' };
      const invocation = memoryTool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockCreateMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'project',
        }),
      );
      expect(result.llmContent).toContain('project memory');
    });
  });

  describe('getDefaultPermission and getConfirmationDetails', () => {
    let memoryTool: MemoryTool;

    beforeEach(() => {
      memoryTool = new MemoryTool();
      // Mock fs.readFile to return empty string (file doesn't exist)
      vi.mocked(fs.readFile).mockResolvedValue('');
    });

    it('should always return ask from getDefaultPermission', async () => {
      const params = { fact: 'Test fact', scope: 'global' as const };
      const invocation = memoryTool.build(params);
      const permission = await invocation.getDefaultPermission();

      expect(permission).toBe('ask');
    });

    it('should return confirmation details for global scope', async () => {
      const params = { fact: 'Test fact', scope: 'global' as const };
      const invocation = memoryTool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const result = await invocation.getConfirmationDetails(mockAbortSignal);

      expect(result).toBeDefined();

      if (result.type === 'edit') {
        const expectedPath = path.join('~', '.proto', DEFAULT_CONTEXT_FILENAME);
        expect(result.title).toBe(
          `Confirm Memory Save: ${expectedPath} (global)`,
        );
        expect(result.fileName).toContain(path.join('mock', 'home', '.proto'));
        expect(result.fileName).toContain(DEFAULT_CONTEXT_FILENAME);
        expect(result.fileDiff).toContain(`Index: ${DEFAULT_CONTEXT_FILENAME}`);
        expect(result.fileDiff).toContain('+## Proto Added Memories');
        expect(result.fileDiff).toContain('+- Test fact');
        expect(result.originalContent).toBe('');
        expect(result.newContent).toContain('## Proto Added Memories');
        expect(result.newContent).toContain('- Test fact');
      }
    });

    it('should return confirmation details for project scope', async () => {
      const params = { fact: 'Test fact', scope: 'project' as const };
      const invocation = memoryTool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const result = await invocation.getConfirmationDetails(mockAbortSignal);

      expect(result).toBeDefined();

      if (result.type === 'edit') {
        const expectedPath = path.join(process.cwd(), DEFAULT_CONTEXT_FILENAME);
        expect(result.title).toBe(
          `Confirm Memory Save: ${expectedPath} (project)`,
        );
        expect(result.fileName).toBe(expectedPath);
        expect(result.fileDiff).toContain(`Index: ${DEFAULT_CONTEXT_FILENAME}`);
        expect(result.fileDiff).toContain('+## Proto Added Memories');
        expect(result.fileDiff).toContain('+- Test fact');
        expect(result.originalContent).toBe('');
        expect(result.newContent).toContain('## Proto Added Memories');
        expect(result.newContent).toContain('- Test fact');
      }
    });

    it('should have no-op onConfirm callback', async () => {
      const params = { fact: 'Test fact', scope: 'global' as const };
      const invocation = memoryTool.build(params);
      const result = await invocation.getConfirmationDetails(mockAbortSignal);

      if (result.type === 'edit') {
        // onConfirm should be a no-op — just verify it doesn't throw
        await expect(
          result.onConfirm(ToolConfirmationOutcome.ProceedAlways),
        ).resolves.toBeUndefined();
        await expect(
          result.onConfirm(ToolConfirmationOutcome.ProceedOnce),
        ).resolves.toBeUndefined();
        await expect(
          result.onConfirm(ToolConfirmationOutcome.Cancel),
        ).resolves.toBeUndefined();
      }
    });

    it('should handle existing memory file with content for global scope', async () => {
      const params = { fact: 'New fact', scope: 'global' as const };
      const existingContent =
        'Some existing content.\n\n## Proto Added Memories\n- Old fact\n';

      // Mock fs.readFile to return existing content
      vi.mocked(fs.readFile).mockResolvedValue(existingContent);

      const invocation = memoryTool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const result = await invocation.getConfirmationDetails(mockAbortSignal);

      expect(result).toBeDefined();

      if (result.type === 'edit') {
        const expectedPath = path.join('~', '.proto', DEFAULT_CONTEXT_FILENAME);
        expect(result.title).toBe(
          `Confirm Memory Save: ${expectedPath} (global)`,
        );
        expect(result.fileDiff).toContain(`Index: ${DEFAULT_CONTEXT_FILENAME}`);
        expect(result.fileDiff).toContain('+- New fact');
        expect(result.originalContent).toBe(existingContent);
        expect(result.newContent).toContain('- Old fact');
        expect(result.newContent).toContain('- New fact');
      }
    });

    it('should prompt for scope selection when scope is not specified', async () => {
      const params = { fact: 'Test fact' };
      const invocation = memoryTool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');

      const result = await invocation.getConfirmationDetails(mockAbortSignal);

      expect(result).toBeDefined();

      if (result.type === 'edit') {
        expect(result.title).toContain('Choose Memory Location');
        expect(result.title).toContain('GLOBAL');
        expect(result.title).toContain('PROJECT');
        expect(result.fileName).toBe(DEFAULT_CONTEXT_FILENAME);
        expect(result.fileDiff).toContain('Test fact');
        expect(result.fileDiff).toContain(`--- ${DEFAULT_CONTEXT_FILENAME}`);
        expect(result.fileDiff).toContain(`+++ ${DEFAULT_CONTEXT_FILENAME}`);
        expect(result.fileDiff).toContain('+- Test fact');
        expect(result.originalContent).toContain('scope: global');
        expect(result.originalContent).toContain('INSTRUCTIONS:');
      }
    });

    it('should show correct file paths in scope selection prompt', async () => {
      const params = { fact: 'Test fact' };
      const invocation = memoryTool.build(params);
      const result = await invocation.getConfirmationDetails(mockAbortSignal);

      expect(result).toBeDefined();

      if (result.type === 'edit') {
        const globalPath = path.join('~', '.proto', DEFAULT_CONTEXT_FILENAME);
        const projectPath = path.join(process.cwd(), DEFAULT_CONTEXT_FILENAME);

        expect(result.fileDiff).toContain(`Global: ${globalPath}`);
        expect(result.fileDiff).toContain(`Project: ${projectPath}`);
        expect(result.fileDiff).toContain('(shared across all projects)');
        expect(result.fileDiff).toContain('(current project only)');
      }
    });
  });

  describe('getDescription', () => {
    let memoryTool: MemoryTool;

    beforeEach(() => {
      memoryTool = new MemoryTool();
    });

    it('should return correct description for global scope', () => {
      const params = { fact: 'Test fact', scope: 'global' as const };
      const invocation = memoryTool.build(params);
      const description = invocation.getDescription();

      const expectedPath = path.join('~', '.proto', DEFAULT_CONTEXT_FILENAME);
      expect(description).toBe(`${expectedPath} (global)`);
    });

    it('should return correct description for project scope', () => {
      const params = { fact: 'Test fact', scope: 'project' as const };
      const invocation = memoryTool.build(params);
      const description = invocation.getDescription();

      const expectedPath = path.join(process.cwd(), DEFAULT_CONTEXT_FILENAME);
      expect(description).toBe(`${expectedPath} (project)`);
    });

    it('should show choice prompt when scope is not specified', () => {
      const params = { fact: 'Test fact' };
      const invocation = memoryTool.build(params);
      const description = invocation.getDescription();

      const globalPath = path.join('~', '.proto', DEFAULT_CONTEXT_FILENAME);
      const projectPath = path.join(process.cwd(), DEFAULT_CONTEXT_FILENAME);
      expect(description).toBe(
        `CHOOSE: ${globalPath} (global) OR ${projectPath} (project)`,
      );
    });
  });
});
