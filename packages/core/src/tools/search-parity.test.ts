/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RipGrepTool } from './ripGrep.js';
import { GlobTool } from './glob.js';
import {
  runWithCwdOverride,
  setCwd,
  resetForTest as resetShellCwd,
} from '../utils/Shell.js';
import type { Config } from '../config/config.js';
import { setTestSessionPermission } from '../test-utils/config.js';
import { PermissionModes, rulesForToolName } from '../permissions/manager/decision/index.js';
import { createGlobToolChecker } from './tool-checkers/checkers/glob-checker.js';

// Exercise the actual rg protocol and process exit codes, not canned search results.
describe('search tool execution contracts', () => {
  let root: string;
  let config: Config;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'search-contract-'));
    resetShellCwd(root);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/a.ts'), 'needle one\nneedle two\n');
    await writeFile(path.join(root, 'src/b.ts'), 'needle three\n');
    config = {
      getTargetDir: () => root,
      getWorkspaceContext: () => ({
        getDirectories: () => [root, '/not-a-search-root'],
      }),
      getDebugMode: () => false,
      getCustomExcludes: () => [],
    } as unknown as Config;
  });
  afterEach(async () => {
    resetShellCwd();
    await rm(root, { recursive: true, force: true });
  });
  const signal = () => new AbortController().signal;

  // Windows does not support the two distinct directory names used by this fixture.
  it.skipIf(process.platform === 'win32')(
    'uses the permission-checked root when an absolute glob directory ends in whitespace',
    async () => {
      const allowed = path.join(root, 'src');
      const outside = allowed + ' ';
      await mkdir(outside);
      await writeFile(path.join(allowed, 'allowed.match'), 'allowed');
      await writeFile(path.join(outside, 'outside.match'), 'outside');
      const input = { pattern: `${outside}/*.match`, path: `${outside}/` };
      const rules = { allow: {}, deny: {}, ask: {} };
      const decision = await createGlobToolChecker(() => allowed).check(input, {
        mode: PermissionModes.Default,
        rules,
        cwd: allowed,
        additionalDirectories: [],
        rulesForTool: rulesForToolName(rules, 'Glob'),
        toolUseId: 'glob-whitespace',
      });
      expect(decision.kind).toBe('allow');
      const result = await new GlobTool(config).build(input).execute(signal());
      expect(result.error).toBeUndefined();
      expect(result.toolUseResult).toMatchObject({
        filenames: ['src/allowed.match'],
      });
    },
  );

  it('paginates a large multiline match without overflowing the decoder stack', async () => {
    const file = path.join(root, 'large.txt');
    await writeFile(file, 'start\n' + 'x\n'.repeat(150000) + 'end\n');
    const result = await new RipGrepTool(config)
      .build({
        pattern: 'start.*end',
        path: file,
        multiline: true,
        output_mode: 'content',
        head_limit: 10,
      })
      .execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.toolUseResult).toMatchObject({
      numLines: 10,
      totalLines: 150002,
      appliedLimit: 10,
      content: [
        '1:start',
        ...Array.from({ length: 9 }, (_, i) => `${i + 2}:x`),
      ].join('\n'),
    });
  });

  it('isolates concurrent agent searches and honours an explicit fixed root', async () => {
    await mkdir(path.join(root, 'other'));
    await writeFile(path.join(root, 'other/c.ts'), 'needle other');
    await runWithCwdOverride(root, async () => {
      await Promise.all(
        ['src', 'other'].map((directory) =>
          runWithCwdOverride(path.join(root, directory), async () => {
            const grep = new RipGrepTool(config);
            const glob = new GlobTool(config);
            for (const result of [
              await grep.build({ pattern: 'needle' }).execute(signal()),
              await glob.build({ pattern: '**/*.ts' }).execute(signal()),
            ]) {
              expect(result.error).toBeUndefined();
              expect(result.llmContent).toContain(
                directory === 'src' ? 'src/a.ts' : 'other/c.ts',
              );
              expect(result.llmContent).not.toContain(
                directory === 'src' ? 'other/c.ts' : 'src/a.ts',
              );
            }
            for (const result of [
              await grep
                .build({ pattern: 'needle', path: root })
                .execute(signal()),
              await glob
                .build({ pattern: '**/*.ts', path: root })
                .execute(signal()),
            ]) {
              expect(result.error).toBeUndefined();
              expect(result.llmContent).toContain('src/a.ts');
              expect(result.llmContent).toContain('other/c.ts');
            }
          }),
        ),
      );
      expect(config.getTargetDir()).toBe(root);
    });
  });

  it.each([true, false])(
    'follows session CWD independently of parallel streaming (%s)',
    async (parallel) => {
      config.isParallelToolStreamingEnabled = () => parallel;
      await writeFile(path.join(root, 'root.txt'), 'needle root');
      await runWithCwdOverride(root, async () => {
        setCwd(path.join(root, 'src'));
        const grep = await new RipGrepTool(config)
          .build({ pattern: 'needle' })
          .execute(signal());
        const glob = await new GlobTool(config)
          .build({ pattern: '**/*' })
          .execute(signal());
        for (const result of [grep, glob]) {
          expect(result.error).toBeUndefined();
          expect(String(result.llmContent)).not.toContain('root.txt');
          expect(result.llmContent).toContain('src/a.ts');
        }
        expect(config.getTargetDir()).toBe(root);
      });
    },
  );

  it.each(['files_with_matches', 'content', 'count'] as const)(
    'distinguishes an exhausted page from no matches in %s mode',
    async (output_mode) => {
      const grep = new RipGrepTool(config);
      const page = await grep
        .build({ pattern: 'needle', output_mode, offset: 100 })
        .execute(signal());
      expect(page.error).toBeUndefined();
      expect(page.llmContent).toContain('No entries at this offset');
      expect(page.llmContent).not.toContain('No matches found');
      if (output_mode === 'files_with_matches')
        expect(page.toolUseResult).toMatchObject({
          totalFiles: 2,
          numFiles: 0,
        });
      if (output_mode === 'content')
        expect(page.toolUseResult).toMatchObject({
          totalLines: 3,
          numLines: 0,
        });
      if (output_mode === 'count')
        expect(page.toolUseResult).toMatchObject({
          numMatches: 3,
          numFiles: 2,
        });
      const empty = await grep
        .build({ pattern: 'absent', output_mode, offset: 100 })
        .execute(signal());
      expect(empty.llmContent).toBe(
        output_mode === 'files_with_matches'
          ? 'No files found'
          : 'No matches found',
      );
    },
  );

  it('accepts ripgrep flags and reports invalid regex/type/glob as errors', async () => {
    const grep = new RipGrepTool(config);
    const result = await grep
      .build({ pattern: '(?i)NEEDLE', output_mode: 'content' })
      .execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('src/a.ts:1:needle one');
    for (const input of [
      { pattern: '(?=needle)' },
      { pattern: 'needle', type: 'not_a_real_file_type' },
    ]) {
      const invalid = await grep.build(input).execute(signal());
      expect(invalid.error).toBeDefined();
      expect(invalid.llmContent).not.toBe('No matches found');
    }
    expect(
      (await new GlobTool(config).build({ pattern: '[' }).execute(signal()))
        .error,
    ).toBeDefined();
  });

  it('counts single files and preserves the global total across pagination', async () => {
    const grep = new RipGrepTool(config);
    const single = await grep
      .build({
        pattern: 'needle',
        path: path.join(root, 'src/a.ts'),
        output_mode: 'count',
      })
      .execute(signal());
    expect(single.llmContent).toContain('src/a.ts:2');
    expect(single.llmContent).toContain(
      'Found 2 total occurrences across 1 file.',
    );
    const page = await grep
      .build({
        pattern: 'needle',
        path: path.join(root, 'src'),
        output_mode: 'count',
        head_limit: 1,
      })
      .execute(signal());
    expect(page.llmContent).toContain(
      'Found 3 total occurrences across 2 files.',
    );
  });

  it('supports match-only output and rejects fractional limits and unknown fields', async () => {
    const grep = new RipGrepTool(config);
    const result = await grep
      .build({
        pattern: 'needle',
        path: path.join(root, 'src/a.ts'),
        output_mode: 'content',
        '-o': true,
        '-n': false,
      })
      .execute(signal());
    expect(result.llmContent).toBe('needle\nneedle');
    expect(() => grep.build({ pattern: '.', head_limit: 1.5 })).toThrow(
      /whole number/,
    );
    expect(() => grep.build({ pattern: '.', offset: -1 })).toThrow();
    expect(() =>
      grep.build({ pattern: '.', unknown: true } as never),
    ).toThrow();
  });

  it('corrects duplicate glob prefixes without hiding actual nested directories', async () => {
    const glob = new GlobTool(config);
    const input = { pattern: 'src/**/*.ts', path: path.join(root, 'src') };
    expect((await glob.build(input).execute(signal())).llmContent).toContain(
      'src/a.ts',
    );
    await mkdir(path.join(root, 'src/src'));
    await writeFile(path.join(root, 'src/src/nested.ts'), 'nested');
    const nested = await glob.build(input).execute(signal());
    expect(nested.llmContent).toBe(path.join('src', 'src', 'nested.ts'));
  });

  it('treats a dash-prefixed single file as a path, not an option', async () => {
    await writeFile(path.join(root, '--'), 'needle');
    const result = await new RipGrepTool(config)
      .build({ pattern: 'needle', path: path.join(root, '--') })
      .execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.toolUseResult).toMatchObject({
      filenames: ['--'],
      numFiles: 1,
    });
  });

  it('searches dependencies by default while preserving custom exclusions', async () => {
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules/dependency.ts'), 'needle');
    expect(
      (
        await new GlobTool(config)
          .build({ pattern: '**/*.ts' })
          .execute(signal())
      ).llmContent,
    ).toContain('node_modules/dependency.ts');
    config.getCustomExcludes = () => ['**/node_modules/**'];
    expect(
      (
        await new GlobTool(config)
          .build({ pattern: '**/*.ts' })
          .execute(signal())
      ).llmContent,
    ).not.toContain('dependency');
    expect(
      (
        await new RipGrepTool(config)
          .build({ pattern: 'needle' })
          .execute(signal())
      ).llmContent,
    ).not.toContain('dependency');
  });

  it('preserves unusual file names and whitespace through structured output', async () => {
    const filename = 'odd:name\npart.ts';
    await writeFile(path.join(root, filename), '  needle  \n\ntrailing\n');
    const glob = await new GlobTool(config)
      .build({ pattern: 'odd*' })
      .execute(signal());
    expect(glob.toolUseResult).toMatchObject({
      numFiles: 1,
      filenames: [filename],
    });
    const grep = new RipGrepTool(config);
    const content = await grep
      .build({
        pattern: 'needle',
        glob: 'odd*',
        output_mode: 'content',
        '-A': 1,
      })
      .execute(signal());
    expect(content.llmContent).toContain(`${filename}:1:  needle  `);
    expect(content.llmContent).toContain(`${filename}-2-`);
    const count = await grep
      .build({ pattern: 'needle', glob: 'odd*', output_mode: 'count' })
      .execute(signal());
    expect(count.llmContent).toContain(`${filename}:1`);
  });

  it('filters Read-denied files before paginating search results', async () => {
    setTestSessionPermission(
      config,
      {
        getRules: () => ({
          allow: {},
          ask: {},
          deny: { projectSettings: [`Read(/src/a.ts)`] },
        }),
        getAdditionalDirectories: () => [],
      } as unknown as Config['permission'],
    );
    const result = await new RipGrepTool(config)
      .build({ pattern: 'needle', output_mode: 'content', head_limit: 1 })
      .execute(signal());
    expect(result.llmContent).not.toContain('a.ts');
    expect(result.llmContent).toContain('src/b.ts');
  });
});
