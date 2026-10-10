/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SkillActivationRegistry,
  resolveProjectRelativePath,
  splitConditionalSkills,
} from './skill-activation.js';
import type { SkillConfig } from './types.js';

function makeSkill(overrides: Partial<SkillConfig>): SkillConfig {
  return {
    name: overrides.name ?? 'test-skill',
    description: overrides.description ?? 'desc',
    body: overrides.body ?? '',
    level: overrides.level ?? 'project',
    filePath: overrides.filePath ?? '/proj/.qwen/skills/test/SKILL.md',
    ...overrides,
  };
}

/** Registry over one `makeSkill` per entry, rooted at `/project` by default. */
function registry(skills: Array<Partial<SkillConfig>>, root = '/project') {
  return new SkillActivationRegistry(skills.map(makeSkill), root);
}

describe('splitConditionalSkills', () => {
  it('treats skills without paths as unconditional', async () => {
    const skills = [makeSkill({ name: 'a' })];
    const { unconditional, conditional } = splitConditionalSkills(skills);
    expect(unconditional).toHaveLength(1);
    expect(conditional).toHaveLength(0);
  });

  it('treats empty paths array as unconditional', async () => {
    const skills = [makeSkill({ name: 'a', paths: [] })];
    const { unconditional, conditional } = splitConditionalSkills(skills);
    expect(unconditional).toHaveLength(1);
    expect(conditional).toHaveLength(0);
  });

  it('classifies skills with non-empty paths as conditional', async () => {
    const skills = [
      makeSkill({ name: 'a' }),
      makeSkill({ name: 'b', paths: ['src/**/*.tsx'] }),
    ];
    const { unconditional, conditional } = splitConditionalSkills(skills);
    expect(unconditional.map((s) => s.name)).toEqual(['a']);
    expect(conditional.map((s) => s.name)).toEqual(['b']);
  });
});

describe('SkillActivationRegistry', () => {
  const tsxHelper = () =>
    registry([{ name: 'tsx-helper', paths: ['src/**/*.tsx'] }]);

  it('returns empty when no conditional skills are registered', async () => {
    const reg = registry([]);
    expect(await reg.matchAndConsume('/project/src/App.tsx')).toEqual([]);
    expect(reg.totalCount).toBe(0);
  });

  it('activates a conditional skill when a matching path is touched', async () => {
    const reg = tsxHelper();
    const newly = await reg.matchAndConsume('/project/src/App.tsx');
    expect(newly).toEqual(['tsx-helper']);
    expect(reg.isActivated('tsx-helper')).toBe(true);
    expect(reg.activatedCount).toBe(1);
  });

  it('does not re-activate an already-active skill on subsequent matches', async () => {
    const reg = tsxHelper();
    expect(await reg.matchAndConsume('/project/src/A.tsx')).toEqual([
      'tsx-helper',
    ]);
    // Second touch of the same pattern returns nothing new.
    expect(await reg.matchAndConsume('/project/src/B.tsx')).toEqual([]);
    expect(reg.activatedCount).toBe(1);
  });

  it('returns empty for paths that do not match any skill', async () => {
    const reg = tsxHelper();
    expect(await reg.matchAndConsume('/project/lib/utils.py')).toEqual([]);
  });

  it('activates multiple skills whose globs overlap on a single file', async () => {
    const reg = registry([
      { name: 'tsx-helper', paths: ['src/**/*.tsx'] },
      { name: 'app-helper', paths: ['src/App.tsx'] },
    ]);
    const newly = await reg.matchAndConsume('/project/src/App.tsx');
    expect(newly.sort()).toEqual(['app-helper', 'tsx-helper']);
  });

  it('accepts relative file paths by resolving against the project root', async () => {
    const reg = tsxHelper();
    expect(await reg.matchAndConsume('src/App.tsx')).toEqual(['tsx-helper']);
  });

  it('ignores paths outside the project root', async () => {
    const reg = tsxHelper();
    expect(await reg.matchAndConsume('/other/project/src/App.tsx')).toEqual([]);
    expect(reg.activatedCount).toBe(0);
  });

  it('supports multiple glob patterns per skill (OR semantics)', async () => {
    const reg = registry([
      { name: 'multi', paths: ['src/**/*.tsx', 'test/**/*.ts'] },
    ]);
    // Both patterns should activate the same skill, but only once total.
    expect(await reg.matchAndConsume('/project/test/foo.ts')).toEqual([
      'multi',
    ]);
    expect(await reg.matchAndConsume('/project/src/Bar.tsx')).toEqual([]);
  });

  it('activates broad globs on dotfiles too (dot: true semantics)', async () => {
    // Regression: picomatch `dot: false` silently excluded `.eslintrc.js`,
    // `.env`, `.github/*.yml` from broad globs. Activation means "the model
    // touched a matching file"; gitignore-style hidden-file exclusion is wrong.
    const reg = registry([{ name: 'lint-helper', paths: ['**/*.js'] }]);
    expect(await reg.matchAndConsume('/project/.eslintrc.js')).toEqual([
      'lint-helper',
    ]);
  });

  it('survives an invalid picomatch pattern (drops it, keeps the rest)', async () => {
    // Regression: picomatch throws on pathological patterns (oversized
    // strings, broken extglob nesting), which used to escape the constructor
    // and abort skill loading. Now the bad pattern is dropped with a debug log
    // and the rest still compile. ~70 KB exceeds picomatch's 65,536-char limit.
    const bigPattern = 'a'.repeat(70_000);
    const reg = registry([
      { name: 'mixed', paths: [bigPattern, 'src/**/*.ts'] },
    ]);
    expect(reg.totalCount).toBe(1);
    // The good pattern still works.
    expect(await reg.matchAndConsume('/project/src/App.ts')).toEqual(['mixed']);
  });

  it('rejects an absolute relative path (Windows cross-drive case)', async () => {
    // Regression: on Windows `path.relative('C:\\project', 'D:\\other')` is
    // absolute (`D:\\other`); after backslash normalization broad globs like
    // `**/*.ts` false-matched, so absolute relative paths must be rejected
    // before normalization. On POSIX this scenario hits the `..` guard
    // instead; either way paths outside the project root must return [].
    const reg = registry([{ name: 'broad', paths: ['**/*.ts'] }]);
    expect(await reg.matchAndConsume('/totally/other/place/file.ts')).toEqual(
      [],
    );
    expect(reg.activatedCount).toBe(0);
  });
});

describe('resolveProjectRelativePath', () => {
  // Pure helper, exercised directly with `path.win32` so the Windows-specific
  // cross-drive branch is testable on POSIX CI runners.
  it.each([
    [
      'returns the forward-slash-normalized relative path for in-project files (POSIX)',
      '/project/src/App.tsx',
      '/project',
      path.posix,
      'src/App.tsx',
    ],
    [
      'returns null for paths outside the project root (POSIX, `..` prefix)',
      '/elsewhere/foo.ts',
      '/project',
      path.posix,
      null,
    ],
    // Direct exercise of the `path.isAbsolute(rawRelativePath)` branch:
    // `path.win32.relative('C:\\project', 'D:\\other\\file.ts')` is absolute;
    // without the guard the helper would return `D:/other/file.ts`, which
    // false-matches a broad glob such as `**/*.ts`.
    [
      'returns null for Windows cross-drive paths (different drive letter)',
      'D:\\other\\file.ts',
      'C:\\project',
      path.win32,
      null,
    ],
    [
      'normalizes backslashes for in-project Windows paths',
      'C:\\project\\src\\App.tsx',
      'C:\\project',
      path.win32,
      'src/App.tsx',
    ],
  ])('%s', (_title, file, root, pathImpl, expected) => {
    expect(resolveProjectRelativePath(file, root, pathImpl)).toBe(expected);
  });
});

describe('extractToolFilePaths → SkillActivationRegistry integration', () => {
  // These tests `await import('../core/coreToolScheduler.js')` just to reach
  // one pure helper, but that drags in the whole scheduler module graph cold.
  // Under a contended CI runner, that can cross the 5s default timeout.

  // Regression: feed the real candidate output for a `glob` call into the
  // registry end-to-end. The earlier per-field extraction (path and pattern as
  // separate candidates) silently failed to activate skills keyed on the
  // joined effective selector, and no test exercised that path.
  async function activateFromGlob(
    globArgs: { path: string; pattern: string },
    skill: Partial<SkillConfig>,
  ): Promise<Set<string>> {
    const { extractToolFilePaths } = await import(
      '../core/coreToolScheduler.js'
    );
    const candidates = extractToolFilePaths('glob', globArgs);
    const reg = registry([skill]);
    // Hand each candidate to the registry the way coreToolScheduler does;
    // collect the union.
    const activated = new Set<string>();
    for (const c of candidates) {
      for (const n of await reg.matchAndConsume(c)) activated.add(n);
    }
    return activated;
  }

  it('activates a skill keyed on src/**/*.ts from glob({ path: "src", pattern: "**/*.ts" })', async () => {
    const activated = await activateFromGlob(
      { path: 'src', pattern: '**/*.ts' },
      { name: 'tsx-helper', paths: ['src/**/*.ts'] },
    );
    expect(Array.from(activated)).toEqual(['tsx-helper']);
  }, 30_000);

  it('does NOT activate from external glob.path (project-root guard wins)', async () => {
    const activated = await activateFromGlob(
      { path: '/tmp/external', pattern: '**/*.ts' },
      { name: 'broad', paths: ['**/*.ts'] },
    );
    expect(activated.size).toBe(0);
  }, 30_000);

  const tempRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'symlink-test-'));

  it.skipIf(process.platform === 'win32')(
    'activates skills when file is reached via symlinked directory',
    async () => {
      const testRoot = await tempRoot();
      const projectRoot = path.join(testRoot, 'project');
      const srcDir = path.join(projectRoot, 'src');
      await fs.mkdir(srcDir, { recursive: true });
      const symlinkDir = path.join(projectRoot, 'symlink-to-src');
      await fs.symlink(srcDir, symlinkDir);
      // Create the actual file so realpath can resolve it
      await fs.writeFile(path.join(srcDir, 'App.tsx'), '// test');

      const reg = registry(
        [{ name: 'tsx-helper', paths: ['src/**/*.tsx'] }],
        projectRoot,
      );
      // Access file via symlinked path
      const result = await reg.matchAndConsume(
        path.join(symlinkDir, 'App.tsx'),
      );
      expect(result).toEqual(['tsx-helper']);

      await fs.rm(testRoot, { recursive: true, force: true });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'activates skills when project root itself is a symlink',
    async () => {
      const testRoot = await tempRoot();
      const realProject = path.join(testRoot, 'real-project');
      await fs.mkdir(realProject, { recursive: true });
      const srcDir = path.join(realProject, 'src');
      await fs.mkdir(srcDir, { recursive: true });
      const symlinkProject = path.join(testRoot, 'symlink-project');
      await fs.symlink(realProject, symlinkProject);
      // Create the actual file so realpath can resolve it
      await fs.writeFile(path.join(srcDir, 'foo.ts'), '// test');

      const reg = registry(
        [{ name: 'ts-helper', paths: ['src/**/*.ts'] }],
        symlinkProject,
      );
      const result = await reg.matchAndConsume(
        path.join(symlinkProject, 'src', 'foo.ts'),
      );
      expect(result).toEqual(['ts-helper']);

      await fs.rm(testRoot, { recursive: true, force: true });
    },
  );
});
