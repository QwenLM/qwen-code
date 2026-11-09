/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The related command, run for real: npm sets the workspace as cwd, vitest
// resolves the out-of-root path the selection writes, and only the test that
// imports the changed file runs. Every other test of the related run reads
// the command as a string against a fake exec; this one is what reddens if
// either premise moves. Asserted on the files vitest collected, never on the
// exit code: a related run that matches nothing exits 0 too.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateOperatorReviewSettings } from './lib/test-utils.js';
import { runBuildTest } from './build-test.js';

/** This repo's own installed dependencies, which the fixture borrows. */
const REPO_NODE_MODULES = fileURLToPath(
  new URL('../../../../../node_modules', import.meta.url),
);

describe.skipIf(!existsSync(join(REPO_NODE_MODULES, '.bin', 'vitest')))(
  'runBuildTest: the related command, executed',
  () => {
    let root: string;
    let isolation: ReturnType<typeof isolateOperatorReviewSettings>;
    const write = (file: string, text: string): void => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };

    beforeEach(() => {
      isolation = isolateOperatorReviewSettings();
      root = mkdtempSync(join(tmpdir(), 'bt-related-run-'));
      symlinkSync(REPO_NODE_MODULES, join(root, 'node_modules'), 'dir');
      write(
        'package.json',
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
      );
      write(
        'packages/core/package.json',
        JSON.stringify({ name: '@x/core', scripts: { test: 'vitest run' } }),
      );
      write(
        'packages/cli/package.json',
        JSON.stringify({
          name: '@x/cli',
          dependencies: { '@x/core': '*' },
          scripts: { test: 'vitest run' },
        }),
      );
      const test = (body: string) =>
        `import { it, expect } from 'vitest';\n${body}\n`;
      write('packages/core/src/a.ts', 'export const a = 1;\n');
      write(
        'packages/core/src/a.test.ts',
        test("import { a } from './a.js';\nit('a', () => expect(a).toBe(1));"),
      );
      write(
        'packages/cli/src/uses-a.test.ts',
        test(
          "import { a } from '../../core/src/a.js';\nit('uses a', () => expect(a).toBe(1));",
        ),
      );
      write(
        'packages/cli/src/other.test.ts',
        test("it('other', () => expect(2).toBe(2));"),
      );
      write(
        'plan.json',
        JSON.stringify({
          diffPathAbsolute: '/dev/null',
          files: [{ path: 'packages/core/src/a.ts', kind: 'source' }],
        }),
      );
    });
    afterEach(() => {
      isolation.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('runs the importer of the changed file, across the workspace boundary, and nothing else', () => {
      const rep = runBuildTest({
        plan: join(root, 'plan.json'),
        worktree: root,
        timeout: 120,
        install: false,
      });
      expect(rep.relatedTests).toEqual(['packages/cli', 'packages/core']);
      const cli = rep.test.find((t) => t.command.includes('"packages/cli"'));
      const core = rep.test.find((t) => t.command.includes('"packages/core"'));
      expect(cli?.command).toBe(
        'npm exec --workspace="packages/cli" --yes=false -- vitest related --run "../core/src/a.ts"',
      );
      expect(cli?.output).toContain('uses-a.test.ts');
      expect(cli?.output).not.toContain('other.test.ts');
      expect(cli?.exitCode).toBe(0);
      expect(core?.output).toContain('a.test.ts');
    }, 180_000);
  },
);
