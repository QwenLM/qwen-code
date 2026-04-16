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
  hasMatchingFiles,
  loadRules,
} from './rulesDiscovery.js';
import { QWEN_DIR } from './paths.js';

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

      expect(rule).not.toBeNull();
      expect(rule!.description).toBe('General coding standards');
      expect(rule!.paths).toBeUndefined();
      expect(rule!.content).toBe('Always write tests.');
    });

    it('parses a rule without any frontmatter as baseline', () => {
      const content = 'Just plain markdown rules.\n\nWith paragraphs.';
      const rule = parseRuleFile(content, '/test/rule.md');

      expect(rule).not.toBeNull();
      expect(rule!.paths).toBeUndefined();
      expect(rule!.content).toBe(
        'Just plain markdown rules.\n\nWith paragraphs.',
      );
    });

    it('strips HTML comments', () => {
      const content = `---
description: Test
---
Visible rule.
<!-- This is a comment that should be stripped -->
More visible text.
`;
      const rule = parseRuleFile(content, '/test/rule.md');

      expect(rule).not.toBeNull();
      expect(rule!.content).not.toContain('comment');
      expect(rule!.content).toContain('Visible rule.');
      expect(rule!.content).toContain('More visible text.');
    });

    it('returns null for empty body after stripping', () => {
      const content = `---
description: Empty rule
paths:
  - "*.ts"
---
<!-- Only a comment -->
`;
      const rule = parseRuleFile(content, '/test/rule.md');
      expect(rule).toBeNull();
    });

    it('handles empty paths array', () => {
      const content = `---
description: No paths
paths:
---
Some content.
`;
      const rule = parseRuleFile(content, '/test/rule.md');

      expect(rule).not.toBeNull();
      // Empty paths: array should be treated as undefined (baseline rule)
      expect(rule!.paths).toBeUndefined();
    });

    it('handles paths as a single string instead of array', () => {
      const content = `---
description: Single path
paths: "src/**/*.ts"
---
Single path rule.
`;
      const rule = parseRuleFile(content, '/test/rule.md');

      expect(rule).not.toBeNull();
      expect(rule!.paths).toEqual(['src/**/*.ts']);
    });

    it('handles BOM and CRLF line endings', () => {
      const content =
        '\uFEFF---\r\ndescription: BOM test\r\n---\r\nRule content.\r\n';
      const rule = parseRuleFile(content, '/test/rule.md');

      expect(rule).not.toBeNull();
      expect(rule!.description).toBe('BOM test');
      expect(rule!.content).toBe('Rule content.');
    });

    it('treats non-array/non-string paths as baseline rule', () => {
      const content = `---
description: odd value
paths: 42
---
Body content survives.
`;
      const rule = parseRuleFile(content, '/test/odd.md');

      expect(rule).not.toBeNull();
      // Numeric paths value → ignored → treated as baseline rule
      expect(rule!.paths).toBeUndefined();
      expect(rule!.content).toBe('Body content survives.');
    });
  });

  describe('hasMatchingFiles', () => {
    it('returns true when files match the pattern', async () => {
      await createTestFile(
        path.join(projectRoot, 'src', 'app.tsx'),
        'export default App;',
      );

      const result = await hasMatchingFiles(['src/**/*.tsx'], projectRoot);
      expect(result).toBe(true);
    });

    it('returns false when no files match', async () => {
      await createTestFile(
        path.join(projectRoot, 'src', 'app.py'),
        'print("hello")',
      );

      const result = await hasMatchingFiles(['src/**/*.tsx'], projectRoot);
      expect(result).toBe(false);
    });

    it('matches multiple patterns', async () => {
      await createTestFile(
        path.join(projectRoot, 'lib', 'utils.ts'),
        'export const x = 1;',
      );

      const result = await hasMatchingFiles(
        ['src/**/*.tsx', 'lib/**/*.ts'],
        projectRoot,
      );
      expect(result).toBe(true);
    });

    it('returns false for empty project', async () => {
      const result = await hasMatchingFiles(['**/*.ts'], projectRoot);
      expect(result).toBe(false);
    });
  });

  describe('loadRules', () => {
    it('returns empty when no rules directory exists', async () => {
      const result = await loadRules(projectRoot, true);

      expect(result).toEqual({ content: '', ruleCount: 0 });
    });

    it('loads baseline rules (no paths) unconditionally', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'general.md'),
        `---
description: General standards
---
Always write tests.`,
      );

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Always write tests.');
      expect(result.content).toContain('Rule from:');
    });

    it('loads conditional rules when files match', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'frontend.md'),
        `---
description: Frontend rules
paths:
  - "src/**/*.tsx"
---
Use functional components.`,
      );
      // Create a matching file
      await createTestFile(
        path.join(projectRoot, 'src', 'App.tsx'),
        'export default App;',
      );

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Use functional components.');
    });

    it('skips conditional rules when no files match', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'frontend.md'),
        `---
description: Frontend rules
paths:
  - "src/**/*.tsx"
---
Use functional components.`,
      );
      // No .tsx files in project

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(0);
      expect(result.content).toBe('');
    });

    it('loads both baseline and matching conditional rules', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, '01-general.md'),
        `---
description: General
---
Write clean code.`,
      );
      await createTestFile(
        path.join(rulesDir, '02-python.md'),
        `---
description: Python rules
paths:
  - "**/*.py"
---
Use type hints.`,
      );
      await createTestFile(
        path.join(rulesDir, '03-typescript.md'),
        `---
description: TypeScript rules
paths:
  - "**/*.ts"
  - "**/*.tsx"
---
Use strict mode.`,
      );
      // Only create Python files — TypeScript rule should be skipped
      await createTestFile(path.join(projectRoot, 'app.py'), 'print("hello")');

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(2);
      expect(result.content).toContain('Write clean code.');
      expect(result.content).toContain('Use type hints.');
      expect(result.content).not.toContain('Use strict mode.');
    });

    it('loads rules in alphabetical order', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(path.join(rulesDir, 'b-second.md'), 'Second rule.');
      await createTestFile(path.join(rulesDir, 'a-first.md'), 'First rule.');

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(2);
      const firstIdx = result.content.indexOf('First rule.');
      const secondIdx = result.content.indexOf('Second rule.');
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    it('skips project rules when folder is untrusted', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(path.join(rulesDir, 'rule.md'), 'Untrusted rule.');

      const result = await loadRules(projectRoot, false);

      // Project rules should not load when untrusted
      expect(result.ruleCount).toBe(0);
    });

    it('loads global rules from ~/.qwen/rules/', async () => {
      const globalRulesDir = path.join(homedir, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(globalRulesDir, 'global.md'),
        `---
description: Global standards
---
Follow company guidelines.`,
      );

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Follow company guidelines.');
    });

    it('loads global rules even when folder is untrusted', async () => {
      const globalRulesDir = path.join(homedir, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(globalRulesDir, 'global.md'),
        'Global rule.',
      );

      const result = await loadRules(projectRoot, false);

      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Global rule.');
    });

    it('combines global and project rules', async () => {
      const globalRulesDir = path.join(homedir, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(globalRulesDir, 'global.md'),
        'Global rule.',
      );

      const projectRulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(projectRulesDir, 'project.md'),
        'Project rule.',
      );

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(2);
      expect(result.content).toContain('Global rule.');
      expect(result.content).toContain('Project rule.');
      // Global rules should come before project rules
      const globalIdx = result.content.indexOf('Global rule.');
      const projectIdx = result.content.indexOf('Project rule.');
      expect(globalIdx).toBeLessThan(projectIdx);
    });

    it('does not duplicate rules when projectRoot equals homedir', async () => {
      // When projectRoot === homedir, globalRulesDir === projectRulesDir
      const rulesDir = path.join(homedir, QWEN_DIR, 'rules');
      await createTestFile(path.join(rulesDir, 'shared.md'), 'Shared rule.');

      // Use homedir as projectRoot
      const result = await loadRules(homedir, true);

      expect(result.ruleCount).toBe(1);
      // Should NOT have duplicated the rule
      const occurrences = (result.content.match(/Shared rule\./g) || []).length;
      expect(occurrences).toBe(1);
    });

    it('ignores non-.md files in rules directory', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(path.join(rulesDir, 'rule.md'), 'Valid rule.');
      await createTestFile(path.join(rulesDir, 'notes.txt'), 'Not a rule.');
      await createTestFile(path.join(rulesDir, 'config.json'), '{}');

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Valid rule.');
      expect(result.content).not.toContain('Not a rule.');
    });

    it('strips HTML comments in loaded rules', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'rule.md'),
        `---
description: Test
---
Visible content.
<!-- Hidden comment -->
More visible.`,
      );

      const result = await loadRules(projectRoot, true);

      expect(result.ruleCount).toBe(1);
      expect(result.content).toContain('Visible content.');
      expect(result.content).toContain('More visible.');
      expect(result.content).not.toContain('Hidden comment');
    });

    it('formats rules with source markers', async () => {
      const rulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
      await createTestFile(
        path.join(rulesDir, 'test-rule.md'),
        'Rule content here.',
      );

      const result = await loadRules(projectRoot, true);

      expect(result.content).toContain(
        `--- Rule from: ${QWEN_DIR}/rules/test-rule.md ---`,
      );
      expect(result.content).toContain(
        `--- End of Rule from: ${QWEN_DIR}/rules/test-rule.md ---`,
      );
    });
  });
});
