/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { marked } from 'marked';
import {
  processImports,
  validateImportPath,
  collectImportParentMap,
  isValidImportPath,
  type MemoryFile,
} from './memoryImportProcessor.js';
import { runLogger } from './runLogger.js';

// Helper function to create platform-agnostic test paths
function testPath(...segments: string[]): string {
  // Start with the first segment as is (might be an absolute path on Windows)
  let result = segments[0];

  // Join remaining segments with the platform-specific separator
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startsWith('/') || segments[i].startsWith('\\')) {
      // If segment starts with a separator, remove the trailing separator from the result
      result = path.normalize(result.replace(/[\\/]+$/, '') + segments[i]);
    } else {
      // Otherwise join with the platform separator
      result = path.join(result, segments[i]);
    }
  }

  return path.normalize(result);
}

vi.mock('fs/promises');
const mockedFs = vi.mocked(fs);

// Helper functions using marked for parsing and validation
const parseMarkdown = (content: string) => marked.lexer(content);

const findMarkdownComments = (content: string): string[] => {
  const tokens = parseMarkdown(content);
  const comments: string[] = [];

  function walkTokens(tokenList: unknown[]) {
    for (const token of tokenList) {
      const t = token as { type: string; raw: string; tokens?: unknown[] };
      if (t.type === 'html' && t.raw.includes('<!--')) {
        comments.push(t.raw.trim());
      }
      if (t.tokens) {
        walkTokens(t.tokens);
      }
    }
  }

  walkTokens(tokens);
  return comments;
};

const findCodeBlocks = (
  content: string,
): Array<{ type: string; content: string }> => {
  const tokens = parseMarkdown(content);
  const codeBlocks: Array<{ type: string; content: string }> = [];

  function walkTokens(tokenList: unknown[]) {
    for (const token of tokenList) {
      const t = token as { type: string; text: string; tokens?: unknown[] };
      if (t.type === 'code') {
        codeBlocks.push({
          type: 'code_block',
          content: t.text,
        });
      } else if (t.type === 'codespan') {
        codeBlocks.push({
          type: 'inline_code',
          content: t.text,
        });
      }
      if (t.tokens) {
        walkTokens(t.tokens);
      }
    }
  }

  walkTokens(tokens);
  return codeBlocks;
};

describe('memoryImportProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock console methods
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    vi.spyOn(runLogger, 'error').mockImplementation(() => {});
    vi.spyOn(runLogger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('processImports', () => {
    it('should process basic md file imports', async () => {
      const content = 'Some content @./test.md more content';
      const basePath = testPath('test', 'path');
      const importedContent = '# Imported Content\nThis is imported.';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(importedContent);

      const result = await processImports(content, basePath, true);

      // Use marked to find HTML comments (import markers)
      const comments = findMarkdownComments(result.content);
      expect(comments.some((c) => c.includes('Imported from: ./test.md'))).toBe(
        true,
      );
      expect(
        comments.some((c) => c.includes('End of import from: ./test.md')),
      ).toBe(true);

      // Verify the imported content is present
      expect(result.content).toContain(importedContent);

      // Verify the markdown structure is valid
      const tokens = parseMarkdown(result.content);
      expect(tokens).toBeDefined();
      expect(tokens.length).toBeGreaterThan(0);

      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.resolve(basePath, './test.md'),
        'utf-8',
      );
    });

    it('should import non-md files just like md files', async () => {
      const content = 'Some content @./instructions.txt more content';
      const basePath = testPath('test', 'path');
      const importedContent =
        '# Instructions\nThis is a text file with markdown.';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(importedContent);

      const result = await processImports(content, basePath, true);

      // Use marked to find import comments
      const comments = findMarkdownComments(result.content);
      expect(
        comments.some((c) => c.includes('Imported from: ./instructions.txt')),
      ).toBe(true);
      expect(
        comments.some((c) =>
          c.includes('End of import from: ./instructions.txt'),
        ),
      ).toBe(true);

      // Use marked to parse and validate the imported content structure
      const tokens = parseMarkdown(result.content);

      // Find headers in the parsed content
      const headers = tokens.filter((token) => token.type === 'heading');
      expect(
        headers.some((h) => (h as { text: string }).text === 'Instructions'),
      ).toBe(true);

      // Verify the imported content is present
      expect(result.content).toContain(importedContent);
      expect(runLogger.warn).not.toHaveBeenCalled();
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.resolve(basePath, './instructions.txt'),
        'utf-8',
      );
    });

    it('should handle circular imports', async () => {
      const content = 'Content @./circular.md more content';
      const basePath = testPath('test', 'path');
      const circularContent = 'Circular @./main.md content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(circularContent);

      // Set up the import state to simulate we're already processing main.md
      const importState = {
        processedFiles: new Set<string>(),
        maxDepth: 10,
        currentDepth: 0,
        currentFile: testPath('test', 'path', 'main.md'), // Simulate we're processing main.md
      };

      const result = await processImports(content, basePath, true, importState);

      // The circular import should be detected when processing the nested import
      expect(result.content).toContain(
        '<!-- File already processed: ./main.md -->',
      );
    });

    it('should handle file not found errors', async () => {
      const content = 'Content @./nonexistent.md more content';
      const basePath = testPath('test', 'path');

      mockedFs.access.mockRejectedValue(new Error('File not found'));

      const result = await processImports(content, basePath, true);

      expect(result.content).toContain(
        '<!-- Import failed: ./nonexistent.md - File not found -->',
      );
      expect(runLogger.error).toHaveBeenCalledWith(
        '[ERROR] [ImportProcessor]',
        'Failed to import ./nonexistent.md: File not found',
      );
    });

    it('should respect max depth limit', async () => {
      const content = 'Content @./deep.md more content';
      const basePath = testPath('test', 'path');
      const deepContent = 'Deep @./deeper.md content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(deepContent);

      const importState = {
        processedFiles: new Set<string>(),
        maxDepth: 1,
        currentDepth: 1,
      };

      const result = await processImports(content, basePath, true, importState);

      expect(runLogger.warn).toHaveBeenCalledWith(
        '[WARN] [ImportProcessor]',
        'Maximum import depth (1) reached. Stopping import processing.',
      );
      expect(result.content).toBe(content);
    });

    it('should handle nested imports recursively', async () => {
      const content = 'Main @./nested.md content';
      const basePath = testPath('test', 'path');
      const nestedContent = 'Nested @./inner.md content';
      const innerContent = 'Inner content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(nestedContent)
        .mockResolvedValueOnce(innerContent);

      const result = await processImports(content, basePath, true);

      expect(result.content).toContain('<!-- Imported from: ./nested.md -->');
      expect(result.content).toContain('<!-- Imported from: ./inner.md -->');
      expect(result.content).toContain(innerContent);
    });

    it('should handle absolute paths in imports', async () => {
      const content = 'Content @/absolute/path/file.md more content';
      const basePath = testPath('test', 'path');
      const importedContent = 'Absolute path content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(importedContent);

      const result = await processImports(content, basePath, true);

      expect(result.content).toContain(
        '<!-- Import blocked: /absolute/path/file.md - outside project root -->',
      );
    });

    it('should handle multiple imports in same content', async () => {
      const content = 'Start @./first.md middle @./second.md end';
      const basePath = testPath('test', 'path');
      const firstContent = 'First content';
      const secondContent = 'Second content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(firstContent)
        .mockResolvedValueOnce(secondContent);

      const result = await processImports(content, basePath, true);

      expect(result.content).toContain('<!-- Imported from: ./first.md -->');
      expect(result.content).toContain('<!-- Imported from: ./second.md -->');
      expect(result.content).toContain(firstContent);
      expect(result.content).toContain(secondContent);
    });

    it('should ignore imports inside code blocks', async () => {
      const content = [
        'Normal content @./should-import.md',
        '```',
        'code block with @./should-not-import.md',
        '```',
        'More content @./should-import2.md',
      ].join('\n');
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const importedContent1 = 'Imported 1';
      const importedContent2 = 'Imported 2';
      // Only the imports outside code blocks should be processed
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(importedContent1)
        .mockResolvedValueOnce(importedContent2);
      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
      );

      // Use marked to verify imported content is present
      expect(result.content).toContain(importedContent1);
      expect(result.content).toContain(importedContent2);

      // Use marked to find code blocks and verify the import wasn't processed
      const codeBlocks = findCodeBlocks(result.content);
      const hasUnprocessedImport = codeBlocks.some((block) =>
        block.content.includes('@./should-not-import.md'),
      );
      expect(hasUnprocessedImport).toBe(true);

      // Verify no import comment was created for the code block import
      const comments = findMarkdownComments(result.content);
      expect(comments.some((c) => c.includes('should-not-import.md'))).toBe(
        false,
      );
    });

    it('should ignore imports inside inline code', async () => {
      const content = [
        'Normal content @./should-import.md',
        '`code with import @./should-not-import.md`',
        'More content @./should-import2.md',
      ].join('\n');
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const importedContent1 = 'Imported 1';
      const importedContent2 = 'Imported 2';
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(importedContent1)
        .mockResolvedValueOnce(importedContent2);
      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
      );

      // Verify imported content is present
      expect(result.content).toContain(importedContent1);
      expect(result.content).toContain(importedContent2);

      // Use marked to find inline code spans
      const codeBlocks = findCodeBlocks(result.content);
      const inlineCodeSpans = codeBlocks.filter(
        (block) => block.type === 'inline_code',
      );

      // Verify the inline code span still contains the unprocessed import
      expect(
        inlineCodeSpans.some((span) =>
          span.content.includes('@./should-not-import.md'),
        ),
      ).toBe(true);

      // Verify no import comments were created for inline code imports
      const comments = findMarkdownComments(result.content);
      expect(comments.some((c) => c.includes('should-not-import.md'))).toBe(
        false,
      );
    });

    it('should handle nested tokens and non-unique content correctly', async () => {
      // This test verifies the robust findCodeRegions implementation
      // that recursively walks the token tree and handles non-unique content
      const content = [
        'Normal content @./should-import.md',
        'Paragraph with `inline code @./should-not-import.md` and more text.',
        'Another paragraph with the same `inline code @./should-not-import.md` text.',
        'More content @./should-import2.md',
      ].join('\n');
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const importedContent1 = 'Imported 1';
      const importedContent2 = 'Imported 2';
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(importedContent1)
        .mockResolvedValueOnce(importedContent2);
      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
      );

      // Should process imports outside code regions
      expect(result.content).toContain(importedContent1);
      expect(result.content).toContain(importedContent2);

      // Should preserve imports inside inline code (both occurrences)
      expect(result.content).toContain('`inline code @./should-not-import.md`');

      // Should not have processed the imports inside code regions
      expect(result.content).not.toContain(
        '<!-- Imported from: ./should-not-import.md -->',
      );
    });

    it('should not process imports in repeated inline code blocks', async () => {
      const content = '`@noimport` and `@noimport`';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');

      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
      );

      expect(result.content).toBe(content);
    });

    it('should not import when @ is inside an inline code block', async () => {
      const content =
        'We should not ` @import` when the symbol is inside an inline code string.';
      const testRootDir = testPath('test', 'project');
      const result = await processImports(content, testRootDir);
      expect(result.content).toBe(content);
      expect(result.importTree.imports).toBeUndefined();
    });

    it('should allow imports from parent and subdirectories within project root', async () => {
      const content =
        'Parent import: @../parent.md Subdir import: @./components/sub.md';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const importedParent = 'Parent file content';
      const importedSub = 'Subdir file content';
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(importedParent)
        .mockResolvedValueOnce(importedSub);
      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
      );
      expect(result.content).toContain(importedParent);
      expect(result.content).toContain(importedSub);
    });

    it('should reject imports outside project root', async () => {
      const content = 'Outside import: @../../../etc/passwd';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
      );
      expect(result.content).toContain(
        '<!-- Import blocked: ../../../etc/passwd - outside project root -->',
      );
    });

    it('should build import tree structure', async () => {
      const content = 'Main content @./nested.md @./simple.md';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const nestedContent = 'Nested @./inner.md content';
      const simpleContent = 'Simple content';
      const innerContent = 'Inner content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(nestedContent)
        .mockResolvedValueOnce(simpleContent)
        .mockResolvedValueOnce(innerContent);

      const result = await processImports(content, basePath, true);

      // Use marked to find and validate import comments
      const comments = findMarkdownComments(result.content);
      const importComments = comments.filter((c) =>
        c.includes('Imported from:'),
      );

      expect(importComments.some((c) => c.includes('./nested.md'))).toBe(true);
      expect(importComments.some((c) => c.includes('./simple.md'))).toBe(true);
      expect(importComments.some((c) => c.includes('./inner.md'))).toBe(true);

      // Use marked to validate the markdown structure is well-formed
      const tokens = parseMarkdown(result.content);
      expect(tokens).toBeDefined();
      expect(tokens.length).toBeGreaterThan(0);

      // Verify the content contains expected text using marked parsing
      const textContent = tokens
        .filter((token) => token.type === 'paragraph')
        .map((token) => token.raw)
        .join(' ');

      expect(textContent).toContain('Main content');
      expect(textContent).toContain('Nested');
      expect(textContent).toContain('Simple content');
      expect(textContent).toContain('Inner content');

      // Verify import tree structure
      expect(result.importTree.path).toBe('unknown'); // No currentFile set in test
      expect(result.importTree.imports).toHaveLength(2);

      // First import: nested.md
      // Check that the paths match using includes to handle potential absolute/relative differences
      const expectedNestedPath = testPath(projectRoot, 'src', 'nested.md');

      expect(result.importTree.imports![0].path).toContain(expectedNestedPath);
      expect(result.importTree.imports![0].imports).toHaveLength(1);

      const expectedInnerPath = testPath(projectRoot, 'src', 'inner.md');
      expect(result.importTree.imports![0].imports![0].path).toContain(
        expectedInnerPath,
      );
      expect(result.importTree.imports![0].imports![0].imports).toBeUndefined();

      // Second import: simple.md
      const expectedSimplePath = testPath(projectRoot, 'src', 'simple.md');
      expect(result.importTree.imports![1].path).toContain(expectedSimplePath);
      expect(result.importTree.imports![1].imports).toBeUndefined();
    });

    it('should produce flat output in Claude-style with unique files in order', async () => {
      const content = 'Main @./nested.md content @./simple.md';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const nestedContent = 'Nested @./inner.md content';
      const simpleContent = 'Simple content';
      const innerContent = 'Inner content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(nestedContent)
        .mockResolvedValueOnce(simpleContent)
        .mockResolvedValueOnce(innerContent);

      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
        'flat',
      );

      // Use marked to parse the output and validate structure
      const tokens = parseMarkdown(result.content);
      expect(tokens).toBeDefined();

      // Find all file markers using marked parsing
      const fileMarkers: string[] = [];
      const endMarkers: string[] = [];

      function walkTokens(tokenList: unknown[]) {
        for (const token of tokenList) {
          const t = token as { type: string; raw: string; tokens?: unknown[] };
          if (t.type === 'paragraph' && t.raw.includes('--- File:')) {
            const match = t.raw.match(/--- File: (.+?) ---/);
            if (match) {
              // Normalize the path before adding to fileMarkers
              fileMarkers.push(path.normalize(match[1]));
            }
          }
          if (t.type === 'paragraph' && t.raw.includes('--- End of File:')) {
            const match = t.raw.match(/--- End of File: (.+?) ---/);
            if (match) {
              // Normalize the path before adding to endMarkers
              endMarkers.push(path.normalize(match[1]));
            }
          }
          if (t.tokens) {
            walkTokens(t.tokens);
          }
        }
      }

      walkTokens(tokens);

      // Verify all expected files are present
      const expectedFiles = ['nested.md', 'simple.md', 'inner.md'];

      // Check that each expected file is present in the content
      expectedFiles.forEach((file) => {
        expect(result.content).toContain(file);
      });

      // Verify content is present
      expect(result.content).toContain(
        'Main @./nested.md content @./simple.md',
      );
      expect(result.content).toContain('Nested @./inner.md content');
      expect(result.content).toContain('Simple content');
      expect(result.content).toContain('Inner content');

      // Verify end markers exist
      expect(endMarkers.length).toBeGreaterThan(0);
    });

    it('should not duplicate files in flat output if imported multiple times', async () => {
      const content = 'Main @./dup.md again @./dup.md';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const dupContent = 'Duplicated content';

      // Reset mocks
      mockedFs.access.mockReset();
      mockedFs.readFile.mockReset();

      // Set up mocks
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(dupContent);

      const result = await processImports(
        content,
        basePath,
        true, // followImports
        undefined, // allowedPaths
        projectRoot,
        'flat', // outputFormat
      );

      // Verify readFile was called only once for dup.md
      expect(mockedFs.readFile).toHaveBeenCalledTimes(1);

      // Check that the content contains the file content only once
      const contentStr = result.content;
      const firstIndex = contentStr.indexOf('Duplicated content');
      const lastIndex = contentStr.lastIndexOf('Duplicated content');
      expect(firstIndex).toBeGreaterThan(-1); // Content should exist
      expect(firstIndex).toBe(lastIndex); // Should only appear once
    });

    it('should handle nested imports in flat output', async () => {
      const content = 'Root @./a.md';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const aContent = 'A @./b.md';
      const bContent = 'B content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(aContent)
        .mockResolvedValueOnce(bContent);

      const result = await processImports(
        content,
        basePath,
        true,
        undefined,
        projectRoot,
        'flat',
      );

      // Verify all files are present by checking for their basenames
      expect(result.content).toContain('a.md');
      expect(result.content).toContain('b.md');

      // Verify content is in the correct order
      const contentStr = result.content;
      const aIndex = contentStr.indexOf('a.md');
      const bIndex = contentStr.indexOf('b.md');
      const rootIndex = contentStr.indexOf('Root @./a.md');

      expect(rootIndex).toBeLessThan(aIndex);
      expect(aIndex).toBeLessThan(bIndex);

      // Verify content is present
      expect(result.content).toContain('Root @./a.md');
      expect(result.content).toContain('A @./b.md');
      expect(result.content).toContain('B content');
    });

    it('should return failedImports for non-existent files (tree format)', async () => {
      const content = 'Content @./nonexistent.md more content';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const currentFile = testPath(projectRoot, 'src', 'AGENTS.md');

      mockedFs.access.mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await processImports(
        content,
        basePath,
        false,
        {
          processedFiles: new Set([currentFile]),
          maxDepth: 5,
          currentDepth: 0,
          currentFile,
        },
        projectRoot,
      );

      expect(result.failedImports).toHaveLength(1);
      expect(result.failedImports[0].importPath).toBe('./nonexistent.md');
      expect(result.failedImports[0].sourceFile).toBe(currentFile);
      expect(result.failedImports[0].error).toContain('ENOENT');
    });

    it('should return failedImports for non-existent files (flat format)', async () => {
      const content = 'Content @./nonexistent.md more content';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const currentFile = testPath(projectRoot, 'src', 'AGENTS.md');

      mockedFs.access.mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await processImports(
        content,
        basePath,
        false,
        {
          processedFiles: new Set([currentFile]),
          maxDepth: 5,
          currentDepth: 0,
          currentFile,
        },
        projectRoot,
        'flat',
      );

      expect(result.failedImports).toHaveLength(1);
      expect(result.failedImports[0].importPath).toBe('./nonexistent.md');
      expect(result.failedImports[0].sourceFile).toContain('AGENTS.md');
      expect(result.failedImports[0].error).toContain('ENOENT');
    });

    it('should return blockedExternalImports for paths outside project root', async () => {
      const content = 'Content @../../outside/secret.md more content';
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const currentFile = testPath(projectRoot, 'src', 'AGENTS.md');

      const result = await processImports(
        content,
        basePath,
        false,
        {
          processedFiles: new Set([currentFile]),
          maxDepth: 5,
          currentDepth: 0,
          currentFile,
        },
        projectRoot,
      );

      expect(result.blockedExternalImports).toHaveLength(1);
      expect(result.blockedExternalImports[0].importPath).toBe(
        '../../outside/secret.md',
      );
      expect(result.blockedExternalImports[0].sourceFile).toBe(currentFile);
    });

    it('should resolve relative path imports correctly from subdirectory', async () => {
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const importedContent = 'Shared context content';

      // First call for ./shared/context.md, second for ../docs/guide.md
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile
        .mockResolvedValueOnce(importedContent)
        .mockResolvedValueOnce('Guide content');

      const content =
        'Include shared: @./shared/context.md\nInclude guide: @../docs/guide.md';

      const result = await processImports(
        content,
        basePath,
        false,
        undefined,
        projectRoot,
      );

      expect(result.content).toContain(importedContent);
      expect(result.content).toContain('Guide content');
      expect(result.failedImports).toHaveLength(0);
      expect(result.blockedExternalImports).toHaveLength(0);

      // Verify correct path resolution
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.resolve(basePath, './shared/context.md'),
        'utf-8',
      );
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.resolve(basePath, '../docs/guide.md'),
        'utf-8',
      );
    });

    it('should resolve bare relative path imports (without ./ prefix)', async () => {
      const projectRoot = testPath('test', 'project');
      const basePath = testPath(projectRoot, 'src');
      const importedContent = 'Utils content';

      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValueOnce(importedContent);

      const content = 'Include: @utils/helpers.md';

      const result = await processImports(
        content,
        basePath,
        false,
        undefined,
        projectRoot,
      );

      expect(result.content).toContain(importedContent);
      expect(result.failedImports).toHaveLength(0);
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.resolve(basePath, 'utils/helpers.md'),
        'utf-8',
      );
    });
  });

  describe('validateImportPath', () => {
    it('should reject URLs', () => {
      const basePath = testPath('base');
      const allowedPath = testPath('allowed');
      expect(
        validateImportPath('https://example.com/file.md', basePath, [
          allowedPath,
        ]),
      ).toBe(false);
      expect(
        validateImportPath('http://example.com/file.md', basePath, [
          allowedPath,
        ]),
      ).toBe(false);
      expect(
        validateImportPath('file:///path/to/file.md', basePath, [allowedPath]),
      ).toBe(false);
    });

    it('should allow paths within allowed directories', () => {
      const basePath = path.resolve(testPath('base'));
      const allowedPath = path.resolve(testPath('allowed'));

      // Test relative paths - resolve them against basePath
      const relativePath = './file.md';
      path.resolve(basePath, relativePath);
      expect(validateImportPath(relativePath, basePath, [basePath])).toBe(true);

      // Test parent directory access (should be allowed if parent is in allowed paths)
      const parentPath = path.dirname(basePath);
      if (parentPath !== basePath) {
        // Only test if parent is different
        const parentRelativePath = '../file.md';
        path.resolve(basePath, parentRelativePath);
        expect(
          validateImportPath(parentRelativePath, basePath, [parentPath]),
        ).toBe(true);

        path.resolve(basePath, 'sub');
        const resultSub = validateImportPath('sub', basePath, [basePath]);
        expect(resultSub).toBe(true);
      }

      // Test allowed path access - use a file within the allowed directory
      const allowedSubPath = 'nested';
      const allowedFilePath = path.join(allowedPath, allowedSubPath, 'file.md');
      expect(validateImportPath(allowedFilePath, basePath, [allowedPath])).toBe(
        true,
      );
    });

    it('should reject paths outside allowed directories', () => {
      const basePath = path.resolve(testPath('base'));
      const allowedPath = path.resolve(testPath('allowed'));
      const forbiddenPath = path.resolve(testPath('forbidden'));

      // Forbidden path should be blocked
      expect(validateImportPath(forbiddenPath, basePath, [allowedPath])).toBe(
        false,
      );

      // Relative path to forbidden directory should be blocked
      const relativeToForbidden = path.relative(
        basePath,
        path.join(forbiddenPath, 'file.md'),
      );
      expect(
        validateImportPath(relativeToForbidden, basePath, [allowedPath]),
      ).toBe(false);

      // Path that tries to escape the base directory should be blocked
      const escapingPath = path.join('..', '..', 'sensitive', 'file.md');
      expect(validateImportPath(escapingPath, basePath, [basePath])).toBe(
        false,
      );
    });

    it('should handle multiple allowed directories', () => {
      const basePath = path.resolve(testPath('base'));
      const allowed1 = path.resolve(testPath('allowed1'));
      const allowed2 = path.resolve(testPath('allowed2'));

      // File not in any allowed path
      const otherPath = path.resolve(testPath('other', 'file.md'));
      expect(
        validateImportPath(otherPath, basePath, [allowed1, allowed2]),
      ).toBe(false);

      // File in first allowed path
      const file1 = path.join(allowed1, 'nested', 'file.md');
      expect(validateImportPath(file1, basePath, [allowed1, allowed2])).toBe(
        true,
      );

      // File in second allowed path
      const file2 = path.join(allowed2, 'nested', 'file.md');
      expect(validateImportPath(file2, basePath, [allowed1, allowed2])).toBe(
        true,
      );

      // Test with relative path to allowed directory
      const relativeToAllowed1 = path.relative(basePath, file1);
      expect(
        validateImportPath(relativeToAllowed1, basePath, [allowed1, allowed2]),
      ).toBe(true);
    });

    it('should handle relative paths correctly', () => {
      const basePath = path.resolve(testPath('base'));
      const parentPath = path.resolve(testPath('parent'));

      // Current directory file access
      expect(validateImportPath('file.md', basePath, [basePath])).toBe(true);

      // Explicit current directory file access
      expect(validateImportPath('./file.md', basePath, [basePath])).toBe(true);

      // Parent directory access - should be blocked unless parent is in allowed paths
      const parentFile = path.join(parentPath, 'file.md');
      const relativeToParent = path.relative(basePath, parentFile);
      expect(validateImportPath(relativeToParent, basePath, [basePath])).toBe(
        false,
      );

      // Parent directory access when parent is in allowed paths
      expect(
        validateImportPath(relativeToParent, basePath, [basePath, parentPath]),
      ).toBe(true);

      // Nested relative path
      const nestedPath = path.join('nested', 'sub', 'file.md');
      expect(validateImportPath(nestedPath, basePath, [basePath])).toBe(true);
    });

    it('should handle absolute paths correctly', () => {
      const basePath = path.resolve(testPath('base'));
      const allowedPath = path.resolve(testPath('allowed'));
      const forbiddenPath = path.resolve(testPath('forbidden'));

      // Allowed path should work - file directly in allowed directory
      const allowedFilePath = path.join(allowedPath, 'file.md');
      expect(validateImportPath(allowedFilePath, basePath, [allowedPath])).toBe(
        true,
      );

      // Allowed path should work - file in subdirectory of allowed directory
      const allowedNestedPath = path.join(allowedPath, 'nested', 'file.md');
      expect(
        validateImportPath(allowedNestedPath, basePath, [allowedPath]),
      ).toBe(true);

      // Forbidden path should be blocked
      const forbiddenFilePath = path.join(forbiddenPath, 'file.md');
      expect(
        validateImportPath(forbiddenFilePath, basePath, [allowedPath]),
      ).toBe(false);

      // Relative path to allowed directory should work
      const relativeToAllowed = path.relative(basePath, allowedFilePath);
      expect(
        validateImportPath(relativeToAllowed, basePath, [allowedPath]),
      ).toBe(true);

      // Path that resolves to the same file but via different relative segments
      const dotPath = path.join(
        '.',
        '..',
        path.basename(allowedPath),
        'file.md',
      );
      expect(validateImportPath(dotPath, basePath, [allowedPath])).toBe(true);
    });
  });

  describe('collectImportParentMap', () => {
    it('should return empty map for empty imports', () => {
      const result = collectImportParentMap([], '/root/AGENTS.md');
      expect(result.size).toBe(0);
    });

    it('should map direct children to parent', () => {
      const imports: MemoryFile[] = [
        { path: '/app/child1.md' },
        { path: '/app/child2.md' },
      ];
      const result = collectImportParentMap(imports, '/app/AGENTS.md');
      expect(result.get('/app/child1.md')).toBe('/app/AGENTS.md');
      expect(result.get('/app/child2.md')).toBe('/app/AGENTS.md');
      expect(result.size).toBe(2);
    });

    it('should handle nested imports with correct parent mapping', () => {
      const imports: MemoryFile[] = [
        {
          path: '/app/child.md',
          imports: [{ path: '/app/grandchild.md' }],
        },
      ];
      const result = collectImportParentMap(imports, '/app/AGENTS.md');
      expect(result.get('/app/child.md')).toBe('/app/AGENTS.md');
      expect(result.get('/app/grandchild.md')).toBe('/app/child.md');
      expect(result.size).toBe(2);
    });

    it('should skip entries with path "unknown"', () => {
      const imports: MemoryFile[] = [
        { path: 'unknown' },
        { path: '/app/real.md' },
      ];
      const result = collectImportParentMap(imports, '/app/AGENTS.md');
      expect(result.has('unknown')).toBe(false);
      expect(result.get('/app/real.md')).toBe('/app/AGENTS.md');
      expect(result.size).toBe(1);
    });

    it('should handle deeply nested import tree', () => {
      const imports: MemoryFile[] = [
        {
          path: '/a.md',
          imports: [
            {
              path: '/b.md',
              imports: [{ path: '/c.md' }],
            },
          ],
        },
      ];
      const result = collectImportParentMap(imports, '/root.md');
      expect(result.get('/a.md')).toBe('/root.md');
      expect(result.get('/b.md')).toBe('/a.md');
      expect(result.get('/c.md')).toBe('/b.md');
      expect(result.size).toBe(3);
    });
  });

  describe('isValidImportPath', () => {
    describe('should accept valid file paths', () => {
      it('accepts explicit relative paths with ./', () => {
        expect(isValidImportPath('./src/config.ts')).toBe(true);
        expect(isValidImportPath('./file.md')).toBe(true);
        expect(isValidImportPath('./.hidden/rules.md')).toBe(true);
      });

      it('accepts parent-relative paths with ../', () => {
        expect(isValidImportPath('../shared/rules.md')).toBe(true);
        expect(isValidImportPath('../config.yaml')).toBe(true);
      });

      it('accepts home-relative paths with ~/', () => {
        expect(isValidImportPath('~/rules.md')).toBe(true);
        expect(isValidImportPath('~/.claude/CLAUDE.md')).toBe(true);
      });

      it('accepts absolute paths', () => {
        expect(isValidImportPath('/etc/config.yaml')).toBe(true);
        expect(isValidImportPath('/home/user/rules.md')).toBe(true);
      });

      it('accepts bare filenames with extensions', () => {
        expect(isValidImportPath('config.yaml')).toBe(true);
        expect(isValidImportPath('rules.md')).toBe(true);
        expect(isValidImportPath('.env')).toBe(true);
      });

      it('rejects bare filenames without extensions (could be mentions)', () => {
        expect(isValidImportPath('Makefile')).toBe(false);
        expect(isValidImportPath('README')).toBe(false);
        expect(isValidImportPath('Dockerfile')).toBe(false);
        expect(isValidImportPath('admin')).toBe(false);
        expect(isValidImportPath('someone')).toBe(false);
      });

      it('accepts paths with slash and file extension', () => {
        expect(isValidImportPath('src/utils/file.ts')).toBe(true);
        expect(isValidImportPath('docs/api.md')).toBe(true);
        expect(isValidImportPath('config/settings.json')).toBe(true);
      });

      it('accepts paths where first segment has a dot', () => {
        expect(isValidImportPath('.config/rules')).toBe(true);
        expect(isValidImportPath('.claude/agents')).toBe(true);
      });
    });

    describe('should reject non-file-path patterns', () => {
      it('rejects npm scoped package names (bare word + slash, no extension)', () => {
        expect(isValidImportPath('testing-library/react')).toBe(false);
        expect(isValidImportPath('testing-library/user-event')).toBe(false);
        expect(isValidImportPath('babel/preset-env')).toBe(false);
        expect(isValidImportPath('types/node')).toBe(false);
        expect(isValidImportPath('emotion/styled')).toBe(false);
      });

      it('rejects paths starting with @', () => {
        expect(isValidImportPath('@testing-library/react')).toBe(false);
        expect(isValidImportPath('@types/node')).toBe(false);
        expect(isValidImportPath('@@double')).toBe(false);
      });

      it('rejects paths starting with special characters', () => {
        expect(isValidImportPath('#channel')).toBe(false);
        expect(isValidImportPath('%something')).toBe(false);
        expect(isValidImportPath('***bold***')).toBe(false);
        expect(isValidImportPath('(parenthetical)')).toBe(false);
      });

      it('rejects bare "/" path', () => {
        expect(isValidImportPath('/')).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidImportPath('')).toBe(false);
      });

      it('rejects paths starting with non-path characters', () => {
        expect(isValidImportPath('!important')).toBe(false);
        expect(isValidImportPath('+addition')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('accepts multi-segment paths with extension in middle', () => {
        expect(isValidImportPath('src.old/utils/helpers')).toBe(true);
      });

      it('rejects multi-segment package-like paths without any extension', () => {
        expect(isValidImportPath('some-lib/sub-package/module')).toBe(false);
      });

      it('accepts paths with numbers', () => {
        expect(isValidImportPath('config2.yaml')).toBe(true);
        expect(isValidImportPath('0-init.sql')).toBe(true);
      });

      it('accepts paths starting with underscore or dash (with extension)', () => {
        expect(isValidImportPath('_helpers.ts')).toBe(true);
        expect(isValidImportPath('-config.md')).toBe(true);
      });

      it('rejects bare words that look like mentions', () => {
        expect(isValidImportPath('admin')).toBe(false);
        expect(isValidImportPath('someone')).toBe(false);
        expect(isValidImportPath('help')).toBe(false);
      });
    });
  });
});
