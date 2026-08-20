/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
  const projectRoot = '/project';

  it('returns empty when no conditional skills are registered', async () => {
    const reg = new SkillActivationRegistry([], projectRoot);
    expect(await reg.matchAndConsume('/project/src/App.tsx')).toEqual([]);
    expect(reg.totalCount).toBe(0);
  });

  it('activates a conditional skill when a matching path is touched', async () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    const newly = await reg.matchAndConsume('/project/src/App.tsx');
    expect(newly).toEqual(['tsx-helper']);
    expect(reg.isActivated('tsx-helper')).toBe(true);
    expect(reg.activatedCount).toBe(1);
  });

  it('does not re-activate an already-active skill on subsequent matches', async () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(await reg.matchAndConsume('/project/src/A.tsx')).toEqual([
      'tsx-helper',
    ]);
    // Second touch of the same pattern returns nothing new.
    expect(await reg.matchAndConsume('/project/src/B.tsx')).toEqual([]);
    expect(reg.activatedCount).toBe(1);
  });

  it('returns empty for paths that do not match any skill', async () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(await reg.matchAndConsume('/project/lib/utils.py')).toEqual([]);
  });

  it('activates multiple skills whose globs overlap on a single file', async () => {
    const reg = new SkillActivationRegistry(
      [
        makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] }),
        makeSkill({ name: 'app-helper', paths: ['src/App.tsx'] }),
      ],
      projectRoot,
    );
    const newly = await reg.matchAndConsume('/project/src/App.tsx');
    expect(newly.sort()).toEqual(['app-helper', 'tsx-helper']);
  });

  it('accepts relative file paths by resolving against the project root', async () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(await reg.matchAndConsume('src/App.tsx')).toEqual(['tsx-helper']);
  });

  it('ignores paths outside the project root', async () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(await reg.matchAndConsume('/other/project/src/App.tsx')).toEqual([]);
    expect(reg.activatedCount).toBe(0);
  });

  it('supports multiple glob patterns per skill (OR semantics)', async () => {
    const reg = new SkillActivationRegistry(
      [
        makeSkill({
          name: 'multi',
          paths: ['src/**/*.tsx', 'test/**/*.ts'],
        }),
      ],
      projectRoot,
    );
    // Both patterns should activate the same skill, but only once total.
    expect(await reg.matchAndConsume('/project/test/foo.ts')).toEqual([
      'multi',
    ]);
    expect(await reg.matchAndConsume('/project/src/Bar.tsx')).toEqual([]);
  });

  it('activates broad globs on dotfiles too (dot: true semantics)', async () => {
    // Regression: picomatch `dot: false` would silently exclude
    // `.eslintrc.js`, `.env`, `.github/*.yml`, etc. from broad globs.
    // Skill activation is "did the model touch a file matching this
    // glob"; the gitignore-style hidden-file exclusion is the wrong
    // semantic for activation.
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'lint-helper', paths: ['**/*.js'] })],
      projectRoot,
    );
    expect(await reg.matchAndConsume('/project/.eslintrc.js')).toEqual([
      'lint-helper',
    ]);
  });

  it('survives an invalid picomatch pattern (drops it, keeps the rest)', async () => {
    // Regression: picomatch can throw on pathological patterns
    // (oversized strings, broken extglob nesting). The constructor
    // previously let that throw escape and abort skill loading
    // entirely. With the try/catch, the bad pattern is dropped with
    // a debug log and the remaining patterns still compile.
    //
    // Use an oversized pattern (~70 KB) — picomatch's default limit
    // is 65,536 chars and it throws above that.
    const bigPattern = 'a'.repeat(70_000);
    const reg = new SkillActivationRegistry(
      [
        makeSkill({
          name: 'mixed',
          paths: [bigPattern, 'src/**/*.ts'],
        }),
      ],
      projectRoot,
    );
    expect(reg.totalCount).toBe(1);
    // The good pattern still works.
    expect(await reg.matchAndConsume('/project/src/App.ts')).toEqual(['mixed']);
  });

  it('rejects an absolute relative path (Windows cross-drive case)', async () => {
    // Regression: on Windows, `path.relative('C:\\project', 'D:\\other')`
    // returns an absolute path like `D:\\other`. After normalizing
    // backslashes to forward slashes, broad globs like `**/*.ts` would
    // false-match. The guard must reject absolute relative paths before
    // normalization.
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'broad', paths: ['**/*.ts'] })],
      projectRoot,
    );
    // Simulate the Node.js Windows cross-drive return value by constructing
    // a candidate that, when path.relative is computed against projectRoot,
    // yields an absolute path. On POSIX runners this same scenario manifests
    // as the existing `..` guard; on Windows the new isAbsolute branch
    // catches it. Either way the registry must return [] for paths outside
    // the project root regardless of platform.
    expect(await reg.matchAndConsume('/totally/other/place/file.ts')).toEqual(
      [],
    );
    expect(reg.activatedCount).toBe(0);
  });
});

describe('resolveProjectRelativePath', () => {
  // Pure helper, exercised directly so the Windows-specific cross-drive
  // branch is testable on POSIX CI runners. On a real POSIX host
  // `path.win32` always behaves like Windows path semantics regardless
  // of the host OS.
  it('returns the forward-slash-normalized relative path for in-project files (POSIX)', async () => {
    expect(
      resolveProjectRelativePath(
        '/project/src/App.tsx',
        '/project',
        path.posix,
      ),
    ).toBe('src/App.tsx');
  });

  it('returns null for paths outside the project root (POSIX, `..` prefix)', async () => {
    expect(
      resolveProjectRelativePath('/elsewhere/foo.ts', '/project', path.posix),
    ).toBeNull();
  });

  it('returns null for Windows cross-drive paths (different drive letter)', async () => {
    // Direct exercise of the new `path.isAbsolute(rawRelativePath)`
    // branch. `path.win32.relative('C:\\project', 'D:\\other\\file.ts')`
    // returns an absolute string like `D:\\other\\file.ts` — without the
    // isAbsolute guard, the helper would normalize the backslashes and
    // return `D:/other/file.ts`, which would false-match a broad glob
    // such as `**/*.ts`. Must return null instead.
    expect(
      resolveProjectRelativePath(
        'D:\\other\\file.ts',
        'C:\\project',
        path.win32,
      ),
    ).toBeNull();
  });

  it('normalizes backslashes for in-project Windows paths', async () => {
    expect(
      resolveProjectRelativePath(
        'C:\\project\\src\\App.tsx',
        'C:\\project',
        path.win32,
      ),
    ).toBe('src/App.tsx');
  });
});

describe('extractToolFilePaths → SkillActivationRegistry integration', () => {
  // These tests `await import('../core/coreToolScheduler.js')` just to reach
  // one pure helper, but that drags in the whole scheduler module graph cold.
  // Under a contended CI runner, that can cross the 5s default timeout.

  // Regression: feed the real candidate output for a `glob` call into
  // the registry and assert end-to-end activation. The earlier per-field
  // extraction (path + pattern as separate candidates) silently failed
  // to activate skills keyed on the joined effective selector — there
  // was no test exercising the path that mattered.
  it('activates a skill keyed on src/**/*.ts from glob({ path: "src", pattern: "**/*.ts" })', async () => {
    const { extractToolFilePaths } = await import(
      '../core/coreToolScheduler.js'
    );
    const candidates = extractToolFilePaths('glob', {
      path: 'src',
      pattern: '**/*.ts',
    });
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.ts'] })],
      '/project',
    );
    // Hand each candidate the registry the way coreToolScheduler does;
    // collect the union.
    const activated = new Set<string>();
    for (const c of candidates) {
      for (const n of await reg.matchAndConsume(c)) activated.add(n);
    }
    expect(Array.from(activated)).toEqual(['tsx-helper']);
  }, 30_000);

  it('does NOT activate from external glob.path (project-root guard wins)', async () => {
    const { extractToolFilePaths } = await import(
      '../core/coreToolScheduler.js'
    );
    const candidates = extractToolFilePaths('glob', {
      path: '/tmp/external',
      pattern: '**/*.ts',
    });
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'broad', paths: ['**/*.ts'] })],
      '/project',
    );
    const activated = new Set<string>();
    for (const c of candidates) {
      for (const n of await reg.matchAndConsume(c)) activated.add(n);
    }
    expect(activated.size).toBe(0);
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'activates skills when file is reached via symlinked directory',
    async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const os = await import('node:os');
      const testRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'symlink-test-'),
      );
      const projectRoot = path.join(testRoot, 'project');
      const srcDir = path.join(projectRoot, 'src');
      await fs.mkdir(srcDir, { recursive: true });
      const symlinkDir = path.join(projectRoot, 'symlink-to-src');
      await fs.symlink(srcDir, symlinkDir);

      // Create the actual file so realpath can resolve it
      const realFile = path.join(srcDir, 'App.tsx');
      await fs.writeFile(realFile, '// test');

      const reg = new SkillActivationRegistry(
        [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
        projectRoot,
      );

      // Access file via symlinked path
      const symlinkedFile = path.join(symlinkDir, 'App.tsx');
      const result = await reg.matchAndConsume(symlinkedFile);
      expect(result).toEqual(['tsx-helper']);

      await fs.rm(testRoot, { recursive: true, force: true });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'activates skills when project root itself is a symlink',
    async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const os = await import('node:os');
      const testRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'symlink-test-'),
      );
      const realProject = path.join(testRoot, 'real-project');
      await fs.mkdir(realProject, { recursive: true });
      const srcDir = path.join(realProject, 'src');
      await fs.mkdir(srcDir, { recursive: true });
      const symlinkProject = path.join(testRoot, 'symlink-project');
      await fs.symlink(realProject, symlinkProject);

      // Create the actual file so realpath can resolve it
      const realFile = path.join(srcDir, 'foo.ts');
      await fs.writeFile(realFile, '// test');

      const reg = new SkillActivationRegistry(
        [makeSkill({ name: 'ts-helper', paths: ['src/**/*.ts'] })],
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
