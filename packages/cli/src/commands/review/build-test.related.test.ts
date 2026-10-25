/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolateOperatorReviewSettings } from './lib/test-utils.js';
import { runBuildTest, type CommandResult } from './build-test.js';
import { relatedTestDir, TEST_COMMAND_RE } from './lib/npm-toolchain.js';

const statfsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = { ...actual, statfsSync: statfsSyncMock };
  return { ...mock, default: mock };
});

let reviewSettingsIsolation: ReturnType<typeof isolateOperatorReviewSettings>;
beforeEach(() => {
  statfsSyncMock.mockReturnValue({ bavail: 16 * 1024 ** 3, bsize: 1 });
  reviewSettingsIsolation = isolateOperatorReviewSettings();
});
afterEach(() => reviewSettingsIsolation?.dispose());

const result = (command: string, output = ''): CommandResult => ({
  command,
  exitCode: 0,
  seconds: 1,
  timedOut: false,
  output,
});

describe('runBuildTest: a suite runs only the tests related to the diff', () => {
  let root: string;
  let planPath: string;

  const write = (file: string, text = ''): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const writePlan = (
    files: Array<string | { path: string; renameFrom: string }>,
  ): void => {
    planPath = join(root, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        diffPathAbsolute: '/dev/null',
        files: files.map((f) =>
          typeof f === 'string'
            ? { path: f, kind: 'source' }
            : { ...f, kind: 'source' },
        ),
      }),
    );
  };
  const runWith = (
    exec: (command: string) => CommandResult = (c) => result(c),
    extra: object = {},
  ) =>
    runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec,
      ...extra,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bt-related-'));
    write('package-lock.json', '{}');
    write('node_modules/.package-lock.json', '{}');
    write(
      'package.json',
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    write(
      'packages/core/package.json',
      JSON.stringify({
        name: '@x/core',
        scripts: { build: 'exit 0', test: 'vitest run' },
      }),
    );
    write(
      'packages/cli/package.json',
      JSON.stringify({
        name: '@x/cli',
        dependencies: { '@x/core': '*' },
        scripts: { build: 'exit 0', test: 'vitest run' },
      }),
    );
    write('packages/core/src/a.ts');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hands each suite the diff, and says what that leaves out', () => {
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run "src/a.ts"',
      'npm exec --workspace="packages/cli" --yes=false -- vitest related --run "../core/src/a.ts"',
    ]);
    expect(rep.relatedTests).toEqual(['packages/cli', 'packages/core']);
    expect(rep.ok).toBe(true);
    expect(rep.note).toContain(
      'In packages/cli, packages/core, only the tests related to the diff ran',
    );
    expect(rep.note).toContain('not the whole suite');
    // Both shapes stay inside the grammar --resume and test-delta re-run.
    expect(rep.test.filter((t) => !TEST_COMMAND_RE.test(t.command))).toEqual(
      [],
    );
    expect(rep.test.map((t) => relatedTestDir(t.command))).toEqual([
      'packages/core',
      'packages/cli',
    ]);
  });

  it('adds the tests that name a changed doc', () => {
    write('docs/api.md');
    write('packages/cli/src/api-docs.test.ts', "join(ROOT, 'docs/api.md')");
    writePlan(['packages/core/src/a.ts', 'docs/api.md']);
    const cli = runWith().test.find((t) => t.command.includes('packages/cli'));
    expect(cli?.command).toBe(
      'npm exec --workspace="packages/cli" --yes=false -- vitest related --run ' +
        '"../../docs/api.md" "../core/src/a.ts" "src/api-docs.test.ts"',
    );
  });

  it('runs every suite whole when the diff changes what no import reaches', () => {
    write('packages/core/vitest.config.ts');
    writePlan(['packages/core/src/a.ts', 'packages/core/vitest.config.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/cli"',
    ]);
    expect(rep.relatedTests).toBeUndefined();
    expect(rep.note).not.toContain('related to the diff');
  });

  it('runs every suite whole for a rename the plan records', () => {
    writePlan([
      {
        path: 'packages/core/src/a.ts',
        renameFrom: 'packages/core/src/old.ts',
      },
    ]);
    expect(runWith().test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/cli"',
    ]);
  });

  it('keeps a suite whole whose script is not a plain vitest run', () => {
    write(
      'packages/cli/package.json',
      JSON.stringify({
        name: '@x/cli',
        dependencies: { '@x/core': '*' },
        scripts: { build: 'exit 0', test: 'vitest run --coverage' },
      }),
    );
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run "src/a.ts"',
      'npm test --workspace="packages/cli"',
    ]);
    expect(rep.relatedTests).toEqual(['packages/core']);
  });

  it('names the config the script names', () => {
    write(
      'packages/core/package.json',
      JSON.stringify({
        name: '@x/core',
        scripts: {
          build: 'exit 0',
          test: 'vitest run --config vitest.unit.config.ts',
        },
      }),
    );
    writePlan(['packages/core/src/a.ts']);
    expect(runWith().test[0].command).toBe(
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run ' +
        '--config "vitest.unit.config.ts" "src/a.ts"',
    );
  });

  it('says so when a related run found no test to run', () => {
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith((c) =>
      result(
        c,
        c.includes('packages/cli')
          ? 'No test files found, exiting with code 0'
          : ' Test Files  1 passed (1)',
      ),
    );
    expect(rep.ok).toBe(true);
    expect(rep.note).toContain(
      'In packages/cli, no test is related to the diff, so none ran.',
    );
  });

  it('carries the sentence on a failure too', () => {
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith((c) =>
      relatedTestDir(c) === 'packages/core'
        ? { ...result(c), exitCode: 1 }
        : result(c),
    );
    expect(rep.ok).toBe(false);
    expect(rep.note).toContain('1 command(s) failed.');
    expect(rep.note).toContain('only the tests related to the diff ran');
  });

  it('continues a run with the related commands the first call would have run', () => {
    writePlan(['packages/core/src/a.ts']);
    const st = statSync(root);
    const outPath = join(root, 'report.json');
    const core =
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run "src/a.ts"';
    writeFileSync(
      outPath,
      JSON.stringify({
        toolchain: 'npm',
        run: {
          root,
          tree: { ino: st.ino, birth: Math.round(st.birthtimeMs) },
          plan: Math.round(statSync(planPath).mtimeMs),
        },
        affected: ['packages/core'],
        buildSet: ['packages/core', 'packages/cli'],
        widenedWith: [],
        install: null,
        build: [result('npm run build --workspace="packages/core"')],
        test: [result(core)],
        ok: true,
        timedOut: [],
        note: 'the whole-call budget was spent with 1 suite(s) still to run',
        relatedTests: ['packages/core'],
        testScope: {
          workspaces: ['packages/core'],
          notRun: ['packages/cli'],
          caveat: 'the whole-call budget was spent',
        },
      }),
    );
    const ran: string[] = [];
    const rep = runWith(
      (c) => {
        ran.push(c);
        return result(c);
      },
      { out: outPath, resume: true },
    );
    expect(ran).toEqual([
      'npm exec --workspace="packages/cli" --yes=false -- vitest related --run "../core/src/a.ts"',
    ]);
    expect(rep.relatedTests).toEqual(['packages/cli', 'packages/core']);
    expect(rep.note).toContain('Continued from a previous build-test call');
    expect(rep.note).toContain(
      'In packages/cli, packages/core, only the tests related to the diff ran',
    );
  });

  it('refuses to resume a report whose related command it could not have written', () => {
    writePlan(['packages/core/src/a.ts']);
    const st = statSync(root);
    const outPath = join(root, 'report.json');
    writeFileSync(
      outPath,
      JSON.stringify({
        toolchain: 'npm',
        run: {
          root,
          tree: { ino: st.ino, birth: Math.round(st.birthtimeMs) },
          plan: Math.round(statSync(planPath).mtimeMs),
        },
        affected: ['packages/core'],
        buildSet: ['packages/core'],
        widenedWith: [],
        install: null,
        build: [],
        test: [
          {
            ...result(
              'npm exec --workspace="packages/core" --yes=false -- vitest related --run "$(id)"',
            ),
            clamped: true,
          },
        ],
        ok: false,
        timedOut: [],
        note: '',
        testScope: { workspaces: ['packages/core'] },
      }),
    );
    expect(() =>
      runWith((c) => result(c), { out: outPath, resume: true }),
    ).toThrow(/is not one build-test itself runs/);
  });
});

describe('TEST_COMMAND_RE: the related form', () => {
  it('admits what relatedCommand writes, and nothing a shell or vitest would read differently', () => {
    const admitted = [
      'npm test',
      'npm test --workspace="packages/a"',
      'npm exec --yes=false -- vitest related --run "src/a.ts"',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run --config "vitest.config.ts" "../b/src/x.ts" "src/y.test.ts"',
    ];
    expect(admitted.filter((c) => !TEST_COMMAND_RE.test(c))).toEqual([]);
    const refused = [
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run',
      'npm exec --workspace="packages/a" -- vitest related --run "src/a.ts"',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run "-x"',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run "a b.ts"',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run "$(id)"',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run src/a.ts',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run "src/a.ts"; id',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run --config "-x" "src/a.ts"',
      'npm test; id',
    ];
    expect(refused.filter((c) => TEST_COMMAND_RE.test(c))).toEqual([]);
  });
});
