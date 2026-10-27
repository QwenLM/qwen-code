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
import { buildDiffPlan } from './lib/diff-plan.js';
import { buildPlanReport, stringifyPlanReport } from './lib/report.js';

/** A clock the name scan's directory reads advance, when a test asks. */
const clock = vi.hoisted(() => ({ now: 0, step: 0 }));
const statfsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  const mock = {
    ...actual,
    statfsSync: statfsSyncMock,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      clock.now += clock.step;
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
  return { ...mock, default: mock };
});

let reviewSettingsIsolation: ReturnType<typeof isolateOperatorReviewSettings>;
beforeEach(() => {
  statfsSyncMock.mockReturnValue({ bavail: 16 * 1024 ** 3, bsize: 1 });
  reviewSettingsIsolation = isolateOperatorReviewSettings();
  clock.step = 0;
});
afterEach(() => {
  reviewSettingsIsolation?.dispose();
  vi.restoreAllMocks();
});

const result = (command: string, output = ''): CommandResult => ({
  command,
  exitCode: 0,
  seconds: 1,
  timedOut: false,
  output,
});

const CORE_RUN =
  'npm exec --workspace="packages/core" --yes=false -- vitest related --run "src/a.ts"';
const CLI_RUN =
  'npm exec --workspace="packages/cli" --yes=false -- vitest related --run "../core/src/a.ts"';

describe('runBuildTest: a suite runs only the tests related to the diff', () => {
  let root: string;
  let planPath: string;

  const write = (file: string, text = ''): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const manifest = (dir: string, body: object): void =>
    write(`${dir}/package.json`, JSON.stringify(body));
  const writePlan = (files: string[]): void => {
    planPath = join(root, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        diffPathAbsolute: '/dev/null',
        files: files.map((f) => ({ path: f, kind: 'source' })),
      }),
    );
  };
  const runWith = (
    exec: (command: string, cwd: string, timeoutMs: number) => CommandResult = (
      c,
    ) => result(c),
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
  /** A report `--resume` admits for this tree, with what it is given. */
  const previousReport = (extra: object): string => {
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
        buildSet: ['packages/core', 'packages/cli'],
        widenedWith: [],
        install: null,
        build: [result('npm run build --workspace="packages/core"')],
        test: [],
        ok: true,
        timedOut: [],
        note: '',
        ...extra,
      }),
    );
    return outPath;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bt-related-'));
    write('package-lock.json', '{}');
    write('node_modules/.package-lock.json', '{}');
    // The vitest `npm exec` runs: the root's.
    write('node_modules/.bin/vitest');
    write(
      'package.json',
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    manifest('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'vitest run' },
    });
    manifest('packages/cli', {
      name: '@x/cli',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'vitest run' },
    });
    write('packages/core/src/a.ts');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hands each suite the diff, and says what that leaves out', () => {
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([CORE_RUN, CLI_RUN]);
    expect(rep.relatedTests).toEqual(['packages/cli', 'packages/core']);
    expect(rep.wholeSuiteReason).toBeUndefined();
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

  it('hands a dependent the build output of the package it imports by name', () => {
    manifest('packages/core', {
      name: '@x/core',
      main: 'dist/index.js',
      scripts: { build: 'exit 0', test: 'vitest run' },
    });
    write('packages/core/dist/index.js');
    write('packages/core/dist/src/a.js');
    writePlan(['packages/core/src/a.ts']);
    expect(runWith().test.map((t) => t.command)).toEqual([
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run "dist/src/a.js" "src/a.ts"',
      'npm exec --workspace="packages/cli" --yes=false -- vitest related --run "../core/dist/src/a.js" "../core/src/a.ts"',
    ]);
    // A build that never produced the entry leaves no path to name.
    rmSync(join(root, 'packages/core/dist'), { recursive: true });
    expect(runWith().test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/cli"',
    ]);
  });

  it('runs every suite whole when the diff changes what no import reaches, and says why', () => {
    write('packages/core/vitest.config.ts');
    writePlan(['packages/core/src/a.ts', 'packages/core/vitest.config.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/cli"',
    ]);
    expect(rep.relatedTests).toBeUndefined();
    expect(rep.wholeSuiteReason).toBe(
      'it changes packages/core/vitest.config.ts',
    );
    expect(rep.note).toContain(
      'Every suite ran whole, not only the tests related to the diff, because it changes packages/core/vitest.config.ts.',
    );
    // A failure note carries it too.
    const failed = runWith((c) =>
      c.startsWith('npm test') ? { ...result(c), exitCode: 1 } : result(c),
    );
    expect(failed.note).toContain('because it changes');
  });

  it('gives no reason where no suite could have run related anyway', () => {
    manifest('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'jest' },
    });
    manifest('packages/cli', {
      name: '@x/cli',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'jest' },
    });
    write('packages/core/vitest.config.ts');
    writePlan(['packages/core/src/a.ts', 'packages/core/vitest.config.ts']);
    const rep = runWith();
    expect(rep.wholeSuiteReason).toBeUndefined();
    expect(rep.note).not.toContain('Every suite ran whole');
  });

  it('runs every suite whole for a rename, read from the plan the capture writes', () => {
    const diff = [
      'diff --git a/packages/core/src/old.ts b/packages/core/src/a.ts',
      'similarity index 95%',
      'rename from packages/core/src/old.ts',
      'rename to packages/core/src/a.ts',
      '--- a/packages/core/src/old.ts',
      '+++ b/packages/core/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    planPath = join(root, 'plan.json');
    writeFileSync(
      planPath,
      stringifyPlanReport(
        buildPlanReport(buildDiffPlan(diff, 400), () => 1, {}, diff),
      ),
    );
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/cli"',
    ]);
    expect(rep.wholeSuiteReason).toBe('it renames packages/core/src/old.ts');
  });

  it('keeps a suite whole whose script is not a plain vitest run', () => {
    manifest('packages/cli', {
      name: '@x/cli',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'vitest run --coverage' },
    });
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([
      CORE_RUN,
      'npm test --workspace="packages/cli"',
    ]);
    expect(rep.relatedTests).toEqual(['packages/core']);
  });

  it('keeps a suite whole whose dir the command grammar cannot read back', () => {
    // A dependent whose dir holds a space: its related command would run,
    // narrowed, with nothing in `relatedTests` to say so.
    manifest('packages/my pkg', {
      name: '@x/my-pkg',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'vitest run' },
    });
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toContain(
      'npm test --workspace="packages/my pkg"',
    );
    expect(
      rep.test.filter(
        (t) => t.command.includes('my pkg') && t.command.includes('related'),
      ),
    ).toEqual([]);
  });

  it('names the config the script names', () => {
    manifest('packages/core', {
      name: '@x/core',
      scripts: {
        build: 'exit 0',
        test: 'vitest run --config vitest.unit.config.ts',
      },
    });
    write('packages/core/vitest.unit.config.ts', 'export default {}');
    writePlan(['packages/core/src/a.ts']);
    expect(runWith().test[0].command).toBe(
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run ' +
        '--config "vitest.unit.config.ts" "src/a.ts"',
    );
  });

  it("leaves a dependency's suite related when its consumer changes too", () => {
    write('packages/cli/src/b.ts');
    writePlan(['packages/core/src/a.ts', 'packages/cli/src/b.ts']);
    expect(runWith().test.map((t) => t.command)).toEqual([
      'npm exec --workspace="packages/cli" --yes=false -- vitest related --run "../core/src/a.ts" "src/b.ts"',
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run "../cli/src/b.ts" "src/a.ts"',
    ]);
  });

  it("keeps a consumer's modules out of what its dependency's suite can import", () => {
    // core cannot import cli: a cli module naming the changed doc is not
    // core's to run, and neither is cli's build output.
    write('docs/api.md');
    write('packages/cli/src/names.ts', "'api.md'");
    write('packages/core/src/names.ts', "'api.md'");
    writePlan(['packages/core/src/a.ts', 'docs/api.md']);
    expect(runWith().test.map((t) => t.command)).toEqual([
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run "../../docs/api.md" "src/a.ts" "src/names.ts"',
      'npm exec --workspace="packages/cli" --yes=false -- vitest related --run "../../docs/api.md" "../core/src/a.ts" "../core/src/names.ts" "src/names.ts"',
    ]);
  });

  it('serves a single-package repo, naming its root as prose', () => {
    rmSync(join(root, 'packages'), { recursive: true });
    write(
      'package.json',
      JSON.stringify({ name: 'r', scripts: { test: 'vitest run' } }),
    );
    write('src/a.ts');
    writePlan(['src/a.ts']);
    const rep = runWith();
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm exec --yes=false -- vitest related --run "src/a.ts"',
    ]);
    expect(rep.relatedTests).toEqual(['.']);
    expect(rep.note).toContain(
      'In the root package, only the tests related to the diff ran',
    );
    expect(rep.note).not.toContain('In .,');
  });

  it('claims no related coverage for a run that found nothing, timed out, or crashed', () => {
    writePlan(['packages/core/src/a.ts']);
    const none = runWith((c) =>
      result(
        c,
        relatedTestDir(c) === 'packages/cli'
          ? 'No test files found, exiting with code 0'
          : ' Test Files  1 passed (1)',
      ),
    );
    expect(none.ok).toBe(true);
    expect(none.note).toContain(
      'In packages/core, only the tests related to the diff ran',
    );
    expect(none.note).toContain(
      'In packages/cli, no test is related to the diff, so none ran.',
    );
    const killed = runWith((c) =>
      relatedTestDir(c) === 'packages/core'
        ? { ...result(c), exitCode: null, timedOut: true }
        : result(c),
    );
    expect(killed.note).toContain(
      'In packages/cli, only the tests related to the diff ran',
    );
    expect(killed.note).not.toContain('packages/cli, packages/core, only');
    // The field still names it: the suite did not run whole.
    expect(killed.relatedTests).toEqual(['packages/cli', 'packages/core']);
    const crashed = runWith((c) =>
      relatedTestDir(c) === 'packages/core'
        ? { ...result(c, 'Startup Error'), exitCode: 1 }
        : result(c),
    );
    expect(crashed.note).toContain('1 command(s) failed.');
    expect(crashed.note).not.toContain('packages/cli, packages/core, only');
  });

  it('carries the sentence on a failure too', () => {
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith((c) =>
      relatedTestDir(c) === 'packages/core'
        ? {
            ...result(c, ' FAIL  src/a.test.ts > case'),
            exitCode: 1,
            failingFiles: ['src/a.test.ts'],
          }
        : result(c),
    );
    expect(rep.ok).toBe(false);
    expect(rep.note).toContain('1 command(s) failed.');
    expect(rep.note).toContain(
      'In packages/cli, packages/core, only the tests related to the diff ran',
    );
  });

  it('spends the name scan from the budget before it sets the deadline', () => {
    // Every directory read the scan makes takes a second.
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    for (let i = 0; i < 5; i++) write(`packages/cli/src/d${i}/x.ts`);
    writePlan(['packages/core/src/a.ts']);
    const granted: Array<{ command: string; at: number; deadline: number }> =
      [];
    clock.step = 1000;
    runWith(
      (command, _cwd, timeoutMs) => {
        granted.push({ command, at: clock.now, deadline: timeoutMs });
        return result(command);
      },
      { timeout: 600, budget: 300 },
    );
    const build = granted.find((g) => g.command.startsWith('npm run build'))!;
    const test = granted.find((g) => g.command === CORE_RUN)!;
    expect(test.at).toBeGreaterThan(build.at);
    // Both read the same budget: what is left at the moment each started.
    expect(test.deadline + test.at).toBe(build.deadline + build.at);
  });

  it('continues a run with the related commands the first call would have run', () => {
    writePlan(['packages/core/src/a.ts']);
    const outPath = previousReport({
      test: [result(CORE_RUN)],
      note: 'the whole-call budget was spent with 1 suite(s) still to run',
      // A dir no command ran: the field is read off the commands, never kept.
      relatedTests: ['packages/core', 'packages/web'],
      testScope: {
        workspaces: ['packages/core'],
        notRun: ['packages/cli'],
        caveat: 'the whole-call budget was spent',
      },
    });
    const ran: string[] = [];
    const rep = runWith(
      (c) => {
        ran.push(c);
        return result(c);
      },
      { out: outPath, resume: true },
    );
    expect(ran).toEqual([CLI_RUN]);
    expect(rep.relatedTests).toEqual(['packages/cli', 'packages/core']);
    expect(rep.note).toContain('Continued from a previous build-test call');
    expect(rep.note).toContain(
      'In packages/cli, packages/core, only the tests related to the diff ran',
    );
  });

  it('names a re-killed command in the provisional clause', () => {
    writePlan(['packages/core/src/a.ts']);
    const outPath = previousReport({
      test: [
        {
          ...result(CORE_RUN),
          exitCode: null,
          timedOut: true,
          clamped: true,
        },
      ],
      ok: false,
      timedOut: [CORE_RUN],
      testScope: { workspaces: ['packages/core'] },
    });
    // A deadline the budget shortened, then killed again: the command RAN and
    // is not still-to-run, so only the provisional clause can name it.
    const rep = runWith(
      (c) => ({ ...result(c), exitCode: null, timedOut: true }),
      { out: outPath, resume: true, timeout: 60, budget: 18 },
    );
    expect(rep.testScope?.caveat).toContain('provisional');
    expect(rep.testScope?.caveat).toContain('packages/core (related tests)');
    expect(rep.testScope?.caveat).not.toContain('vitest related --run');
  });

  it('recomputes the whole-suite reason for a continuation', () => {
    writePlan(['packages/core/package.json', 'packages/core/src/a.ts']);
    const outPath = previousReport({
      test: [],
      testScope: {
        workspaces: ['packages/core'],
        notRun: ['packages/cli'],
      },
    });
    const rep = runWith((c) => result(c), { out: outPath, resume: true });
    expect(rep.test.length).toBeGreaterThan(0);
    expect(rep.wholeSuiteReason).toBe('it changes packages/core/package.json');
    expect(rep.note).toContain('because it changes packages/core/package.json');
  });

  it('names a related run by its dir in the prose a continuation writes', () => {
    write('packages/core/src/b.ts');
    writePlan(['packages/core/src/a.ts', 'packages/core/src/b.ts']);
    const clamped =
      'npm exec --workspace="packages/core" --yes=false -- vitest related --run "src/a.ts" "src/b.ts"';
    const outPath = previousReport({
      test: [
        { ...result(clamped), exitCode: null, timedOut: true, clamped: true },
      ],
      ok: false,
      timedOut: [clamped],
      testScope: {
        workspaces: ['packages/core'],
        notRun: ['packages/cli'],
        caveat: 'the whole-call budget was spent',
      },
    });
    // A budget the continuation cannot start anything in.
    const rep = runWith((c) => result(c), {
      out: outPath,
      resume: true,
      budget: 1,
    });
    expect(rep.testScope?.caveat).toContain('packages/core (related tests)');
    expect(rep.note).toContain('packages/core (related tests)');
    for (const prose of [rep.note, rep.testScope?.caveat ?? '']) {
      expect(prose).not.toContain('vitest related --run');
      expect(prose).not.toContain('src/b.ts');
    }
  });

  it('says why nothing was narrowed when a gate stopped every suite', () => {
    manifest('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'vitest run', pretest: 'node p.js' },
    });
    manifest('packages/cli', {
      name: '@x/cli',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'vitest run', pretest: 'node p.js' },
    });
    writePlan(['packages/core/src/a.ts']);
    const rep = runWith();
    expect(rep.relatedTests).toBeUndefined();
    expect(rep.note).toContain(
      "No suite's tests were narrowed to the diff (vitest related): it runs a pretest or posttest script.",
    );
  });

  it('publishes no whole-suite reason when the budget ran no suite', () => {
    writePlan(['packages/core/package.json', 'packages/core/src/a.ts']);
    const rep = runWith((c) => result(c), { budget: 1 });
    expect(rep.test).toEqual([]);
    expect(rep.wholeSuiteReason).toBeUndefined();
    expect(rep.note).not.toContain('Every suite ran whole');
  });

  it('keeps the scope caveat when a changed path spells "Caveat:"', () => {
    // The whole-suite reason interpolates a PR-authored path; a note guard
    // that greps for the marker would let the path suppress the caveat.
    // A deleted root-level file: the reason embeds its name, and sitting
    // outside every workspace it earns the scope its own caveat.
    writePlan(['Caveat: notes.md', 'packages/core/src/a.ts']);
    const rep = runWith();
    expect(rep.wholeSuiteReason).toBe('it deletes Caveat: notes.md');
    expect(rep.testScope?.caveat).toContain('outside every workspace');
    expect(rep.note).toContain(rep.testScope!.caveat);
  });

  it('refuses to resume a report whose related command it could not have written', () => {
    writePlan(['packages/core/src/a.ts']);
    const outPath = previousReport({
      buildSet: ['packages/core'],
      test: [
        {
          ...result(
            'npm exec --workspace="packages/core" --yes=false -- vitest related --run "$(id)"',
          ),
          clamped: true,
        },
      ],
      ok: false,
      testScope: { workspaces: ['packages/core'] },
    });
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
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run --config "../shared/v.config.ts" "src/a.ts"',
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
      // An absolute config is code from outside the tree.
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run --config "/tmp/x.mjs" "src/a.ts"',
      'npm exec --workspace="packages/a" --yes=false -- vitest related --run "/etc/x.ts"',
      'npm test; id',
    ];
    expect(refused.filter((c) => TEST_COMMAND_RE.test(c))).toEqual([]);
  });
});
