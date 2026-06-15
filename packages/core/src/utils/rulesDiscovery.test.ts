/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseRuleFile,
  loadRules,
  ConditionalRulesRegistry,
} from './rulesDiscovery.js';
import { QWEN_DIR, unescapePath } from './paths.js';

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(),
  };
});

describe('rulesDiscovery', () => {
  let testRootDir: string;
  let projectRoot: string;
  let homedir: string;

  async function createTestFile(fullPath: string, content: string) {
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, content);
    return fullPath;
  }

  beforeEach(async () => {
    testRootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'rules-discovery-test-'),
    );

    vi.resetAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', 'true');

    projectRoot = path.join(testRootDir, 'project');
    await fsPromises.mkdir(projectRoot, { recursive: true });
    homedir = path.join(testRootDir, 'userhome');
    await fsPromises.mkdir(homedir, { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(homedir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsPromises.rm(testRootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // parseRuleFile
  // ─────────────────────────────────────────────────────────────────────────

  describe('parseRuleFile', () => {
    it('parses a rule with paths frontmatter', () => {
      const content = `---
description: Frontend rules
paths:
  - "src/**/*.tsx"
  - "src/**/*.ts"
---
Use React functional components.
`;
      const rule = parseRuleFile(content, '/test/rule.md');
      expect(rule).not.toBeNull();
      expect(rule!.description).toBe('Frontend rules');
      expect(rule!.paths).toEqual(['src/**/*.tsx', 'src/**/*.ts']);
      expect(rule!.content).toBe('Use React functional components.');
    });

    it('parses a baseline rule without paths', () => {
      const content = `---
description: General coding standards
---
Always write tests.
`;
      const rule = parseRuleFile(content, '/test/rule.md');
      expect(rule!.paths).toBeUndefined();
      expect(rule!.content).toBe('Always write tests.');
    });

    it('parses a rule without any frontmatter as baseline', () => {
      const rule = parseRuleFile('Plain rules.\n\nParagraph.', '/test/r.md');
      expect(rule!.paths).toBeUndefined();
      expect(rule!.content).toBe('Plain rules.\n\nParagraph.');
    });

    it('strips HTML comments', () => {
      const content = `---
description: Test
---
Visible.
<!-- stripped -->
Also visible.
`;
      const rule = parseRuleFile(content, '/test/rule.md');
      expect(rule!.content).not.toContain('stripped');
      expect(rule!.content).toContain('Visible.');
      expect(rule!.content).toContain('Also visible.');
    });

    it('strips adjacent and residual HTML comment markers', () => {
      // Defensive cases that previously left residual <!-- in the output,
      // flagged by CodeQL as incomplete multi-character sanitization.
      const content = `---
description: Test
---
A<!-- one --><!-- two -->B<!--unclosed
`;
      const rule = parseRuleFile(content, '/test/rule.md');
      expect(rule!.content).not.toContain('<!--');
      expect(rule!.content).toContain('A');
      expect(rule!.content).toContain('B');
    });

    it('returns null for empty body after stripping', () => {
      const content = `---
paths:
  - "*.ts"
---
<!-- Only a comment -->
`;
      expect(parseRuleFile(content, '/test/rule.md')).toBeNull();
    });

    it('handles empty paths array as baseline', () => {
      const content = `---
paths:
---
Some content.
`;
      expect(parseRuleFile(content, '/t.md')!.paths).toBeUndefined();
    });

    it('handles paths as a single string', () => {
      const content = `---
paths: "src/**/*.ts"
---
Rule.
`;
      expect(parseRuleFile(content, '/t.md')!.paths).toEqual(['src/**/*.ts']);
    });

    it('handles BOM and CRLF', () => {
      const content = '\uFEFF---\r\ndescription: BOM\r\n---\r\nContent.\r\n';
      const rule = parseRuleFile(content, '/t.md');
      expect(rule!.description).toBe('BOM');
      expect(rule!.content).toBe('Content.');
    });

    it('treats non-array/non-string paths as baseline', () => {
      const content = `---
paths: 42
---
Body.
`;
      expect(parseRuleFile(content, '/t.md')!.paths).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // loadRules — baseline vs conditional split
  // ─────────────────────────────────────────────────────────────────────────

  describe('loadRules', () => {
    it('returns empty when no rules directory exists', async () => {
      const result = await loadRules(projectRoot, true);
      expect(result).toEqual({
        content: '',
        ruleCount: 0,
        conditionalRules: [],
      });
    });

    it('loads baseline rules into content', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'general.md'),
        `---
description: General
---
Always write tests.`,
      );

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Always write tests.');
      expect(result.conditionalRules).toEqual([]);
    });

    it('puts conditional rules in conditionalRules, not in content', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'fe.md'),
        `---
paths:
  - "src/**/*.tsx"
---
Use hooks.`,
      );

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(0);
      expect(result.content).toBe('');
      expect(result.conditionalRules).toHaveLength(1);
      expect(result.conditionalRules[0].content).toBe('Use hooks.');
    });

    it('splits baseline and conditional correctly', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, '01-general.md'),
        'Write clean code.',
      );
      await createTestFile(
        path.join(rulesDir, '02-py.md'),
        `---\npaths:\n  - "**/*.py"\n---\nUse type hints.`,
      );
      await createTestFile(
        path.join(rulesDir, '03-ts.md'),
        `---\npaths:\n  - "**/*.ts"\n---\nUse strict.`,
      );

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Write clean code.');
      expect(result.conditionalRules).toHaveLength(2);
    });

    it('recursively scans subdirectories', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'frontend', 'react.md'),
        'Use hooks.',
      );
      await createTestFile(
        path.join(rulesDir, 'backend', 'api.md'),
        'Validate inputs.',
      );
      await createTestFile(path.join(rulesDir, 'general.md'), 'Write tests.');

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(3);
      expect(result.content).toContain('Use hooks.');
      expect(result.content).toContain('Validate inputs.');
      expect(result.content).toContain('Write tests.');
    });

    it('skips project rules when folder is untrusted', async () => {
      await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'rules', 'r.md'),
        'Untrusted.',
      );
      const result = await loadRules(projectRoot, false);
      expect(result.ruleCount).toBe(0);
    });

    it('loads global rules even when folder is untrusted', async () => {
      await createTestFile(
        path.join(homedir, QWEN_DIR, 'rules', 'g.md'),
        'Global.',
      );
      const result = await loadRules(projectRoot, false);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Global.');
    });

    it('does not duplicate rules when projectRoot equals homedir', async () => {
      await createTestFile(
        path.join(homedir, QWEN_DIR, 'rules', 's.md'),
        'Shared.',
      );
      const result = await loadRules(homedir, true);
      expect(result.ruleCount).toBe(1);
      expect((result.content.match(/Shared\./g) || []).length).toBe(1);
    });

    it('excludes rules matching exclude patterns', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(path.join(rulesDir, 'keep.md'), 'Keep.');
      const skipped = await createTestFile(
        path.join(rulesDir, 'skip.md'),
        'Skip.',
      );

      const result = await loadRules(projectRoot, true, [skipped]);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Keep.');
      expect(result.content).not.toContain('Skip.');
    });

    it('excludes rules in subdirectories by glob', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'other-team', 'r.md'),
        'Their rule.',
      );
      await createTestFile(path.join(rulesDir, 'mine.md'), 'My rule.');

      const result = await loadRules(projectRoot, true, ['**/other-team/**']);
      expect(result.ruleCount).toBe(1);
      expect(result.content).not.toContain('Their rule.');
    });

    it('formats rules with source markers', async () => {
      await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'rules', 'test.md'),
        'Content.',
      );
      const result = await loadRules(projectRoot, true);
      expect(result.content).toContain(
        `--- Rule from: ${QWEN_DIR}/rules/test.md ---`,
      );
    });

    it('reads global rules from QWEN_HOME when set', async () => {
      const customQwenHome = path.join(testRootDir, 'custom-qwen-home');
      const originalQwenHome = process.env['QWEN_HOME'];
      process.env['QWEN_HOME'] = customQwenHome;
      try {
        await createTestFile(
          path.join(customQwenHome, 'rules', 'fromCustomHome.md'),
          'CustomHome rule.',
        );
        // A stale rule in the legacy ~/.qwen/rules location should NOT be
        // loaded once QWEN_HOME points elsewhere.
        await createTestFile(
          path.join(homedir, QWEN_DIR, 'rules', 'fromLegacyHome.md'),
          'LegacyHome rule.',
        );

        const result = await loadRules(projectRoot, true);

        expect(result.content).toContain('CustomHome rule.');
        expect(result.content).not.toContain('LegacyHome rule.');
      } finally {
        if (originalQwenHome === undefined) {
          delete process.env['QWEN_HOME'];
        } else {
          process.env['QWEN_HOME'] = originalQwenHome;
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ConditionalRulesRegistry
  // ─────────────────────────────────────────────────────────────────────────

  describe('ConditionalRulesRegistry', () => {
    const rule = (fp: string, pats: string[], body: string) => ({
      filePath: fp,
      paths: pats,
      content: body,
    });

    it('matches a file and returns formatted content', () => {
      const reg = new ConditionalRulesRegistry(
        [rule('/r/fe.md', ['src/**/*.tsx'], 'Use hooks.')],
        '/project',
      );
      const result = reg.matchAndConsume('/project/src/App.tsx');
      expect(result).toContain('Use hooks.');
    });

    it('returns undefined when no patterns match', () => {
      const reg = new ConditionalRulesRegistry(
        [rule('/r/fe.md', ['src/**/*.tsx'], 'Use hooks.')],
        '/project',
      );
      expect(reg.matchAndConsume('/project/lib/utils.py')).toBeUndefined();
    });

    it('injects each rule at most once', () => {
      const reg = new ConditionalRulesRegistry(
        [rule('/r/fe.md', ['src/**/*.tsx'], 'Use hooks.')],
        '/project',
      );
      expect(reg.matchAndConsume('/project/src/A.tsx')).toBeDefined();
      expect(reg.matchAndConsume('/project/src/B.tsx')).toBeUndefined();
    });

    it('matches multiple rules for one file', () => {
      const reg = new ConditionalRulesRegistry(
        [
          rule('/r/ts.md', ['**/*.tsx'], 'Strict.'),
          rule('/r/react.md', ['src/**/*.tsx'], 'Hooks.'),
        ],
        '/project',
      );
      const result = reg.matchAndConsume('/project/src/App.tsx');
      expect(result).toContain('Strict.');
      expect(result).toContain('Hooks.');
      expect(reg.injectedCount).toBe(2);
    });

    it('tracks totalCount and injectedCount', () => {
      const reg = new ConditionalRulesRegistry(
        [rule('/r/a.md', ['**/*.ts'], 'A'), rule('/r/b.md', ['**/*.py'], 'B')],
        '/project',
      );
      expect(reg.totalCount).toBe(2);
      expect(reg.injectedCount).toBe(0);
      reg.matchAndConsume('/project/foo.ts');
      expect(reg.injectedCount).toBe(1);
    });

    it('returns undefined when registry is empty', () => {
      const reg = new ConditionalRulesRegistry([], '/project');
      expect(reg.matchAndConsume('/project/foo.ts')).toBeUndefined();
    });

    it('does not match files outside the project root', () => {
      const reg = new ConditionalRulesRegistry(
        [rule('/r/ts.md', ['**/*.ts'], 'Strict.')],
        '/project',
      );
      expect(reg.matchAndConsume('/etc/passwd')).toBeUndefined();
      expect(reg.matchAndConsume('/other/foo.ts')).toBeUndefined();
    });

    it('rejects the exact `..` relative path (parent of projectRoot)', () => {
      // Pattern matches literal '..' — pathological but defensive
      const reg = new ConditionalRulesRegistry(
        [rule('/r/dot.md', ['..'], 'Parent rule.')],
        '/project',
      );
      // Exact parent directory (unlikely but possible input)
      expect(reg.matchAndConsume('/')).toBeUndefined();
    });

    it('resolves relative paths against projectRoot', () => {
      const reg = new ConditionalRulesRegistry(
        [rule('/r/ts.md', ['src/**/*.ts'], 'Strict.')],
        '/project',
      );
      // A relative file_path should be resolved against the project root
      // so "src/foo.ts" matches "src/**/*.ts".
      const result = reg.matchAndConsume('src/foo.ts');
      expect(result).toContain('Strict.');
    });

    it('activates on dotfiles when glob covers them (dot: true semantics)', () => {
      // **/*.yml must match .github/workflows/ci.yml, .prettierrc.yml, etc.
      // Regression: previously picomatch used { dot: false } so hidden paths
      // were silently excluded.
      const reg = new ConditionalRulesRegistry(
        [rule('/r/yml.md', ['**/*.yml'], 'YAML rule.')],
        '/project',
      );
      expect(
        reg.matchAndConsume('/project/.github/workflows/ci.yml'),
      ).toContain('YAML rule.');
    });

    it('rejects Windows cross-drive paths (shared cross-drive guard)', () => {
      // Regression: ConditionalRulesRegistry historically only checked
      // `..` / `../` and accepted the absolute string that
      // `path.win32.relative('C:\\proj', 'D:\\elsewhere')` produces. The
      // shared `resolveProjectRelativePath` helper (now used by both the
      // skill and rules registries) catches the cross-drive case via
      // `pathModule.isAbsolute(rawRelativePath)`. Direct unit cover for
      // the helper lives in skill-activation.test.ts via the
      // `path.win32`-parameterized test; this case asserts the rules
      // registry calls into the hardened path. On POSIX runners the
      // input shape exercises the existing `..` branch — either
      // platform must return undefined for off-project paths.
      const reg = new ConditionalRulesRegistry(
        [rule('/r/broad.md', ['**/*.ts'], 'Broad rule.')],
        '/project',
      );
      expect(
        reg.matchAndConsume('/totally/other/place/file.ts'),
      ).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')(
      'should match shell-escaped file paths after unescaping',
      () => {
        // On Windows, unescapePath is a no-op (backslash is a path
        // separator, not a shell escape character).
        const reg = new ConditionalRulesRegistry(
          [rule('/r/ts.md', ['src/**/*.tsx'], 'Use hooks.')],
          '/project',
        );
        const escapedPath = 'src/App\\ file.tsx';
        const normalizedPath = unescapePath(escapedPath.trim());
        expect(normalizedPath).toBe('src/App file.tsx');
        const result = reg.matchAndConsume(
          path.resolve('/project', normalizedPath),
        );
        expect(result).toContain('Use hooks.');
      },
    );
  });
});
