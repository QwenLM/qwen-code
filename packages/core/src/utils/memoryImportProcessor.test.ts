/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  processImports,
  validateImportPath,
  type ImportedFileNotification,
  type ProcessImportsOptions,
} from './memoryImportProcessor.js';

// Platform-agnostic test paths: the first segment is kept as is (it may be a
// Windows absolute path); a later segment starting with a separator is
// appended without doubling it, others are joined.
function testPath(...segments: string[]): string {
  let result = segments[0];
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startsWith('/') || segments[i].startsWith('\\')) {
      result = path.normalize(result.replace(/[\\/]+$/, '') + segments[i]);
    } else {
      result = path.join(result, segments[i]);
    }
  }
  return path.normalize(result);
}

vi.mock('fs/promises');
const mockedFs = vi.mocked(fs);

const originalConsole = {
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

const BASE = testPath('test', 'path');
const ROOT = testPath('test', 'project');
const SRC = testPath(ROOT, 'src');

const fsError = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

// Every file exists; a single body answers every read, several answer reads in
// order.
function serve(first: string, ...rest: string[]) {
  mockedFs.access.mockResolvedValue(undefined);
  if (!rest.length) {
    mockedFs.readFile.mockResolvedValue(first);
    return;
  }
  for (const body of [first, ...rest]) {
    mockedFs.readFile.mockResolvedValueOnce(body);
  }
}

const inProject = (content: string, format?: 'flat' | 'tree') =>
  processImports(content, SRC, undefined, ROOT, format);

function expectContains(content: string, ...parts: string[]) {
  for (const part of parts) expect(content).toContain(part);
}

describe('memoryImportProcessor', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // clears mock implementations too
    Object.assign(console, { warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
    // Default lstat (used by findProjectRoot): nothing exists.
    mockedFs.lstat.mockRejectedValue(fsError('ENOENT', 'ENOENT'));
  });

  afterEach(() => {
    Object.assign(console, originalConsole);
  });

  describe('processImports', () => {
    const PARENT = path.resolve(BASE, 'QWEN.md');

    // Imports ./test.md into QWEN.md with an import-notification hook.
    const importFromParent = (
      format: 'flat' | 'tree',
      onFileImported: ProcessImportsOptions['onFileImported'],
    ) =>
      processImports(
        'Some content @./test.md more content',
        BASE,
        {
          processedFiles: new Set(),
          maxDepth: 5,
          currentDepth: 0,
          currentFile: PARENT,
        },
        undefined,
        format,
        { onFileImported },
      );

    const recorder = () => {
      const seen: ImportedFileNotification[] = [];
      const onFileImported = (event: ImportedFileNotification) => {
        seen.push(event);
      };
      return { seen, onFileImported };
    };

    // Imports one file from BASE; checks its markers, body and read path.
    async function importSingle(name: string, body: string) {
      serve(body);
      const { content } = await processImports(
        `Some content @./${name} more content`,
        BASE,
      );
      expect(content).toBe(`Some content <!-- Imported from: ./${name} -->
${body}
<!-- End of import from: ./${name} --> more content`);
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.resolve(BASE, `./${name}`),
        'utf-8',
      );
    }

    it('should process basic md file imports', async () => {
      await importSingle('test.md', '# Imported Content\nThis is imported.');
    });

    it('notifies after importing a file', async () => {
      const { seen, onFileImported } = recorder();
      serve('# Imported Content');
      await importFromParent('tree', onFileImported);
      expect(seen).toEqual([
        { filePath: path.resolve(BASE, 'test.md'), parentFilePath: PARENT },
      ]);
    });

    it('keeps imported content when the import notification callback throws', async () => {
      serve('# Imported Content');
      const result = await importFromParent('tree', () => {
        throw new Error('hook failed');
      });
      expect(result.content).toContain('# Imported Content');
      expect(result.content).not.toContain('Import failed');
    });

    it('notifies after importing files in flat mode', async () => {
      const { seen, onFileImported } = recorder();
      const importedFile = path.resolve(BASE, 'test.md');
      serve('# Imported Content\n@./nested.md', '# Nested Content');
      await importFromParent('flat', onFileImported);
      expect(seen).toEqual([
        {
          filePath: path.resolve(BASE, 'nested.md'),
          parentFilePath: importedFile,
        },
        { filePath: importedFile, parentFilePath: PARENT },
      ]);
    });

    it('should import non-md files just like md files', async () => {
      await importSingle(
        'instructions.txt',
        '# Instructions\nThis is a text file with markdown.',
      );
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('should handle circular imports', async () => {
      serve('Circular @./main.md content');
      // Simulate that main.md is already being processed.
      const result = await processImports(
        'Content @./circular.md more content',
        BASE,
        {
          processedFiles: new Set<string>(),
          maxDepth: 10,
          currentDepth: 0,
          currentFile: testPath(BASE, 'main.md'),
        },
      );
      // Detected while processing the nested import.
      expect(result.content).toContain(
        '<!-- File already processed: ./main.md -->',
      );
    });

    it('should silently preserve content when file not found (ENOENT)', async () => {
      const content = 'Content @./nonexistent.md more content';
      mockedFs.access.mockRejectedValue(
        fsError('ENOENT: no such file or directory', 'ENOENT'),
      );
      const result = await processImports(content, BASE);
      // Kept as-is, and nothing is logged for a missing file.
      expect(result.content).toBe(content);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should log error for non-ENOENT file access errors', async () => {
      mockedFs.access.mockRejectedValue(fsError('Permission denied', 'EACCES'));
      const result = await processImports(
        'Content @./permission-denied.md more content',
        BASE,
      );
      // Other errors leave an error comment.
      expect(result.content).toContain(
        '<!-- Import failed: ./permission-denied.md - Permission denied -->',
      );
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should respect max depth limit', async () => {
      const content = 'Content @./deep.md more content';
      serve('Deep @./deeper.md content');
      const result = await processImports(content, BASE, {
        processedFiles: new Set<string>(),
        maxDepth: 1,
        currentDepth: 1,
      });
      expect(console.warn).not.toHaveBeenCalled();
      expect(result.content).toBe(content);
    });

    it('should handle absolute paths in imports', async () => {
      serve('Absolute path content');
      const result = await processImports(
        'Content @/absolute/path/file.md more content',
        BASE,
      );
      expect(result.content).toContain(
        '<!-- Import failed: /absolute/path/file.md - Path traversal attempt -->',
      );
    });

    // Puts the middle lines between two real imports, which must be inlined.
    async function importAround(...middle: string[]) {
      serve('Imported 1', 'Imported 2');
      const { content } = await inProject(
        [
          'Normal content @./should-import.md',
          ...middle,
          'More content @./should-import2.md',
        ].join('\n'),
      );
      expect(content)
        .toBe(`Normal content <!-- Imported from: ./should-import.md -->
Imported 1
<!-- End of import from: ./should-import.md -->
${middle.join('\n')}
More content <!-- Imported from: ./should-import2.md -->
Imported 2
<!-- End of import from: ./should-import2.md -->`);
    }

    it('should ignore imports inside code blocks', async () => {
      await importAround(
        '```',
        'code block with @./should-not-import.md',
        '```',
      );
    });

    it('should ignore imports inside inline code', async () => {
      await importAround('`code with import @./should-not-import.md`');
    });

    it('should handle nested tokens and non-unique content correctly', async () => {
      // Guards findCodeRegions: it walks the token tree recursively and copes
      // with the same code text appearing twice.
      await importAround(
        'Paragraph with `inline code @./should-not-import.md` and more text.',
        'Another paragraph with the same `inline code @./should-not-import.md` text.',
      );
    });

    it('should not process imports in repeated inline code blocks', async () => {
      const content = '`@noimport` and `@noimport`';
      expect((await inProject(content)).content).toBe(content);
    });

    it('should not import when @ is inside an inline code block', async () => {
      const content =
        'We should not ` @import` when the symbol is inside an inline code string.';
      const result = await processImports(content, ROOT);
      expect(result.content).toBe(content);
      expect(result.importTree.imports).toBeUndefined();
    });

    it('should still import valid paths while ignoring non-existent paths', async () => {
      // ./valid.md exists, 中文路径 does not and stays as-is.
      mockedFs.access
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(fsError('ENOENT', 'ENOENT'));
      mockedFs.readFile.mockResolvedValue('Valid imported content');
      const result = await processImports(
        '使用 @./valid.md 文件和 @中文路径 注解',
        BASE,
      );
      expectContains(
        result.content,
        'Valid imported content',
        '<!-- Imported from: ./valid.md -->',
        '@中文路径',
      );
    });

    it('should import Chinese file names if they exist', async () => {
      serve('这是中文文档的内容');
      const result = await inProject('导入 @./中文文档.md 文件');
      expectContains(
        result.content,
        '这是中文文档的内容',
        '<!-- Imported from: ./中文文档.md -->',
      );
    });

    it('should allow imports from parent and subdirectories within project root', async () => {
      serve('Parent file content', 'Subdir file content');
      const result = await inProject(
        'Parent import: @../parent.md Subdir import: @./components/sub.md',
      );
      expectContains(
        result.content,
        'Parent file content',
        'Subdir file content',
      );
    });

    it('should reject imports outside project root', async () => {
      const result = await inProject('Outside import: @../../../etc/passwd');
      expect(result.content).toContain(
        '<!-- Import failed: ../../../etc/passwd - Path traversal attempt -->',
      );
    });

    it('should build import tree structure', async () => {
      serve('Nested @./inner.md content', 'Simple content', 'Inner content');
      const result = await processImports(
        'Main content @./nested.md @./simple.md',
        SRC,
      );

      expect(result.content)
        .toBe(`Main content <!-- Imported from: ./nested.md -->
Nested <!-- Imported from: ./inner.md -->
Simple content
<!-- End of import from: ./inner.md --> content
<!-- End of import from: ./nested.md --> <!-- Imported from: ./simple.md -->
Inner content
<!-- End of import from: ./simple.md -->`);

      // No currentFile, so the root is 'unknown'. toContain on paths tolerates
      // absolute/relative differences.
      const tree = result.importTree;
      expect(tree.path).toBe('unknown');
      expect(tree.imports).toHaveLength(2);
      const [nested, simple] = tree.imports!;
      expect(nested.path).toContain(testPath(SRC, 'nested.md'));
      expect(nested.imports).toHaveLength(1);
      expect(nested.imports![0].path).toContain(testPath(SRC, 'inner.md'));
      expect(nested.imports![0].imports).toBeUndefined();
      expect(simple.path).toContain(testPath(SRC, 'simple.md'));
      expect(simple.imports).toBeUndefined();
    });

    it('should produce flat output in Claude-style with unique files in order', async () => {
      serve('Nested @./inner.md content', 'Simple content', 'Inner content');
      const { content } = await inProject(
        'Main @./nested.md content @./simple.md',
        'flat',
      );
      expect(content).toBe(`--- File: ${path.resolve(SRC)} ---
Main @./nested.md content @./simple.md
--- End of File: ${path.resolve(SRC)} ---

--- File: ${path.resolve(SRC, 'simple.md')} ---
Nested @./inner.md content
--- End of File: ${path.resolve(SRC, 'simple.md')} ---

--- File: ${path.resolve(SRC, 'inner.md')} ---
Simple content
--- End of File: ${path.resolve(SRC, 'inner.md')} ---

--- File: ${path.resolve(SRC, 'nested.md')} ---
Inner content
--- End of File: ${path.resolve(SRC, 'nested.md')} ---`);
    });

    it('should not duplicate files in flat output if imported multiple times', async () => {
      serve('Duplicated content');
      const { content } = await inProject(
        'Main @./dup.md again @./dup.md',
        'flat',
      );
      expect(mockedFs.readFile).toHaveBeenCalledTimes(1);
      // The body is present exactly once.
      const firstIndex = content.indexOf('Duplicated content');
      expect(firstIndex).toBeGreaterThan(-1);
      expect(firstIndex).toBe(content.lastIndexOf('Duplicated content'));
    });

    // chain0 -> chain1 -> ..., each importing the next. Returns the indexes of
    // the CHAINn bodies that reached the output.
    async function chainMarkers(
      format: 'flat' | 'tree',
      maxDepth: number,
      currentDepth: number,
      length = 8,
    ) {
      mockedFs.access.mockReset();
      mockedFs.readFile.mockReset();
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockImplementation(async (file: unknown) => {
        const index = Number(
          path.basename(String(file), '.md').replace('chain', ''),
        );
        return index < length - 1
          ? `CHAIN${index} @./chain${index + 1}.md`
          : `CHAIN${index}`;
      });
      const { content } = await processImports(
        'Root @./chain0.md',
        SRC,
        { processedFiles: new Set(), maxDepth, currentDepth },
        ROOT,
        format,
      );
      return [...Array(length).keys()].filter((i) =>
        content.includes(`CHAIN${i}`),
      );
    }

    it('stops expanding a flat import chain at maxDepth', async () => {
      // The root is depth 0, so chain0..chain2 sit at depths 1..3 and chain2 is
      // the last file allowed to expand its own imports.
      expect(await chainMarkers('flat', 3, 0)).toEqual([0, 1, 2]);
    });

    it('applies the same depth limit in flat and tree formats', async () => {
      expect(await chainMarkers('flat', 3, 0)).toEqual(
        await chainMarkers('tree', 3, 0),
      );
    });

    it('spends the same budget in both formats when depth is already partly used', async () => {
      // Entering with 2 of 3 levels already spent leaves one level of budget.
      // The flat path used to start its own counter at 0 and hand out the
      // full limit again, so it expanded two levels further than tree mode.
      const flat = await chainMarkers('flat', 3, 2);
      expect(flat).toEqual(await chainMarkers('tree', 3, 2));
      expect(flat).toEqual([0]);
    });

    it('fully expands a flat import chain that stays within maxDepth', async () => {
      // Passes both before and after the depth guard, on purpose: it pins the
      // other half of the contract so the limit can never be enforced by
      // truncating chains that were always allowed.
      expect(await chainMarkers('flat', 5, 0, 3)).toEqual([0, 1, 2]);
    });

    // Root imports x.md directly and via deep0 -> deep1 -> x.md; x.md imports
    // y.md. deep0.md is listed last, so the reverse iteration takes the deep
    // route to x.md first and lands on it exactly at the limit, truncating it.
    function importDeepRoute(options?: ProcessImportsOptions) {
      const bodies: Record<string, string> = {
        'deep0.md': 'DEEP0 @./deep1.md',
        'deep1.md': 'DEEP1 @./x.md',
        'x.md': 'XFILE @./y.md',
        'y.md': 'YFILE',
      };
      mockedFs.access.mockReset();
      mockedFs.readFile.mockReset();
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockImplementation(
        async (file: unknown) => bodies[path.basename(String(file))] ?? '',
      );
      return processImports(
        'Root @./x.md @./deep0.md',
        SRC,
        { processedFiles: new Set(), maxDepth: 3, currentDepth: 0 },
        ROOT,
        'flat',
        options,
      );
    }

    it('re-expands a file first reached by a route at the depth limit', async () => {
      const { content } = await importDeepRoute();
      // x.md is also a direct import of the root at depth 1, so y.md sits well
      // inside the limit and has to survive the deep route having got there
      // first. Tracking a bare "seen" set instead of the depth dropped it.
      expect(content).toContain('YFILE');
      // The shallower re-expansion must not emit x.md a second time.
      expect(content.match(/XFILE/g)).toHaveLength(1);
    });

    it('notifies once for a file a shallower route re-expands', async () => {
      const { seen, onFileImported } = recorder();
      await importDeepRoute({ onFileImported });
      // The notification means "this instruction file was loaded", and x.md is
      // emitted into the flat output once however many routes reach it, so it
      // must be announced once too. Nothing downstream de-duplicates:
      // onFileImported feeds notifyInstructionsLoaded in memoryDiscovery, which
      // forwards every call straight to the consumer.
      const announced = seen.map((event) => path.basename(event.filePath));
      expect(announced.filter((name) => name === 'x.md')).toHaveLength(1);
      // Every other file is announced exactly once as well.
      expect([...announced].sort()).toEqual([
        'deep0.md',
        'deep1.md',
        'x.md',
        'y.md',
      ]);
    });
  });

  describe('validateImportPath', () => {
    const base = path.resolve(testPath('base'));
    const allowed = path.resolve(testPath('allowed'));
    const forbidden = path.resolve(testPath('forbidden'));
    const valid = (p: string, allowedPaths: string[], basePath = base) =>
      validateImportPath(p, basePath, allowedPaths);

    it('should reject URLs', () => {
      for (const url of [
        'https://example.com/file.md',
        'http://example.com/file.md',
        'file:///path/to/file.md',
      ]) {
        expect(valid(url, [testPath('allowed')], testPath('base'))).toBe(false);
      }
    });

    it('should allow paths within allowed directories', () => {
      expect(valid('./file.md', [base])).toBe(true);
      // Parent access is fine when the parent is allowed (only testable when
      // base is not a filesystem root).
      const parentPath = path.dirname(base);
      if (parentPath !== base) {
        expect(valid('../file.md', [parentPath])).toBe(true);
        expect(valid('sub', [base])).toBe(true);
      }
      expect(valid(path.join(allowed, 'nested', 'file.md'), [allowed])).toBe(
        true,
      );
    });

    it('should reject paths outside allowed directories', () => {
      expect(valid(forbidden, [allowed])).toBe(false);
      const toForbidden = path.relative(base, path.join(forbidden, 'file.md'));
      expect(valid(toForbidden, [allowed])).toBe(false);
      // Escaping the base directory.
      const escaping = path.join('..', '..', 'sensitive', 'file.md');
      expect(valid(escaping, [base])).toBe(false);
    });

    it('should handle multiple allowed directories', () => {
      const both = [
        path.resolve(testPath('allowed1')),
        path.resolve(testPath('allowed2')),
      ];
      const [file1, file2] = both.map((dir) =>
        path.join(dir, 'nested', 'file.md'),
      );
      expect(valid(path.resolve(testPath('other', 'file.md')), both)).toBe(
        false,
      );
      expect(valid(file1, both)).toBe(true);
      expect(valid(file2, both)).toBe(true);
      expect(valid(path.relative(base, file1), both)).toBe(true);
    });

    it('should handle relative paths correctly', () => {
      const parentPath = path.resolve(testPath('parent'));
      expect(valid('file.md', [base])).toBe(true);
      expect(valid('./file.md', [base])).toBe(true);
      // A parent file is blocked unless the parent is allowed.
      const toParent = path.relative(base, path.join(parentPath, 'file.md'));
      expect(valid(toParent, [base])).toBe(false);
      expect(valid(toParent, [base, parentPath])).toBe(true);
      expect(valid(path.join('nested', 'sub', 'file.md'), [base])).toBe(true);
    });

    it('should handle absolute paths correctly', () => {
      const allowedFile = path.join(allowed, 'file.md');
      expect(valid(allowedFile, [allowed])).toBe(true);
      expect(valid(path.join(allowed, 'nested', 'file.md'), [allowed])).toBe(
        true,
      );
      expect(valid(path.join(forbidden, 'file.md'), [allowed])).toBe(false);
      expect(valid(path.relative(base, allowedFile), [allowed])).toBe(true);
      // Same file reached via different relative segments.
      const dotPath = path.join('.', '..', path.basename(allowed), 'file.md');
      expect(valid(dotPath, [allowed])).toBe(true);
    });
  });
});
