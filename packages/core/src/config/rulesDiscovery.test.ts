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
import { QWEN_DIR, unescapePath } from '../utils/paths.js';

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

  // Writes each `files` entry (name → body), in order, under <root>/.qwen/rules.
  async function writeRules(files: Record<string, string>, root = projectRoot) {
    for (const [name, body] of Object.entries(files)) {
      await createTestFile(path.join(root, QWEN_DIR, 'rules', name), body);
    }
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

  describe('parseRuleFile', () => {
    it('parses a rule with paths frontmatter', async () => {
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

    it('parses a baseline rule without paths', async () => {
      const content =
        '---\ndescription: General coding standards\n---\nAlways write tests.\n';
      const rule = parseRuleFile(content, '/test/rule.md');
      expect(rule!.paths).toBeUndefined();
      expect(rule!.content).toBe('Always write tests.');
    });

    it('parses a rule without any frontmatter as baseline', async () => {
      const rule = parseRuleFile('Plain rules.\n\nParagraph.', '/test/r.md');
      expect(rule!.paths).toBeUndefined();
      expect(rule!.content).toBe('Plain rules.\n\nParagraph.');
    });

    it('strips HTML comments', async () => {
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

    it('strips adjacent and residual HTML comment markers', async () => {
      // Cases that once left a residual <!-- in the output (CodeQL:
      // incomplete multi-character sanitization).
      const content =
        '---\ndescription: Test\n---\nA<!-- one --><!-- two -->B<!--unclosed\n';
      const rule = parseRuleFile(content, '/test/rule.md');
      expect(rule!.content).not.toContain('<!--');
      expect(rule!.content).toContain('A');
      expect(rule!.content).toContain('B');
    });

    it('returns null for empty body after stripping', async () => {
      const content = '---\npaths:\n  - "*.ts"\n---\n<!-- Only a comment -->\n';
      expect(parseRuleFile(content, '/test/rule.md')).toBeNull();
    });

    it('handles empty paths array as baseline', async () => {
      const content = '---\npaths:\n---\nSome content.\n';
      expect(parseRuleFile(content, '/t.md')!.paths).toBeUndefined();
    });

    it('handles paths as a single string', async () => {
      const content = '---\npaths: "src/**/*.ts"\n---\nRule.\n';
      expect(parseRuleFile(content, '/t.md')!.paths).toEqual(['src/**/*.ts']);
    });

    it('handles BOM and CRLF', async () => {
      const content = '\uFEFF---\r\ndescription: BOM\r\n---\r\nContent.\r\n';
      const rule = parseRuleFile(content, '/t.md');
      expect(rule!.description).toBe('BOM');
      expect(rule!.content).toBe('Content.');
    });

    it('treats non-array/non-string paths as baseline', async () => {
      const content = '---\npaths: 42\n---\nBody.\n';
      expect(parseRuleFile(content, '/t.md')!.paths).toBeUndefined();
    });
  });

  // loadRules: baseline vs conditional split.
  describe('loadRules', () => {
    it('returns empty when no rules directory exists', async () => {
      const result = await loadRules(projectRoot, true);
      // The whole response shape on purpose: this is the one test that pins
      // what `loadRules` returns, so a field added to the contract belongs
      // here rather than being hidden from it (#12030).
      expect(result).toEqual({
        content: '',
        ruleCount: 0,
        conditionalRules: [],
        ignoredExtensionRules: [],
      });
    });

    it('loads baseline rules into content', async () => {
      await writeRules({
        'general.md': '---\ndescription: General\n---\nAlways write tests.',
      });

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Always write tests.');
      expect(result.conditionalRules).toEqual([]);
    });

    it('puts conditional rules in conditionalRules, not in content', async () => {
      await writeRules({
        'fe.md': '---\npaths:\n  - "src/**/*.tsx"\n---\nUse hooks.',
      });

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(0);
      expect(result.content).toBe('');
      expect(result.conditionalRules).toHaveLength(1);
      expect(result.conditionalRules[0].content).toBe('Use hooks.');
    });

    it('splits baseline and conditional correctly', async () => {
      await writeRules({
        '01-general.md': 'Write clean code.',
        '02-py.md': `---\npaths:\n  - "**/*.py"\n---\nUse type hints.`,
        '03-ts.md': `---\npaths:\n  - "**/*.ts"\n---\nUse strict.`,
      });

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Write clean code.');
      expect(result.conditionalRules).toHaveLength(2);
    });

    it('recursively scans subdirectories', async () => {
      await writeRules({
        [path.join('frontend', 'react.md')]: 'Use hooks.',
        [path.join('backend', 'api.md')]: 'Validate inputs.',
        'general.md': 'Write tests.',
      });

      const result = await loadRules(projectRoot, true);
      expect(result.ruleCount).toBe(3);
      expect(result.content).toContain('Use hooks.');
      expect(result.content).toContain('Validate inputs.');
      expect(result.content).toContain('Write tests.');
    });

    it('skips project rules when folder is untrusted', async () => {
      await writeRules({ 'r.md': 'Untrusted.' });
      const result = await loadRules(projectRoot, false);
      expect(result.ruleCount).toBe(0);
    });

    it('loads global rules even when folder is untrusted', async () => {
      await writeRules({ 'g.md': 'Global.' }, homedir);
      const result = await loadRules(projectRoot, false);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Global.');
    });

    it('does not duplicate rules when projectRoot equals homedir', async () => {
      await writeRules({ 's.md': 'Shared.' }, homedir);
      const result = await loadRules(homedir, true);
      expect(result.ruleCount).toBe(1);
      expect((result.content.match(/Shared\./g) || []).length).toBe(1);
    });

    it('excludes rules matching exclude patterns', async () => {
      await writeRules({ 'keep.md': 'Keep.', 'skip.md': 'Skip.' });
      const skipped = path.join(projectRoot, QWEN_DIR, 'rules', 'skip.md');

      const result = await loadRules(projectRoot, true, [skipped]);
      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Keep.');
      expect(result.content).not.toContain('Skip.');
    });

    it('excludes rules in subdirectories by glob', async () => {
      await writeRules({
        [path.join('other-team', 'r.md')]: 'Their rule.',
        'mine.md': 'My rule.',
      });

      const result = await loadRules(projectRoot, true, ['**/other-team/**']);
      expect(result.ruleCount).toBe(1);
      expect(result.content).not.toContain('Their rule.');
    });

    it('formats rules with source markers', async () => {
      await writeRules({ 'test.md': 'Content.' });
      const result = await loadRules(projectRoot, true);
      expect(result.content).toContain(
        `--- Rule from: ${QWEN_DIR}/rules/test.md ---`,
      );
    });

    it('reads global rules from QWEN_HOME when set', async () => {
      const customQwenHome = path.join(testRootDir, 'custom-qwen-home');
      vi.stubEnv('QWEN_HOME', customQwenHome); // restored in afterEach
      await createTestFile(
        path.join(customQwenHome, 'rules', 'fromCustomHome.md'),
        'CustomHome rule.',
      );
      // A stale rule in the legacy ~/.qwen/rules must NOT load once
      // QWEN_HOME points elsewhere.
      await writeRules({ 'fromLegacyHome.md': 'LegacyHome rule.' }, homedir);

      const result = await loadRules(projectRoot, true);

      expect(result.content).toContain('CustomHome rule.');
      expect(result.content).not.toContain('LegacyHome rule.');
    });
  });

  // Extension-contributed rules (#12030).
  describe('extension rules', () => {
    async function writeExtensionRule(
      extensionName: string,
      fileName: string,
      content: string,
    ) {
      const dir = path.join(testRootDir, 'extensions', extensionName, 'rules');
      await createTestFile(path.join(dir, fileName), content);
      return { name: extensionName, dir };
    }
    const paletteRule = (glob: string) =>
      `---\npaths:\n  - '${glob}'\n---\n\nUse the chart palette.`;

    it('takes a conditional rule from an extension', async () => {
      const source = await writeExtensionRule(
        'charts',
        'charting.md',
        paletteRule('src/**/*.tsx'),
      );

      const result = await loadRules(projectRoot, true, [], [source]);

      // Conditional: it must not be in the session-start content.
      expect(result.ruleCount).toBe(0);
      expect(result.content).toBe('');
      expect(result.conditionalRules).toHaveLength(1);
      expect(result.conditionalRules[0].content).toContain(
        'Use the chart palette.',
      );
      expect(result.ignoredExtensionRules).toEqual([]);
    });

    // The whole point of the mechanism: a baseline rule is resident on every
    // request, the cost an extension's context file already imposes.
    // Accepting one would recreate #12030 inside its own fix, so it is
    // dropped — and reported, or the author sees nothing happen.
    it('drops an extension rule with no paths, and names it', async () => {
      const source = await writeExtensionRule(
        'charts',
        'always.md',
        'Always follow the chart palette.',
      );

      const result = await loadRules(projectRoot, true, [], [source]);

      expect(result.ruleCount).toBe(0);
      expect(result.content).toBe('');
      expect(result.conditionalRules).toEqual([]);
      expect(result.ignoredExtensionRules).toEqual(['charts:rules/always.md']);
    });

    it('labels an extension rule by extension, not by a path out of the project', async () => {
      const source = await writeExtensionRule(
        'charts',
        'charting.md',
        paletteRule('src/**/*.tsx'),
      );

      const result = await loadRules(projectRoot, true, [], [source]);
      const registry = new ConditionalRulesRegistry(
        result.conditionalRules,
        projectRoot,
      );
      const injected = await registry.matchAndConsume(
        path.join(projectRoot, 'src', 'Chart.tsx'),
      );

      expect(injected).toContain('--- Rule from: charts:rules/charting.md ---');
      // A path relative to the project root would be a stack of `../`.
      expect(injected).not.toContain('..');
    });

    it('is unaffected by a missing rules directory', async () => {
      const result = await loadRules(
        projectRoot,
        true,
        [],
        [{ name: 'no-rules', dir: path.join(testRootDir, 'nowhere', 'rules') }],
      );

      expect(result.conditionalRules).toEqual([]);
      expect(result.ignoredExtensionRules).toEqual([]);
    });

    it('honours exclude patterns for extension rules too', async () => {
      const source = await writeExtensionRule(
        'charts',
        'charting.md',
        paletteRule('src/**'),
      );

      const result = await loadRules(
        projectRoot,
        true,
        ['**/extensions/charts/**'],
        [source],
      );

      expect(result.conditionalRules).toEqual([]);
    });
  });

  describe('ConditionalRulesRegistry', () => {
    const rule = (fp: string, pats: string[], body: string) => ({
      filePath: fp,
      paths: pats,
      content: body,
    });
    // A registry rooted at /project over `rules`.
    const projectReg = (...rules: Array<ReturnType<typeof rule>>) =>
      new ConditionalRulesRegistry(rules, '/project');

    it('matches a file and returns formatted content', async () => {
      const reg = projectReg(rule('/r/fe.md', ['src/**/*.tsx'], 'Use hooks.'));
      const result = await reg.matchAndConsume('/project/src/App.tsx');
      expect(result).toContain('Use hooks.');
    });

    it('returns undefined when no patterns match', async () => {
      const reg = projectReg(rule('/r/fe.md', ['src/**/*.tsx'], 'Use hooks.'));
      expect(
        await reg.matchAndConsume('/project/lib/utils.py'),
      ).toBeUndefined();
    });

    it('injects each rule at most once', async () => {
      const reg = projectReg(rule('/r/fe.md', ['src/**/*.tsx'], 'Use hooks.'));
      expect(await reg.matchAndConsume('/project/src/A.tsx')).toBeDefined();
      expect(await reg.matchAndConsume('/project/src/B.tsx')).toBeUndefined();
    });

    it('matches multiple rules for one file', async () => {
      const reg = projectReg(
        rule('/r/ts.md', ['**/*.tsx'], 'Strict.'),
        rule('/r/react.md', ['src/**/*.tsx'], 'Hooks.'),
      );
      const result = await reg.matchAndConsume('/project/src/App.tsx');
      expect(result).toContain('Strict.');
      expect(result).toContain('Hooks.');
      expect(reg.injectedCount).toBe(2);
    });

    it('tracks totalCount and injectedCount', async () => {
      const reg = projectReg(
        rule('/r/a.md', ['**/*.ts'], 'A'),
        rule('/r/b.md', ['**/*.py'], 'B'),
      );
      expect(reg.totalCount).toBe(2);
      expect(reg.injectedCount).toBe(0);
      await reg.matchAndConsume('/project/foo.ts');
      expect(reg.injectedCount).toBe(1);
    });

    it('returns undefined when registry is empty', async () => {
      const reg = new ConditionalRulesRegistry([], '/project');
      expect(await reg.matchAndConsume('/project/foo.ts')).toBeUndefined();
    });

    it('does not match files outside the project root', async () => {
      const reg = projectReg(rule('/r/ts.md', ['**/*.ts'], 'Strict.'));
      expect(await reg.matchAndConsume('/etc/passwd')).toBeUndefined();
      expect(await reg.matchAndConsume('/other/foo.ts')).toBeUndefined();
    });

    it('rejects the exact `..` relative path (parent of projectRoot)', async () => {
      // A pattern matching literal '..' is pathological but defensive; the
      // input is the exact parent directory (unlikely but possible).
      const reg = projectReg(rule('/r/dot.md', ['..'], 'Parent rule.'));
      expect(await reg.matchAndConsume('/')).toBeUndefined();
    });

    it('resolves relative paths against projectRoot', async () => {
      const reg = projectReg(rule('/r/ts.md', ['src/**/*.ts'], 'Strict.'));
      // A relative file_path resolves against the project root, so
      // "src/foo.ts" matches "src/**/*.ts".
      const result = await reg.matchAndConsume('src/foo.ts');
      expect(result).toContain('Strict.');
    });

    it('activates on dotfiles when glob covers them (dot: true semantics)', async () => {
      // **/*.yml must match .github/workflows/ci.yml, .prettierrc.yml, etc.
      // Regression: picomatch used { dot: false }, silently excluding
      // hidden paths.
      const reg = projectReg(rule('/r/yml.md', ['**/*.yml'], 'YAML rule.'));
      expect(
        await reg.matchAndConsume('/project/.github/workflows/ci.yml'),
      ).toContain('YAML rule.');
    });

    it('rejects Windows cross-drive paths (shared cross-drive guard)', async () => {
      // Regression: the registry only checked `..` / `../` and accepted the
      // absolute string `path.win32.relative('C:\\proj', 'D:\\elsewhere')`
      // yields. The shared `resolveProjectRelativePath` helper (skill and
      // rules registries) now catches it via `pathModule.isAbsolute`; its
      // direct win32 cover is in skill-activation.test.ts. This case pins
      // that the rules registry uses it; on POSIX the input exercises the
      // `..` branch. Either platform must return undefined off-project.
      const reg = projectReg(rule('/r/broad.md', ['**/*.ts'], 'Broad rule.'));
      expect(
        await reg.matchAndConsume('/totally/other/place/file.ts'),
      ).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')(
      'should match shell-escaped file paths after unescaping',
      async () => {
        // On Windows, unescapePath is a no-op (backslash is a path
        // separator, not a shell escape character).
        const reg = projectReg(
          rule('/r/ts.md', ['src/**/*.tsx'], 'Use hooks.'),
        );
        const escapedPath = 'src/App\\ file.tsx';
        const normalizedPath = unescapePath(escapedPath.trim());
        expect(normalizedPath).toBe('src/App file.tsx');
        const result = await reg.matchAndConsume(
          path.resolve('/project', normalizedPath),
        );
        expect(result).toContain('Use hooks.');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'activates rules when file is reached via symlinked directory',
      async () => {
        const srcDir = path.join(projectRoot, 'src');
        await fsPromises.mkdir(srcDir, { recursive: true });
        const symlinkDir = path.join(projectRoot, 'symlink-to-src');
        await fsPromises.symlink(srcDir, symlinkDir);
        // The real file must exist so realpath can resolve it.
        await fsPromises.writeFile(path.join(srcDir, 'foo.ts'), '// test');

        const reg = new ConditionalRulesRegistry(
          [rule('/r/ts.md', ['src/**/*.ts'], 'Strict.')],
          projectRoot,
        );

        const result = await reg.matchAndConsume(
          path.join(symlinkDir, 'foo.ts'),
        );
        expect(result).toContain('Strict.');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'activates rules when project root itself is a symlink',
      async () => {
        const realProject = path.join(testRootDir, 'real-project');
        await fsPromises.mkdir(realProject, { recursive: true });
        const srcDir = path.join(realProject, 'src');
        await fsPromises.mkdir(srcDir, { recursive: true });
        const symlinkProject = path.join(testRootDir, 'symlink-project');
        await fsPromises.symlink(realProject, symlinkProject);
        // The real file must exist so realpath can resolve it.
        await fsPromises.writeFile(path.join(srcDir, 'foo.ts'), '// test');

        const reg = new ConditionalRulesRegistry(
          [rule('/r/ts.md', ['src/**/*.ts'], 'Strict.')],
          symlinkProject,
        );

        const result = await reg.matchAndConsume(
          path.join(symlinkProject, 'src', 'foo.ts'),
        );
        expect(result).toContain('Strict.');
      },
    );
  });
});
