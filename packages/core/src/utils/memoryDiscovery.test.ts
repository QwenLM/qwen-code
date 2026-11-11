/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getGlobalMemoryPaths,
  getEnvironmentMemoryPaths,
  loadJitSubdirectoryMemory,
  stripFrontmatter,
  extractFrontmatterGlobs,
  extractRuleFrontmatterMetadata,
  getUserModelDecisionRuleEntries,
  getEnvironmentModelDecisionRuleEntries,
  renderModelDecisionRuleEntries,
} from './memoryDiscovery.js';
import {
  DEFAULT_CONTEXT_FILENAME,
} from '../tools/memoryTool.js';
import {
  CONFIG_DIR,
  normalizePath,
  homedir as pathsHomedir,
  getConfigHomeDir,
  _resetConfigHomeDirCache,
} from './paths.js';

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(),
  };
});

vi.mock('../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/paths.js')>();
  const pathModule = await import('node:path');
  const osModule = await import('node:os');
  return {
    ...actual,
    normalizePath: (p: string) => {
      const resolved = pathModule.resolve(p);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    },
    homedir: vi.fn(),
    getConfigHomeDir: vi
      .fn()
      .mockReturnValue(pathModule.join(osModule.tmpdir(), actual.CONFIG_DIR)),
  };
});

describe('stripFrontmatter', () => {
  it('removes only the leading frontmatter block, preserving the body', () => {
    const input = '---\npaths:\n  - src/x/**\n---\n# Rule\nBody\n';
    expect(stripFrontmatter(input)).toBe('# Rule\nBody\n');
  });

  it('returns content unchanged when there is no frontmatter', () => {
    const input = '# Rule\nBody with --- dashes\n';
    expect(stripFrontmatter(input)).toBe(input);
  });

  it('does not strip a "---" that is not a leading frontmatter block', () => {
    // A horizontal rule / code-block fence further down must survive.
    const input = '# Rule\n\nSome text\n\n---\n\nMore text\n';
    expect(stripFrontmatter(input)).toBe(input);
  });

  it('strips a frontmatter block that has no recognized keys', () => {
    const input = '---\nfoo: bar\n---\nBody\n';
    expect(stripFrontmatter(input)).toBe('Body\n');
  });
});

describe('rule frontmatter metadata', () => {
  it('treats missing routing frontmatter as always-on', () => {
    expect(extractRuleFrontmatterMetadata('# Rule\nBody\n')).toEqual({
      trigger: 'always_on',
    });
  });

  it('supports desktop always-on and manual compatibility fields', () => {
    expect(
      extractRuleFrontmatterMetadata('---\ntrigger: always_on\n---\nBody\n'),
    ).toEqual({ trigger: 'always_on' });
    expect(
      extractRuleFrontmatterMetadata('---\nalwaysApply: true\n---\nBody\n'),
    ).toEqual({ trigger: 'always_on' });
    expect(
      extractRuleFrontmatterMetadata('---\ntrigger: manual\n---\nBody\n'),
    ).toEqual({ trigger: 'manual' });
    expect(
      extractRuleFrontmatterMetadata('---\nalwaysApply: false\n---\nBody\n'),
    ).toEqual({ trigger: 'manual' });
  });

  it('requires trigger and description for model-decision rules', () => {
    expect(
      extractRuleFrontmatterMetadata(
        '---\ntrigger: model_decision\ndescription: Use for API work\n---\nBody\n',
      ),
    ).toEqual({
      trigger: 'model_decision',
      description: 'Use for API work',
    });

    expect(
      extractRuleFrontmatterMetadata(
        '---\ntrigger: model_decision\n---\nBody\n',
      ),
    ).toEqual({ trigger: 'manual' });
  });

  it('supports desktop glob rules and legacy paths rules', () => {
    expect(
      extractFrontmatterGlobs(
        '---\ntrigger: glob\nglob:\n  - src/**/*.ts\n---\nBody\n',
      ),
    ).toEqual(['src/**/*.ts']);
    expect(
      extractFrontmatterGlobs('---\npaths: docs/**\n---\nBody\n'),
    ).toEqual(['docs']);
  });
});

describe('memoryDiscovery', () => {
  let testRootDir: string;
  let homedir: string;

  async function createEmptyDir(fullPath: string) {
    await fsPromises.mkdir(fullPath, { recursive: true });
    return normalizePath(fullPath);
  }

  async function createTestFile(fullPath: string, fileContents: string) {
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, fileContents);
    return normalizePath(path.resolve(testRootDir, fullPath));
  }

  beforeEach(async () => {
    testRootDir = normalizePath(
      await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'folder-structure-test-'),
      ),
    );

    vi.resetAllMocks();
    // Set environment variables to indicate test environment
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', 'true');

    homedir = await createEmptyDir(path.join(testRootDir, 'userhome'));
    vi.mocked(os.homedir).mockReturnValue(homedir);
    vi.mocked(pathsHomedir).mockReturnValue(homedir);
    vi.mocked(getConfigHomeDir).mockReturnValue(
      normalizePath(path.join(homedir, CONFIG_DIR)),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // Clean up the temporary directory to prevent resource leaks.
    // Use maxRetries option for robust cleanup without race conditions
    await fsPromises.rm(testRootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  describe('getGlobalMemoryPaths', () => {
    it('should find global memory file if it exists', async () => {
      const globalMemoryFile = await createTestFile(
        path.join(homedir, CONFIG_DIR, DEFAULT_CONTEXT_FILENAME),
        'Global memory content',
      );

      const result = await getGlobalMemoryPaths();

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(globalMemoryFile);
    });

    it('should return empty array if global memory file does not exist', async () => {
      const result = await getGlobalMemoryPaths();

      expect(result).toHaveLength(0);
    });

    it('should include unconditional user-scope rules (~/.qwen/rules)', async () => {
      const ruleFile = await createTestFile(
        path.join(homedir, CONFIG_DIR, 'rules', 'style.md'),
        '# Style\nUse tabs.\n',
      );

      const result = await getGlobalMemoryPaths();

      expect(result).toContain(ruleFile);
    });

    it('should discover .md and .mdc rules but exclude backups and other file types', async () => {
      const rulesDir = path.join(homedir, CONFIG_DIR, 'rules');
      const markdownRule = await createTestFile(
        path.join(rulesDir, 'style.md'),
        '# Markdown rule',
      );
      const mdcRule = await createTestFile(
        path.join(rulesDir, 'nested', 'style.mdc'),
        '# MDC rule',
      );
      for (const name of [
        'style.md.bak',
        'style.mdc.bak',
        'style.mdcx',
        'notes.txt',
      ]) {
        await createTestFile(path.join(rulesDir, name), '# Not a rule');
      }

      const result = await getGlobalMemoryPaths();

      expect(new Set(result)).toEqual(new Set([markdownRule, mdcRule]));
    });

    it.each(['md', 'mdc'])(
      'should include desktop always-on user-scope rules (.%s)',
      async (extension) => {
        const triggerRule = await createTestFile(
          path.join(homedir, CONFIG_DIR, 'rules', `trigger-always.${extension}`),
          '---\ntrigger: always_on\n---\n# Always\n',
        );
        const alwaysApplyRule = await createTestFile(
          path.join(homedir, CONFIG_DIR, 'rules', `always-apply.${extension}`),
          '---\nalwaysApply: true\n---\n# Always apply\n',
        );

        const result = await getGlobalMemoryPaths();

        expect(result).toContain(triggerRule);
        expect(result).toContain(alwaysApplyRule);
      },
    );

    it.each(['md', 'mdc'])(
      'should not eagerly load manual user-scope rules (.%s)',
      async (extension) => {
        const triggerManualRule = await createTestFile(
          path.join(homedir, CONFIG_DIR, 'rules', `trigger-manual.${extension}`),
          '---\ntrigger: manual\n---\n# Manual\n',
        );
        const alwaysApplyFalseRule = await createTestFile(
          path.join(homedir, CONFIG_DIR, 'rules', `always-apply-false.${extension}`),
          '---\nalwaysApply: false\n---\n# Manual\n',
        );

        const result = await getGlobalMemoryPaths();

        expect(result).not.toContain(triggerManualRule);
        expect(result).not.toContain(alwaysApplyFalseRule);
      },
    );

    it('should NOT eagerly load conditional user-scope rules (with `paths`)', async () => {
      const condRule = await createTestFile(
        path.join(homedir, CONFIG_DIR, 'rules', 'api.md'),
        '---\npaths:\n  - src/api/**\n---\n# API\n',
      );

      const result = await getGlobalMemoryPaths();

      // Conditional rules load on demand via JIT, not at startup.
      expect(result).not.toContain(condRule);
    });

    it.each(['md', 'mdc'])(
      'should expose model-decision user rules via an index only (.%s)',
      async (extension) => {
        const modelDecisionRule = await createTestFile(
          path.join(homedir, CONFIG_DIR, 'rules', `api-style.${extension}`),
          [
            '---',
            'trigger: model_decision',
            'description: Use for API endpoint changes',
            '---',
            '# API style',
            'Prefer narrow handlers.',
          ].join('\n'),
        );

        const loadedPaths = await getGlobalMemoryPaths();
        const entries = await getUserModelDecisionRuleEntries();
        const rendered = renderModelDecisionRuleEntries(entries);

        expect(loadedPaths).not.toContain(modelDecisionRule);
        expect(entries).toEqual([
          {
            filePath: modelDecisionRule,
            description: 'Use for API endpoint changes',
          },
        ]);
        expect(rendered).toContain(modelDecisionRule);
        expect(rendered).toContain('Use for API endpoint changes');
        expect(rendered).not.toContain('Prefer narrow handlers');
      },
    );
  });

  describe('getEnvironmentMemoryPaths', () => {
    it('should traverse upward from trusted root to git root', async () => {
      // Setup: /temp/parent/repo/.git
      const parentDir = await createEmptyDir(path.join(testRootDir, 'parent'));
      const repoDir = await createEmptyDir(path.join(parentDir, 'repo'));
      await createEmptyDir(path.join(repoDir, '.git'));
      const srcDir = await createEmptyDir(path.join(repoDir, 'src'));

      await createTestFile(
        path.join(parentDir, DEFAULT_CONTEXT_FILENAME),
        'Parent content',
      );
      const repoFile = await createTestFile(
        path.join(repoDir, DEFAULT_CONTEXT_FILENAME),
        'Repo content',
      );
      const srcFile = await createTestFile(
        path.join(srcDir, DEFAULT_CONTEXT_FILENAME),
        'Src content',
      );

      // Trust srcDir. Should load srcFile AND repoFile (git root),
      // but NOT parentFile (above git root).
      const result = await getEnvironmentMemoryPaths([srcDir]);

      expect(result.project).toHaveLength(2);
      expect(result.project).toContain(repoFile);
      expect(result.project).toContain(srcFile);
    });

    it('should fall back to trusted root as ceiling when no .git exists', async () => {
      // Setup: /homedir/docs/notes (no .git anywhere)
      const docsDir = await createEmptyDir(path.join(homedir, 'docs'));
      const notesDir = await createEmptyDir(path.join(docsDir, 'notes'));

      await createTestFile(
        path.join(homedir, DEFAULT_CONTEXT_FILENAME),
        'Home content',
      );
      const docsFile = await createTestFile(
        path.join(docsDir, DEFAULT_CONTEXT_FILENAME),
        'Docs content',
      );

      // No .git, so ceiling falls back to the trusted root itself.
      // notesDir has no GEMINI.md and won't traverse up to docsDir.
      const resultNotes = await getEnvironmentMemoryPaths([notesDir]);
      expect(resultNotes.project).toHaveLength(0);

      // docsDir has a GEMINI.md at the trusted root itself, so it's found.
      const resultDocs = await getEnvironmentMemoryPaths([docsDir]);
      expect(resultDocs.project).toHaveLength(1);
      expect(resultDocs.project[0]).toBe(docsFile);
    });

    it('should deduplicate paths when same root is trusted multiple times', async () => {
      const repoDir = await createEmptyDir(path.join(testRootDir, 'repo'));
      await createEmptyDir(path.join(repoDir, '.git'));

      const repoFile = await createTestFile(
        path.join(repoDir, DEFAULT_CONTEXT_FILENAME),
        'Repo content',
      );

      // Trust repoDir twice.
      const result = await getEnvironmentMemoryPaths([repoDir, repoDir]);

      expect(result.project).toHaveLength(1);
      expect(result.project[0]).toBe(repoFile);
    });

    it('should recognize .git as a file (submodules/worktrees)', async () => {
      const repoDir = await createEmptyDir(
        path.join(testRootDir, 'worktree_repo'),
      );
      // .git as a file, like in submodules and worktrees
      await createTestFile(
        path.join(repoDir, '.git'),
        'gitdir: /some/other/path/.git/worktrees/worktree_repo',
      );
      const srcDir = await createEmptyDir(path.join(repoDir, 'src'));

      const repoFile = await createTestFile(
        path.join(repoDir, DEFAULT_CONTEXT_FILENAME),
        'Repo content',
      );
      const srcFile = await createTestFile(
        path.join(srcDir, DEFAULT_CONTEXT_FILENAME),
        'Src content',
      );

      // Trust srcDir. Should traverse up to repoDir (git root via .git file).
      const result = await getEnvironmentMemoryPaths([srcDir]);

      expect(result.project).toHaveLength(2);
      expect(result.project).toContain(repoFile);
      expect(result.project).toContain(srcFile);
    });

    it('should keep multiple memory files from the same directory adjacent and in order', async () => {
      const dir = await createEmptyDir(
        path.join(testRootDir, 'multi_file_dir'),
      );
      await createEmptyDir(path.join(dir, '.git'));

      const primaryFile = await createTestFile(
        path.join(dir, 'PRIMARY.md'),
        'Primary content',
      );
      const secondaryFile = await createTestFile(
        path.join(dir, 'SECONDARY.md'),
        'Secondary content',
      );

      const result = await getEnvironmentMemoryPaths([dir], [
        'PRIMARY.md',
        'SECONDARY.md',
      ]);

      expect(result.project).toHaveLength(2);
      // Verify order: PRIMARY should come before SECONDARY because they are
      // sorted by path and PRIMARY.md comes before SECONDARY.md alphabetically
      // if in same dir.
      expect(result.project[0]).toBe(primaryFile);
      expect(result.project[1]).toBe(secondaryFile);
    });

    it('should load unconditional project rules from config rules directories', async () => {
      const repoDir = await createEmptyDir(path.join(testRootDir, 'rules_repo'));
      await createEmptyDir(path.join(repoDir, '.git'));
      const srcDir = await createEmptyDir(path.join(repoDir, 'src'));

      const repoFile = await createTestFile(
        path.join(repoDir, DEFAULT_CONTEXT_FILENAME),
        'Repo content',
      );
      const ruleFile = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'testing.md'),
        'Testing rule content',
      );
      const nestedRuleFile = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'nested', 'style.md'),
        'Style rule content',
      );

      const nestedMdcRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'nested', 'legacy.mdc'),
        '---\nalwaysApply: true\n---\nLegacy rule content',
      );

      const result = await getEnvironmentMemoryPaths([srcDir]);

      expect(result.project).toContain(repoFile);
      expect(result.project).toContain(ruleFile);
      expect(result.project).toContain(nestedRuleFile);
      expect(result.project).toContain(nestedMdcRule);
      expect(result.local).toHaveLength(0);
    });

    it('should not eagerly load project rules with paths frontmatter', async () => {
      const repoDir = await createEmptyDir(
        path.join(testRootDir, 'conditional_rules_repo'),
      );
      await createEmptyDir(path.join(repoDir, '.git'));
      const srcDir = await createEmptyDir(path.join(repoDir, 'src'));

      const unconditionalRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'always.md'),
        'Always rule',
      );
      const conditionalRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'typescript.md'),
        ['---', 'paths:', '  - src/**/*.ts', '---', 'TS rule'].join('\n'),
      );

      const result = await getEnvironmentMemoryPaths([srcDir]);

      expect(result.project).toContain(unconditionalRule);
      expect(result.project).not.toContain(conditionalRule);
    });

    it('should apply desktop always-on and manual triggers to project rules', async () => {
      const repoDir = await createEmptyDir(
        path.join(testRootDir, 'desktop_rules_repo'),
      );
      await createEmptyDir(path.join(repoDir, '.git'));
      const srcDir = await createEmptyDir(path.join(repoDir, 'src'));

      const alwaysOnRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'always.md'),
        '---\ntrigger: always_on\n---\nAlways rule',
      );
      const alwaysApplyRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'always-apply.md'),
        '---\nalwaysApply: true\n---\nAlways apply rule',
      );
      const manualRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'manual.md'),
        '---\ntrigger: manual\n---\nManual rule',
      );
      const alwaysApplyFalseRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'always-apply-false.md'),
        '---\nalwaysApply: false\n---\nManual rule',
      );

      const result = await getEnvironmentMemoryPaths([srcDir]);

      expect(result.project).toContain(alwaysOnRule);
      expect(result.project).toContain(alwaysApplyRule);
      expect(result.project).not.toContain(manualRule);
      expect(result.project).not.toContain(alwaysApplyFalseRule);
    });

    it('should expose model-decision project rules via an index only', async () => {
      const repoDir = await createEmptyDir(
        path.join(testRootDir, 'model_decision_rules_repo'),
      );
      await createEmptyDir(path.join(repoDir, '.git'));
      const srcDir = await createEmptyDir(path.join(repoDir, 'src'));

      const modelDecisionRule = await createTestFile(
        path.join(repoDir, CONFIG_DIR, 'rules', 'review.md'),
        [
          '---',
          'trigger: model_decision',
          'description: Use when reviewing TypeScript changes',
          '---',
          '# Review rule',
          'Check exported types.',
        ].join('\n'),
      );

      const loaded = await getEnvironmentMemoryPaths([srcDir]);
      const entries = await getEnvironmentModelDecisionRuleEntries([srcDir]);

      expect(loaded.project).not.toContain(modelDecisionRule);
      expect(entries).toEqual([
        {
          filePath: modelDecisionRule,
          description: 'Use when reviewing TypeScript changes',
        },
      ]);
    });
  });

  describe('loadJitSubdirectoryMemory', () => {
    it('should load JIT memory when target is inside a trusted root', async () => {
      const rootDir = await createEmptyDir(path.join(testRootDir, 'jit_root'));
      await createEmptyDir(path.join(rootDir, '.git'));
      const subDir = await createEmptyDir(path.join(rootDir, 'subdir'));
      const targetFile = path.join(subDir, 'target.txt');

      const subDirMemory = await createTestFile(
        path.join(subDir, DEFAULT_CONTEXT_FILENAME),
        'Subdir JIT content',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe(subDirMemory);
      expect(result.files[0].content).toBe('Subdir JIT content');
    });

    it('should load a matching conditional user-scope rule on demand', async () => {
      const rootDir = await createEmptyDir(path.join(testRootDir, 'jit_root'));
      await createEmptyDir(path.join(rootDir, '.git'));
      const subDir = await createEmptyDir(path.join(rootDir, 'subdir'));
      const targetFile = path.join(subDir, 'target.ts');

      // Glob base for user rules is the trusted root, so `subdir/**` matches.
      const userRule = await createTestFile(
        path.join(homedir, CONFIG_DIR, 'rules', 'subdir-rule.md'),
        '---\npaths:\n  - subdir/**\n---\n# Subdir Rule\n',
      );
      // A non-matching user rule must NOT load.
      const otherRule = await createTestFile(
        path.join(homedir, CONFIG_DIR, 'rules', 'other-rule.md'),
        '---\npaths:\n  - nope/**\n---\n# Other\n',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      const paths = result.files.map((f) => f.path);
      expect(paths).toContain(userRule);
      expect(paths).not.toContain(otherRule);
    });

    it.each(['md', 'mdc'])(
      'should load a matching desktop glob user-scope rule on demand (.%s)',
      async (extension) => {
        const rootDir = await createEmptyDir(
          path.join(testRootDir, 'jit_desktop_user_root'),
        );
        await createEmptyDir(path.join(rootDir, '.git'));
        const subDir = await createEmptyDir(path.join(rootDir, 'subdir'));
        const targetFile = path.join(subDir, 'target.ts');

        const userRule = await createTestFile(
          path.join(homedir, CONFIG_DIR, 'rules', `desktop-glob.${extension}`),
          [
            '---',
            'trigger: glob',
            'glob:',
            '  - subdir/**/*.ts',
            '---',
            '# Desktop glob rule',
          ].join('\n'),
        );
        const manualRule = await createTestFile(
          path.join(homedir, CONFIG_DIR, 'rules', `manual.${extension}`),
          '---\ntrigger: manual\n---\n# Manual\n',
        );

        const result = await loadJitSubdirectoryMemory(
          targetFile,
          [rootDir],
          new Set(),
        );

        const paths = result.files.map((f) => f.path);
        expect(paths).toContain(userRule);
        expect(paths).not.toContain(manualRule);
        expect(result.files.find((file) => file.path === userRule)?.content).toBe(
          '# Desktop glob rule',
        );

        expect(await getGlobalMemoryPaths()).not.toContain(userRule);
        const unmatched = await loadJitSubdirectoryMemory(
          path.join(subDir, 'target.js'),
          [rootDir],
          new Set(),
        );
        expect(unmatched.files.map((file) => file.path)).not.toContain(userRule);
      },
    );

    it('should ignore incomplete desktop glob user rules', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'jit_incomplete_desktop_user_root'),
      );
      await createEmptyDir(path.join(rootDir, '.git'));
      const targetFile = path.join(rootDir, 'target.ts');

      const incompleteRule = await createTestFile(
        path.join(homedir, CONFIG_DIR, 'rules', 'incomplete-glob.md'),
        '---\ntrigger: glob\n---\n# Missing glob\n',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      expect(result.files.map((f) => f.path)).not.toContain(incompleteRule);
    });

    it('should skip JIT memory when target is outside trusted roots', async () => {
      const trustedRoot = await createEmptyDir(
        path.join(testRootDir, 'trusted'),
      );
      const untrustedDir = await createEmptyDir(
        path.join(testRootDir, 'untrusted'),
      );
      const targetFile = path.join(untrustedDir, 'target.txt');

      await createTestFile(
        path.join(untrustedDir, DEFAULT_CONTEXT_FILENAME),
        'Untrusted content',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [trustedRoot],
        new Set(),
      );

      expect(result.files).toHaveLength(0);
    });

    it('should skip already loaded paths', async () => {
      const rootDir = await createEmptyDir(path.join(testRootDir, 'jit_root'));
      await createEmptyDir(path.join(rootDir, '.git'));
      const subDir = await createEmptyDir(path.join(rootDir, 'subdir'));
      const targetFile = path.join(subDir, 'target.txt');

      const rootMemory = await createTestFile(
        path.join(rootDir, DEFAULT_CONTEXT_FILENAME),
        'Root content',
      );
      const subDirMemory = await createTestFile(
        path.join(subDir, DEFAULT_CONTEXT_FILENAME),
        'Subdir content',
      );

      // Simulate root memory already loaded (e.g., by loadEnvironmentMemory)
      const alreadyLoaded = new Set([rootMemory]);

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        alreadyLoaded,
      );

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe(subDirMemory);
      expect(result.files[0].content).toBe('Subdir content');
    });

    it('should deduplicate files in JIT memory loading (same inode)', async () => {
      const rootDir = await createEmptyDir(path.join(testRootDir, 'jit_root'));
      await createEmptyDir(path.join(rootDir, '.git'));
      const subDir = await createEmptyDir(path.join(rootDir, 'subdir'));
      const targetFile = path.join(subDir, 'target.txt');

      const geminiFile = await createTestFile(
        path.join(subDir, 'gemini.md'),
        'JIT memory content',
      );

      const geminiFileLink = path.join(subDir, 'GEMINI.md');
      try {
        await fsPromises.link(geminiFile, geminiFileLink);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('cross-device') ||
          errorMessage.includes('EXDEV') ||
          errorMessage.includes('EEXIST')
        ) {
          return;
        }
        throw error;
      }

      const stats1 = await fsPromises.lstat(geminiFile);
      const stats2 = await fsPromises.lstat(geminiFileLink);
      expect(stats1.ino).toBe(stats2.ino);

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
        ['gemini.md', 'GEMINI.md'],
      );

      expect(result.files).toHaveLength(1);
      expect(result.files[0].content).toBe('JIT memory content');
      const contentMatches =
        result.files[0].content.match(/JIT memory content/g);
      expect(contentMatches).toHaveLength(1);

      try {
        await fsPromises.unlink(geminiFileLink);
      } catch {
        // ignore cleanup errors
      }
    });

    it('should use the deepest trusted root when multiple nested roots exist', async () => {
      const outerRoot = await createEmptyDir(path.join(testRootDir, 'outer'));
      await createEmptyDir(path.join(outerRoot, '.git'));
      const innerRoot = await createEmptyDir(path.join(outerRoot, 'inner'));
      const targetFile = path.join(innerRoot, 'target.txt');

      const outerMemory = await createTestFile(
        path.join(outerRoot, DEFAULT_CONTEXT_FILENAME),
        'Outer content',
      );
      const innerMemory = await createTestFile(
        path.join(innerRoot, DEFAULT_CONTEXT_FILENAME),
        'Inner content',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [outerRoot, innerRoot],
        new Set(),
      );

      // Traversal goes from innerRoot (deepest trusted root) up to outerRoot
      // (git root), so both files are found.
      expect(result.files).toHaveLength(2);
      expect(result.files.find((f) => f.path === innerMemory)).toBeDefined();
      expect(result.files.find((f) => f.path === outerMemory)).toBeDefined();
    });

    it('should resolve file target to its parent directory for traversal', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'jit_file_resolve'),
      );
      await createEmptyDir(path.join(rootDir, '.git'));
      const subDir = await createEmptyDir(path.join(rootDir, 'src'));

      // Create the target file so fs.stat can identify it as a file
      const targetFile = await createTestFile(
        path.join(subDir, 'app.ts'),
        'const x = 1;',
      );

      const subDirMemory = await createTestFile(
        path.join(subDir, DEFAULT_CONTEXT_FILENAME),
        'Src context rules',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      // Should find the GEMINI.md in the same directory as the file
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe(subDirMemory);
      expect(result.files[0].content).toBe('Src context rules');
    });

    it('should handle non-existent file target by using parent directory', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'jit_nonexistent'),
      );
      await createEmptyDir(path.join(rootDir, '.git'));
      const subDir = await createEmptyDir(path.join(rootDir, 'src'));

      // Target file does NOT exist (e.g. write_file creating a new file)
      const targetFile = path.join(subDir, 'new-file.ts');

      const subDirMemory = await createTestFile(
        path.join(subDir, DEFAULT_CONTEXT_FILENAME),
        'Rules for new files',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe(subDirMemory);
      expect(result.files[0].content).toBe('Rules for new files');
    });

    it('should load conditional project rules when paths frontmatter matches accessed file', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'jit_conditional_rules'),
      );
      await createEmptyDir(path.join(rootDir, '.git'));
      const srcDir = await createEmptyDir(path.join(rootDir, 'src'));
      const targetFile = await createTestFile(
        path.join(srcDir, 'app.ts'),
        'const app = true;',
      );

      const matchingRule = await createTestFile(
        path.join(rootDir, CONFIG_DIR, 'rules', 'typescript.md'),
        [
          '---',
          'paths:',
          '  - src/**/*.ts',
          '---',
          'TypeScript-specific rule',
        ].join('\n'),
      );
      const nonMatchingRule = await createTestFile(
        path.join(rootDir, CONFIG_DIR, 'rules', 'docs.md'),
        ['---', 'paths: docs/**', '---', 'Docs rule'].join('\n'),
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      expect(result.files.find((f) => f.path === matchingRule)).toBeDefined();
      expect(
        result.files.find((f) => f.path === matchingRule)?.content,
      ).toContain('TypeScript-specific rule');
      expect(result.files.find((f) => f.path === nonMatchingRule)).toBeUndefined();
    });

    it('should load desktop glob project rules when glob frontmatter matches accessed file', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'jit_desktop_project_rules'),
      );
      await createEmptyDir(path.join(rootDir, '.git'));
      const srcDir = await createEmptyDir(path.join(rootDir, 'src'));
      const targetFile = await createTestFile(
        path.join(srcDir, 'app.ts'),
        'const app = true;',
      );

      const matchingRule = await createTestFile(
        path.join(rootDir, CONFIG_DIR, 'rules', 'typescript.md'),
        [
          '---',
          'trigger: glob',
          'glob: src/**/*.ts',
          '---',
          'TypeScript desktop glob rule',
        ].join('\n'),
      );
      const modelDecisionRule = await createTestFile(
        path.join(rootDir, CONFIG_DIR, 'rules', 'model.md'),
        [
          '---',
          'trigger: model_decision',
          'description: Use for TypeScript files',
          '---',
          'Model decision rule',
        ].join('\n'),
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      const paths = result.files.map((f) => f.path);
      expect(paths).toContain(matchingRule);
      expect(paths).not.toContain(modelDecisionRule);
    });

    it('should fall back to trusted root as ceiling when no git root exists', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'jit_no_git'),
      );
      // No .git directory created — ceiling falls back to trusted root
      const subDir = await createEmptyDir(path.join(rootDir, 'subdir'));
      const targetFile = path.join(subDir, 'target.txt');

      const subDirMemory = await createTestFile(
        path.join(subDir, DEFAULT_CONTEXT_FILENAME),
        'Content without git',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
      );

      // subDir is within the trusted root, so its GEMINI.md is found
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe(subDirMemory);
      expect(result.files[0].content).toBe('Content without git');
    });

    it('should stop at a custom boundary marker instead of .git', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'custom_marker'),
      );
      // Use a custom marker file instead of .git
      await createTestFile(path.join(rootDir, '.monorepo-root'), '');
      const subDir = await createEmptyDir(path.join(rootDir, 'packages/app'));
      const targetFile = path.join(subDir, 'file.ts');

      const rootMemory = await createTestFile(
        path.join(rootDir, DEFAULT_CONTEXT_FILENAME),
        'Root rules',
      );
      const subDirMemory = await createTestFile(
        path.join(subDir, DEFAULT_CONTEXT_FILENAME),
        'App rules',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
        undefined,
        undefined,
        ['.monorepo-root'],
      );

      expect(result.files).toHaveLength(2);
      expect(result.files.find((f) => f.path === rootMemory)).toBeDefined();
      expect(result.files.find((f) => f.path === subDirMemory)).toBeDefined();
    });

    it('should support multiple boundary markers', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'multi_marker'),
      );
      // Use a non-.git marker
      await createTestFile(path.join(rootDir, 'package.json'), '{}');
      const subDir = await createEmptyDir(path.join(rootDir, 'src'));
      const targetFile = path.join(subDir, 'index.ts');

      const rootMemory = await createTestFile(
        path.join(rootDir, DEFAULT_CONTEXT_FILENAME),
        'Root content',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
        undefined,
        undefined,
        ['.git', 'package.json'],
      );

      // Should find the root because package.json is a marker
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe(rootMemory);
    });

    it('should disable parent traversal when boundary markers array is empty', async () => {
      const rootDir = await createEmptyDir(
        path.join(testRootDir, 'empty_markers'),
      );
      await createEmptyDir(path.join(rootDir, '.git'));
      const subDir = await createEmptyDir(path.join(rootDir, 'subdir'));
      const targetFile = path.join(subDir, 'target.txt');

      await createTestFile(
        path.join(rootDir, DEFAULT_CONTEXT_FILENAME),
        'Root content',
      );
      const subDirMemory = await createTestFile(
        path.join(subDir, DEFAULT_CONTEXT_FILENAME),
        'Subdir content',
      );

      const result = await loadJitSubdirectoryMemory(
        targetFile,
        [rootDir],
        new Set(),
        undefined,
        undefined,
        [],
      );

      // With empty markers, no project root is found so the trusted root
      // is used as the ceiling. Traversal still finds files between the
      // target path and the trusted root.
      expect(result.files).toHaveLength(2);
      expect(result.files.find((f) => f.path === subDirMemory)).toBeDefined();
    });
  });

});
