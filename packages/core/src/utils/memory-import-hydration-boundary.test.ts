/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hydrateExtensionText } from '../extension/variables.js';
import { processImports } from './memoryImportProcessor.js';

describe('managed import hydration boundaries', () => {
  let root: string;
  let managed: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-import-hydration-')),
    );
    managed = path.join(root, 'managed dir');
    await fs.mkdir(managed);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function process(
    content: string,
    format: 'flat' | 'tree',
    maxDepth = 5,
  ) {
    return processImports(
      content,
      managed,
      {
        processedFiles: new Set(),
        maxDepth,
        currentDepth: 0,
        currentFile: path.join(managed, 'QWEN.md'),
      },
      managed,
      format,
      { transformContent: (text) => hydrateExtensionText(text, managed) },
    );
  }

  it.each(['flat', 'tree'] as const)(
    'hydrates a root containing a literal placeholder only once in %s format',
    async (format) => {
      managed = path.join(root, '${extensionPath} dir');
      await fs.mkdir(managed);
      await fs.writeFile(
        path.join(managed, 'included.md'),
        'LITERAL_ROOT_NESTED_WITNESS ${extensionPath}',
      );
      const result = await process(
        'Path ${extensionPath} @${extensionPath}/included.md',
        format,
      );
      expect(result.content).toContain('LITERAL_ROOT_NESTED_WITNESS');
      expect(result.content).toContain(`Path ${managed}`);
      expect(result.content).toContain(
        `LITERAL_ROOT_NESTED_WITNESS ${managed}`,
      );
      expect(result.content).not.toContain(`Path ${root}${path.sep}${root}`);
      expect(result.content).not.toContain('Import failed');
    },
  );

  it.each(['flat', 'tree'] as const)(
    'does not scan hydrated imports inside code in %s format',
    async (format) => {
      await fs.writeFile(
        path.join(managed, 'hidden.md'),
        'CODE_IMPORT_MUST_STAY_UNLOADED',
      );
      const content =
        'Inline `@${extensionPath}/hidden.md`\n```text\n@${extensionPath}/hidden.md\n```';
      const result = await process(content, format);
      expect(result.content).not.toContain('CODE_IMPORT_MUST_STAY_UNLOADED');
      expect(result.content).toContain(`@${managed}/hidden.md`);
    },
  );

  it.each(['flat', 'tree'] as const)(
    'keeps the hydrated path behind traversal validation in %s format',
    async (format) => {
      await fs.writeFile(
        path.join(root, 'outside.md'),
        'OUTSIDE_IMPORT_MUST_STAY_UNLOADED',
      );
      const result = await process('@${extensionPath}/../outside.md', format);
      expect(result.content).not.toContain('OUTSIDE_IMPORT_MUST_STAY_UNLOADED');
      if (format === 'tree')
        expect(result.content).toContain('Path traversal attempt');
    },
  );

  it.each(['flat', 'tree'] as const)(
    'retains import depth while hydrating paths in %s format',
    async (format) => {
      await fs.writeFile(
        path.join(managed, 'first.md'),
        'FIRST_DEPTH_WITNESS @${extensionPath}/second.md',
      );
      await fs.writeFile(
        path.join(managed, 'second.md'),
        'SECOND_DEPTH_MUST_STAY_UNLOADED',
      );
      const result = await process('@${extensionPath}/first.md', format, 1);
      expect(result.content).toContain('FIRST_DEPTH_WITNESS');
      expect(result.content).not.toContain('SECOND_DEPTH_MUST_STAY_UNLOADED');
      expect(result.content).toContain(`@${managed}/second.md`);
    },
  );
});
