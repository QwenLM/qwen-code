/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildTestReport, CommandResult } from '../build-test.js';
import type { ToolchainRunArgs } from './toolchain.js';
import { observedTestCounts } from '../test-plan.js';
import {
  detectMavenOwnership,
  isDependencyFailureLine,
  isSourceFailureLine,
  mavenExecutable,
  mavenToolchainAdapter,
  reportPaths,
  shellSelector,
} from './maven-toolchain.js';

const statfsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = { ...actual, statfsSync: statfsSyncMock };
  return { ...mock, default: mock };
});

// Plenty of disk by default, so this suite behaves the same on a nearly-full
// machine as on an empty one — the low-disk case below opts in explicitly.
beforeEach(() => {
  statfsSyncMock.mockReturnValue({ bavail: 16 * 1024 ** 3, bsize: 1 });
});

const pom = (modules: string[] = []): string => `
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>example</groupId>
  <artifactId>fixture</artifactId>
  <version>1</version>
  <modules>
    ${modules.map((module) => `<module>${module}</module>`).join('\n    ')}
  </modules>
</project>
`;

const result = (
  command: string,
  overrides: Partial<CommandResult> = {},
): CommandResult => ({
  command,
  exitCode: 0,
  seconds: 1,
  timedOut: false,
  // A real Maven run always frames output; the empty-output exit-0 shape
  // is the adapter's "never ran" classification, not a clean run.
  output: '[INFO] BUILD SUCCESS',
  ...overrides,
});

describe('maven toolchain adapter', () => {
  let root: string;
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'maven-toolchain-'));
    // One level deeper than the mkdtemp root: the reactor-escape fixtures
    // create `../outside`, which must land inside this sandbox and get
    // cleaned, not at a fixed path in the shared OS tmpdir.
    root = join(sandbox, 'repo');
    mkdirSync(root);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function writeProject(dir: string, modules: string[] = []): void {
    const path = join(root, dir);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'pom.xml'), pom(modules));
  }

  function writeReactor(): void {
    writeProject('.', ['core', 'extension', 'nested-parent']);
    writeProject('core');
    writeProject('extension');
    writeProject('nested-parent', ['nested-leaf']);
    writeProject('nested-parent/nested-leaf');
  }

  function writeWrapper(): void {
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
    chmodSync(join(root, 'mvnw'), 0o755);
  }

  /** The wrapper this platform actually executes (`mvnw.cmd` on win32):
   *  classification arms keyed on the EXECUTED wrapper need the fixture in
   *  its platform form, or they read the `mvn` fallback state instead. */
  function writeExecutedWrapper(): void {
    if (process.platform === 'win32') {
      writeFileSync(join(root, 'mvnw.cmd'), '@echo off\r\n');
    } else {
      writeWrapper();
    }
  }
  const executedWrapperName =
    process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';

  /**
   * The adapter over the sandbox reactor, with this suite's standard run
   * arguments: the temp `root`, a 5s per-command deadline, no dependency
   * warm-up, and an executor that reports every command as clean.
   *
   * Anything a case actually cares about it passes in `opts` — an `exec` that
   * scripts a failure or records the command line, `install: true`,
   * `buildOnly`, a `budget`. Spreading last means an override reads at the
   * call site instead of hiding in lines of identical setup.
   */
  const runAdapter = (
    changedFiles: string[],
    opts: Partial<Omit<ToolchainRunArgs, 'root' | 'changedFiles'>> = {},
  ): BuildTestReport =>
    mavenToolchainAdapter.run({
      root,
      changedFiles,
      timeout: 5,
      install: false,
      exec: (command) => result(command),
      ...opts,
    });

  it('marks Maven build files reactor-wide, scopes root sources to the root project, and leaves docs without targets', () => {
    writeReactor();

    expect(
      detectMavenOwnership(root, [
        'pom.xml',
        '.mvn/maven.config',
        'mvnw',
        'mvnw.cmd',
      ]),
    ).toEqual({
      reactorWide: true,
      modules: [],
    });

    // The root artifact's own src/ is owned by the root project '.': it
    // verifies with `-pl . -am`, not the entire reactor.
    expect(
      detectMavenOwnership(root, ['src/main/java/example/Root.java']),
    ).toEqual({
      reactorWide: false,
      modules: ['.'],
    });

    expect(runAdapter(['docs/guide.md'])).toMatchObject({
      toolchain: 'maven',
      affected: [],
      buildSet: [],
      build: [],
      test: [],
      ok: true,
    });
  });

  it('leaves module documentation changes without a Maven target', () => {
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/README.md', 'core/docs/guide.md'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('maven');
    expect(report.ok).toBe(true);
    expect(report.affected).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('still builds the owning module for documentation-extension files under its src/', () => {
    // The src/ guard is re-rooted to the owning module: a .txt under a
    // module's source tree is test data, not documentation.
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/src/test/resources/expected.txt'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('maven');
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl core -am test',
    ]);
  });

  it('keeps verifying the owning module when a test-fixture POM sits under its src/', () => {
    // maven-invoker ITs, archetype fixtures, and src/test/resources/projects/*
    // trees are test DATA: Maven never builds them as reactor modules and no
    // profile activates them. Reading one as a standalone project used to fail
    // the WHOLE diff closed — including the real source change beside it.
    writeReactor();
    writeProject('core/src/test/resources/projects/sample');
    const calls: string[] = [];

    const report = runAdapter(
      [
        'core/src/main/java/Core.java',
        'core/src/test/resources/projects/sample/App.java',
      ],
      {
        exec: (command) => {
          calls.push(command);
          return result(command);
        },
      },
    );

    expect(report.toolchain).toBe('maven');
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl core -am test',
    ]);
  });

  it('fails closed to reactor-wide when a skipped src/ POM would collapse to the root', () => {
    writeProject('.');
    writeProject('src/test/resources/projects/sample');
    const calls: string[] = [];

    const report = runAdapter(['src/test/resources/projects/sample/App.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    // The `src/` skip exists for test-data POMs, but the walk cannot tell a
    // fixture from a REAL module nested under `src/` (a reactor can
    // aggregate `<module>src/core</module>`). Collapsing to `-pl .` would
    // compile only the root and certify the changed module untested, so the
    // skip fails closed: the whole reactor runs instead.
    expect(report.toolchain).toBe('maven');
    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.affected).toEqual(['.']);
  });

  it('scopes root-project source fixtures with documentation extensions to the root project', () => {
    writeProject('.');
    const calls: string[] = [];

    const report = runAdapter(['src/test/resources/expected.txt'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.affected).toEqual(['.']);
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl . -am test',
    ]);
  });

  it('prefers the wrapper, runs from root, narrows modules, and forwards timeout', () => {
    writeReactor();
    // The wrapper a platform can actually execute: win32 `cmd.exe` runs
    // `mvnw.cmd` and cannot run `./mvnw`; POSIX needs the executable bit.
    const windows = process.platform === 'win32';
    if (windows) {
      writeFileSync(join(root, 'mvnw.cmd'), '@echo off\n');
    } else {
      writeWrapper();
    }
    const calls: Array<[string, string, number]> = [];
    // The deadline is wall clock from the top of the call: freeze it so
    // the forwarded deadline asserts exactly.
    const clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    let report: ReturnType<typeof mavenToolchainAdapter.run>;
    try {
      report = runAdapter(
        [
          'extension/src/main/java/example/Extension.java',
          'core/src/main/java/example/Core.java',
        ],
        {
          timeout: 17,
          exec: (command, cwd, timeout) => {
            calls.push([command, cwd, timeout]);
            return result(command);
          },
        },
      );
    } finally {
      nowSpy.mockRestore();
    }

    const executable = windows ? 'mvnw.cmd' : './mvnw';
    expect(calls).toEqual([
      [
        `${executable} --batch-mode --no-transfer-progress -pl core,extension -am test`,
        root,
        17_000,
      ],
    ]);
    expect(report).toMatchObject({
      toolchain: 'maven',
      affected: ['core', 'extension'],
      buildSet: ['core', 'extension'],
      install: null,
      build: [],
      ok: true,
    });
    expect(report.test[0]?.command).toContain('-pl core,extension -am test');
    // Agent 7 reads the note as evidence: it must say the run did NOT build
    // downstream dependents, or a dependent module gets reported as verified.
    expect(report.note).toContain('upstream dependencies only');
    expect(report.note).toContain('downstream dependents were NOT built');
  });

  it('uses mvn and test-compile for build-only mode', () => {
    writeReactor();
    const report = runAdapter(['core/src/main/java/example/Core.java'], {
      buildOnly: true,
      exec: (command, cwd) => {
        expect(cwd).toBe(root);
        return result(command);
      },
    });

    expect(report.test).toEqual([]);
    expect(report.build[0]?.command).toBe(
      'mvn --batch-mode --no-transfer-progress -pl core -am test-compile',
    );
  });

  it('does not narrow reactor-wide changes', () => {
    writeReactor();
    const report = runAdapter(['.mvn/maven.config']);

    expect(report.affected).toEqual(['.']);
    expect(report.test[0]?.command).toBe(
      'mvn --batch-mode --no-transfer-progress test',
    );
    // A full-reactor run must not carry the narrowed-run scope statement.
    expect(report.note).not.toContain('downstream dependents were NOT built');
  });

  it('discloses that a reactor-wide timeout is expected to exceed the deadline', () => {
    // On the large reactors this adapter targets, a root-POM change selects
    // the whole reactor, and `test` over it cannot finish in the default
    // deadline — say so, so no agent spends turns re-deriving it.
    writeReactor();

    const report = runAdapter(['pom.xml'], {
      timeout: 300,
      exec: (command) =>
        result(command, { exitCode: null, timedOut: true, seconds: 300 }),
    });

    expect(report.note).toContain('infrastructure result');
    expect(report.note).toContain('reactor-wide');
    expect(report.note).toContain('same scope');
  });

  it('classifies timeout and dependency resolution without fresh reports as infrastructure', () => {
    writeReactor();
    const timeout = runAdapter(['core/src/Main.java'], {
      timeout: 2,
      exec: (command) =>
        result(command, { exitCode: null, timedOut: true, seconds: 2 }),
    });
    expect(timeout.ok).toBe(false);
    expect(timeout.timedOut).toEqual([timeout.test[0]?.command]);
    expect(timeout.note).toContain('infrastructure result');

    const resolution = runAdapter(['core/src/Main.java'], {
      timeout: 2,
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });
    expect(resolution.note).toContain('infrastructure evidence');
    expect(resolution.test[0]).toMatchObject({ infrastructure: true });
    expect(timeout.test[0]?.infrastructure).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'does not classify a changed wrapper permission failure as infrastructure',
    () => {
      // On win32 `mvnw` is the other platform's wrapper and is skipped by
      // ownership, so the adapter sees no Maven target to run.

      writeReactor();
      writeWrapper();

      const report = runAdapter(['mvnw'], {
        exec: (command) =>
          result(command, {
            exitCode: 126,
            output: '/bin/sh: ./mvnw: Permission denied',
          }),
      });

      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not hide a permission failure behind `./mvnw` spelled differently',
    () => {
      // On win32 the normalized `./mvnw` path is the other platform's
      // wrapper and is skipped by ownership, so no permission-failure note
      // is produced.

      // The guard compares normalized paths: `./mvnw` and absolute paths name
      // the same wrapper the raw comparison missed.
      writeReactor();
      writeWrapper();

      const report = runAdapter(['./mvnw'], {
        exec: (command) =>
          result(command, {
            exitCode: 126,
            output: '/bin/sh: ./mvnw: Permission denied',
          }),
      });

      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
    },
  );

  it.each([
    ['sh: 1: mvn: not found', 127],
    // zsh names the command LAST; it also prints this in sh-compat mode.
    ['zsh: command not found: mvn', 127],
    ['sh: command not found: mvn', 127],
    // PowerShell's phrasing when Maven is absent.
    [
      "mvn: The term 'mvn' is not recognized as a name of a cmdlet, function, script file, or operable program",
      127,
    ],
    // fish's phrasing.
    ['fish: Unknown command: mvn', 127],
    // cmd.exe's wording when Maven is absent on Windows (exit 9009).
    ["'mvn' is not recognized as an internal or external command", 9009],
    [
      '[ERROR] Failed to execute goal on project core: java.io.IOException: No space left on device',
      1,
    ],
    ['Error: The JAVA_HOME environment variable is not defined correctly', 1],
    // mvn.cmd/mvnw.cmd on Windows when JAVA_HOME is UNSET names the failure
    // differently than the POSIX wrapper's "not defined correctly".
    ['Error: JAVA_HOME not found in your environment.', 1],
    // mvn.cmd/mvnw.cmd on Windows, when JAVA_HOME points at an invalid
    // directory.
    ['ERROR: JAVA_HOME is set to an invalid directory: C:\\old\\jdk', 1],
    ['Unable to locate a Java Runtime', 1],
  ])(
    'classifies unchanged Maven startup failures as infrastructure',
    (output, exitCode) => {
      writeReactor();

      const report = runAdapter(['core/src/Main.java'], {
        exec: (command) => result(command, { exitCode, output }),
      });

      expect(report.note).toContain('infrastructure evidence');
    },
  );

  it('does not classify unframed disk-full words as a launch failure', () => {
    // `No space left on device` without Maven's `[ERROR]` framing is a test
    // exercising a disk-full path, not an outage; free text cannot tell the
    // two apart, so the framing decides, as for dependency failures.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output: 'java.io.IOException: No space left on device',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'classifies an unchanged wrapper launch failure as infrastructure',
    () => {
      // The guard needs `executable === './mvnw'`, unreachable on win32.
      writeReactor();
      writeWrapper();

      const runWith = (exitCode: number, output: string) =>
        runAdapter(['core/src/Main.java'], {
          exec: (command) => result(command, { exitCode, output }),
        });

      const denied = runWith(126, '/bin/sh: ./mvnw: Permission denied');
      expect(denied.note).toContain('infrastructure evidence');

      // A CRLF-committed wrapper dies at shebang resolution on Linux.
      const crlf = runWith(
        126,
        '/bin/sh: ./mvnw: /bin/sh^M: bad interpreter: No such file or directory',
      );
      expect(crlf.note).toContain('infrastructure evidence');

      // Some shells report the same death with exit 127.
      const crlf127 = runWith(
        127,
        '/bin/sh: ./mvnw: /usr/bin/env: bad interpreter: No such file or directory',
      );
      expect(crlf127.note).toContain('infrastructure evidence');

      // bash >= 5.2 reports the same death with new wording.
      const bash52 = runWith(
        127,
        '/bin/sh: line 1: ./mvnw: cannot execute: required file not found',
      );
      expect(bash52.note).toContain('infrastructure evidence');

      // dash's bare wording.
      const dash = runWith(127, 'sh: ./mvnw: not found');
      expect(dash.note).toContain('infrastructure evidence');

      // A CRLF `#!/usr/bin/env sh` shebang names env, not the wrapper.
      const envCrlf = runWith(
        127,
        "/usr/bin/env: 'sh\\r': No such file or directory",
      );
      expect(envCrlf.note).toContain('infrastructure evidence');
    },
  );

  it('does not file a dependency failure as infrastructure when the diff changed build inputs', () => {
    writeReactor();
    const output =
      '[ERROR] Could not resolve dependencies for project example:core';

    for (const changed of ['pom.xml', '.mvn/maven.config', 'core/pom.xml']) {
      const report = runAdapter([changed], {
        exec: (command) => result(command, { exitCode: 1, output }),
      });
      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
    }

    // No executable wrapper exists on disk, so the run used the system
    // `mvn`: a wrapper file this run never executed cannot have caused its
    // resolution failure, so the carve-out stays — with a disclosure. Only
    // this platform's wrapper is exercised: a change confined to the OTHER
    // platform's wrapper leaves no Maven target to run at all (see the
    // other-platform-wrapper test below).
    const platformWrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
    for (const changed of [platformWrapper]) {
      const report = runAdapter([changed], {
        exec: (command) => result(command, { exitCode: 1, output }),
      });
      expect(report.note).toContain('infrastructure evidence');
      expect(report.note).toContain('wrapper change itself was not exercised');
    }
  });

  it('does not treat an inner permission error as a wrapper startup failure', () => {
    writeReactor();
    writeWrapper();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output: 'Failed to write target/generated.txt: Permission denied',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('keeps dependency resolution classified as infrastructure after fresh reports', () => {
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0"/>',
        );
        return result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:extension',
        });
      },
    });

    expect(report.test[0]?.output).toContain('[maven-test-report]');
    expect(report.note).toContain('infrastructure evidence');
  });

  it('keeps fresh failing tests as source evidence despite infrastructure words', () => {
    // The output is Maven-FRAMED: absent the fresh-failure guard it WOULD
    // classify as infrastructure, so the assertions genuinely pin the
    // precedence of fresh failing XML over the dependency carve-out.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="example.CoreTest" name="fails"><failure/></testcase></testsuite>',
        );
        return result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:extension',
        });
      },
    });

    expect(report.test[0]?.output).toContain('[maven-test-failure]');
    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('treats exit 0 with fresh failing reports as a failure, not a pass', () => {
    // surefire `testFailureIgnore` (or -Dmaven.test.failure.ignore) lets
    // `mvn test` exit 0 over failing tests; the verdict must read the XML.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="2" failures="1" errors="1" skipped="0"><testcase classname="example.CoreTest" name="fails"><failure/></testcase></testsuite>',
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.output).toContain('[maven-test-failure]');
    expect(report.note).toContain('exited 0');
    expect(report.note).toContain('test failures, not a pass');
    expect(report.note).not.toContain('Maven test passed');
  });

  it('skips malformed report directories without aborting Maven', () => {
    writeReactor();
    const reportPath = join(root, 'core', 'target', 'surefire-reports');
    mkdirSync(join(root, 'core', 'target'), { recursive: true });
    writeFileSync(reportPath, 'not a directory');
    const calls: string[] = [];

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toHaveLength(1);
    expect(report.toolchain).toBe('maven');
    expect(report.ok).toBe(true);
    expect(report.test[0]?.output).not.toContain('[maven-test-report]');
  });

  it('ignores stale XML and appends fresh module-qualified Surefire and Failsafe summaries', () => {
    writeReactor();
    const staleDir = join(root, 'core', 'target', 'surefire-reports');
    mkdirSync(staleDir, { recursive: true });
    const stale = join(staleDir, 'TEST-Stale.xml');
    writeFileSync(
      stale,
      '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="SameTest" name="stale"><failure/></testcase></testsuite>',
    );
    utimesSync(stale, new Date(1_000), new Date(1_000));

    const report = runAdapter(
      ['core/src/Main.java', 'extension/src/Extension.java'],
      {
        exec: (command) => {
          const coreDir = join(root, 'core', 'target', 'surefire-reports');
          const extensionDir = join(
            root,
            'extension',
            'target',
            'failsafe-reports',
          );
          mkdirSync(coreDir, { recursive: true });
          mkdirSync(extensionDir, { recursive: true });
          writeFileSync(
            join(coreDir, 'TEST-SameTest.xml'),
            '<testsuite tests="2" failures="1" errors="0" skipped="0"><testcase classname="example.SameTest" name="coreFailure"><failure message="boom"/></testcase><testcase classname="example.SameTest" name="pass"/></testsuite>',
          );
          writeFileSync(
            join(extensionDir, 'TEST-SameTest.xml'),
            '<testsuite tests="3" failures="0" errors="0" skipped="1"><testcase classname="example.SameTest" name="extensionPass"/></testsuite>',
          );
          return result(command, {
            exitCode: 1,
            output: '[ERROR] Tests failed',
          });
        },
      },
    );

    const output = report.test[0]?.output ?? '';
    expect(output).not.toContain('TEST-Stale.xml');
    expect(output).toContain(
      '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0',
    );
    expect(output).toContain(
      '[maven-test-failure] core/target/surefire-reports/TEST-SameTest.xml: example.SameTest#coreFailure',
    );
    // The clean rollup carries the per-report CLAMPED passed total
    // (3 tests - 1 skipped), not the raw pre-aggregated Σtests/Σskipped:
    // test-plan parses counts per line with its own clamp, and raw totals
    // would parse to a different count than the per-report truth.
    expect(output).toContain(
      '[maven-test-report] extension (1 report(s)): tests=2, failures=0, errors=0, skipped=0',
    );
    expect(output).not.toContain(
      'extension/target/failsafe-reports/TEST-SameTest.xml',
    );
    expect(report.note).toContain('module-qualified');
  });

  it('quotes exotic module selectors for the platform shell', () => {
    // Plain selectors stay bare; anything else is quoted for the shell the
    // command actually runs under — POSIX quoting is literal in cmd.exe.
    expect(shellSelector(['core', 'extension'])).toBe('core,extension');
    expect(shellSelector(['my module'], 'linux')).toBe("'my module'");
    expect(shellSelector(['my module'], 'win32')).toBe('"my module"');
  });

  it.each([
    // `,` separates `-pl` arguments and `:` makes Maven read the selector as
    // `[groupId]:artifactId` coordinates instead of a path: both change what
    // the selector MEANS, so quoting cannot rescue them.
    ['a,b'],
    ['a:b'],
    // cmd.exe expands %VAR% even inside `"…"`.
    ['a%b'],
    // A leading `-` is re-read as an option by commons-cli (`-pl -rf` dies
    // with 'Missing argument for option: pl'); a leading `!` is Maven's
    // exclusion operator — quoting preserves the bytes, not the semantics.
    ['-rf'],
    ['!foo'],
  ])('refuses a selector it cannot express for %s', (module) => {
    // These are directory names read off disk now, not entries a POM parser
    // pre-filtered — the gate has to live in the selector itself.
    expect(shellSelector([module], 'linux')).toBeNull();
    expect(shellSelector([module], 'win32')).toBeNull();
  });

  it('widens to the full reactor for a module a selector cannot carry', () => {
    // Failing closed to the whole reactor is the safe direction: it verifies
    // more than asked, where a mis-quoted selector verifies the wrong thing.
    writeProject('.', ['od,d']);
    writeProject('od,d');
    const calls: string[] = [];

    const report = runAdapter(['od,d/src/main/java/Main.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.affected).toEqual(['.']);
    expect(report.note).toContain('cannot express');
  });

  it('runs the whole reactor for a module POM change', () => {
    // A POM is parent config for everything that aggregates or inherits it.
    // This adapter models none of those edges — Maven applies the real ones
    // inside the command — so the scope widens instead of guessing a closure.
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['nested-parent/pom.xml'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.affected).toEqual(['.']);
  });

  it('reports unsupported when Maven rejects the selected project', () => {
    // The out-of-reactor / profile-inactive answer comes from Maven, which
    // evaluates profile activation, `<modules>` inheritance, and the current
    // JDK, and rejects an unknown selector before compiling anything. Nothing
    // here re-derives that from the POM text.
    writeProject('.', ['core']);
    writeProject('core');
    // On disk but absent from the reactor Maven actually assembles.
    writeProject('admin');

    const report = runAdapter(['admin/src/main/java/Admin.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not find the selected project in the reactor: admin\n',
        }),
    });

    // `unsupported` is the structured handoff, not a failed build: it carries
    // no build/test evidence for a verdict to read.
    expect(report.toolchain).toBe('unsupported');
    expect(report.build).toEqual([]);
    expect(report.test).toEqual([]);
    expect(report.note).toContain('admin');
    expect(report.note).toContain('profile-inactive');
  });

  it('collects fresh reports from a project directory nothing enumerated', () => {
    // The report sweep walks the worktree instead of a list of reactor
    // projects: which projects are active is Maven's answer, and a report
    // directory only exists where Maven actually ran.
    writeProject('.', ['core']);
    writeProject('core');
    const reports = join(
      root,
      'core',
      'generated-child',
      'target',
      'surefire-reports',
    );
    mkdirSync(reports, { recursive: true });

    const report = runAdapter(['core/src/main/java/Main.java'], {
      exec: (command) => {
        writeFileSync(
          join(reports, 'TEST-child.GenTest.xml'),
          '<testsuite name="child.GenTest" tests="4" failures="0" errors="0" skipped="0"/>',
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(true);
    expect(report.test[0]?.output).toContain('core/generated-child');
    expect(report.test[0]?.output).toContain('tests=4');
  });

  it('selects the wrapper a platform can execute', () => {
    writeProject('.');
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
    chmodSync(join(root, 'mvnw'), 0o755);
    writeFileSync(join(root, 'mvnw.cmd'), '@echo off\n');

    expect(mavenExecutable(root, 'linux')).toBe('./mvnw');
    expect(mavenExecutable(root, 'darwin')).toBe('./mvnw');
    expect(mavenExecutable(root, 'win32')).toBe('mvnw.cmd');

    rmSync(join(root, 'mvnw'));
    rmSync(join(root, 'mvnw.cmd'));
    expect(mavenExecutable(root, 'linux')).toBe('mvn');
    expect(mavenExecutable(root, 'win32')).toBe('mvn');
  });

  it.skipIf(process.platform === 'win32')(
    'falls back to mvn for a wrapper without the executable bit',
    () => {
      // A `core.fileMode=false` checkout commits mvnw mode 644; running it
      // would die with exit 126 and zero verification, so prefer system mvn.
      writeProject('.');
      writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
      expect(mavenExecutable(root, 'linux')).toBe('mvn');

      chmodSync(join(root, 'mvnw'), 0o755);
      expect(mavenExecutable(root, 'linux')).toBe('./mvnw');
    },
  );

  it('leaves repository metadata without Maven targets', () => {
    writeReactor();

    const metadata = [
      '.github/workflows/ci.yml',
      '.gitignore',
      '.gitattributes',
      'LICENSE',
      'CODEOWNERS',
      '.editorconfig',
    ];
    expect(detectMavenOwnership(root, metadata)).toEqual({
      reactorWide: false,
      modules: [],
    });

    const calls: string[] = [];
    const report = runAdapter(['.github/workflows/ci.yml'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });
    expect(report.toolchain).toBe('maven');
    expect(report.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it('rolls clean reports up per project dir and caps failing reports', () => {
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const coreDir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(coreDir, { recursive: true });
        for (let i = 0; i < 150; i++) {
          writeFileSync(
            join(coreDir, `TEST-Clean${i}.xml`),
            '<testsuite tests="2" failures="0" errors="0" skipped="0"/>',
          );
        }
        for (let i = 0; i < 120; i++) {
          writeFileSync(
            join(coreDir, `TEST-Fail${i}.xml`),
            '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="example.FailTest" name="fails"><failure/></testcase></testsuite>',
          );
        }
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    const output = report.test[0]?.output ?? '';
    // 150 clean reports become ONE rollup line, keeping the count shape
    // test-plan parses; 270 per-report lines would have bypassed the trim.
    expect(output).toContain(
      '[maven-test-report] core (150 report(s)): tests=300, failures=0, errors=0, skipped=0',
    );
    expect(output).not.toContain('TEST-Clean0.xml');
    // Failing reports roll up per PROJECT like the clean side — the
    // per-report lines' byte-order cap lost module attribution for
    // everything past the bound. The per-report case markers survive (they
    // are the module-qualified failure evidence); the COUNT line is the
    // rollup.
    expect(output).toContain(
      '[maven-test-report] core (120 failing report(s)): tests=120, failures=120, errors=0, skipped=0',
    );
    expect(output).toContain(
      '[maven-test-failure] core/target/surefire-reports/TEST-Fail0.xml: example.FailTest#fails',
    );
  });

  it('carries clamped passed totals in the clean omission marker', () => {
    // An anomalous report (Surefire does not guarantee tests >= skipped)
    // inside the omitted batch must not cancel the passed counts of its
    // batchmates — clamp the aggregated totals and it cancels two.
    const modules = Array.from({ length: 120 }, (_, i) => `mod${i}`);
    writeProject('.', modules);
    for (const module of modules) writeProject(module);

    const report = runAdapter(['mod0/src/main/java/Main.java'], {
      exec: (command) => {
        for (const module of modules) {
          const dir = join(root, module, 'target', 'surefire-reports');
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'TEST-Clean.xml'),
            // mod99 sorts into the omitted tail of the per-project rollups.
            module === 'mod99'
              ? '<testsuite tests="1" failures="0" errors="0" skipped="3"/>'
              : '<testsuite tests="1" failures="0" errors="0" skipped="0"/>',
          );
        }
        return result(command);
      },
    });

    const output = report.test[0]?.output ?? '';
    expect(output).toContain(
      '[maven-test-report] 20 more clean project rollup(s) omitted: ' +
        'tests=19, failures=0, errors=0, skipped=0',
    );
    // 100 kept rollup lines pass one test each; the omitted batch passes 19.
    expect(observedTestCounts(report)).toEqual([119]);
  });

  it('carries clamped passed totals in the failing omission marker', () => {
    const modules = Array.from({ length: 103 }, (_, i) => `mod${i}`);
    writeProject('.', modules);
    for (const module of modules) writeProject(module);

    const report = runAdapter(['mod0/src/main/java/Main.java'], {
      exec: (command) => {
        for (const module of modules) {
          const dir = join(root, module, 'target', 'surefire-reports');
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'TEST-Fail.xml'),
            // mod99 sorts into the omitted tail and passes zero despite
            // recording a test; its batchmates each pass one.
            module === 'mod99'
              ? '<testsuite tests="1" failures="5" errors="0" skipped="0"><testcase classname="example.T" name="fails"><failure/></testcase></testsuite>'
              : '<testsuite tests="2" failures="1" errors="0" skipped="0"><testcase classname="example.T" name="fails"><failure/></testcase></testsuite>',
          );
        }
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    const output = report.test[0]?.output ?? '';
    expect(output).toContain(
      '[maven-test-report] 3 more failing project rollup(s) omitted: ' +
        'tests=2, failures=0, errors=0, skipped=0',
    );
    // 100 kept failing rollups pass one test each; the omitted batch passes 2.
    expect(observedTestCounts(report)).toEqual([102]);
  });

  it('caps the clean per-project rollup lines', () => {
    const modules = Array.from({ length: 120 }, (_, i) => `mod${i}`);
    writeProject('.', modules);
    for (const module of modules) writeProject(module);

    const report = runAdapter(['mod0/src/main/java/Main.java'], {
      exec: (command) => {
        for (const module of modules) {
          const dir = join(root, module, 'target', 'surefire-reports');
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'TEST-Clean.xml'),
            '<testsuite tests="1" failures="0" errors="0" skipped="0"/>',
          );
        }
        return result(command);
      },
    });

    const output = report.test[0]?.output ?? '';
    expect(
      output.match(/\[maven-test-report\] mod\d+ \(1 report\(s\)\)/g),
    ).toHaveLength(100);
    expect(output).toContain(
      '[maven-test-report] 20 more clean project rollup(s) omitted: ' +
        'tests=20, failures=0, errors=0, skipped=0',
    );
    // The green note is the only test-count evidence on a passing Maven run;
    // its totals are computed BEFORE the cap, over all 120 reports.
    expect(report.note).toContain(
      'Maven test passed with fresh reports: 120 tests',
    );
  });

  it('caps failing case lines', () => {
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const coreDir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(coreDir, { recursive: true });
        const cases = Array.from(
          { length: 250 },
          (_, i) =>
            `<testcase classname="example.BigTest" name="case${i}"><failure/></testcase>`,
        ).join('');
        writeFileSync(
          join(coreDir, 'TEST-Big.xml'),
          `<testsuite tests="250" failures="250" errors="0" skipped="0">${cases}</testsuite>`,
        );
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    const output = report.test[0]?.output ?? '';
    expect(output).toContain(
      '[maven-test-failure] 50 more failing case(s) omitted',
    );
    expect(output.match(/\[maven-test-failure\] core\//g)).toHaveLength(200);
  });

  it('treats unframed network words as source evidence, and Maven-framed ones as infrastructure', () => {
    writeReactor();

    const unframed = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output: 'java.net.ConnectException: Connection refused',
        }),
    });
    expect(unframed.note).toContain('Correlate compiler or test errors');
    expect(unframed.note).not.toContain('infrastructure evidence');

    const framed = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Failed to execute goal on project core: Could not transfer artifact org.example:dep:jar:1: Connection refused',
        }),
    });
    expect(framed.note).toContain('infrastructure evidence');
  });

  it('does not launder a compile failure into infrastructure when dependency words share the output', () => {
    // A flaky mirror, or an upstream module pulled in by `-am`, can put one
    // `[ERROR] Could not transfer artifact` line in the same output as a
    // real compile error. The compile failure writes no Surefire XML, so
    // only the source markers keep it from reading as infrastructure.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output: [
            '[ERROR] Could not transfer artifact org.foo:bar:jar:1.0 from/to central: Connection timed out',
            '[ERROR] COMPILATION ERROR :',
            '[ERROR] /tmp/x/core/src/main/java/Main.java:[12,5] cannot find symbol',
          ].join('\n'),
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('keeps source-failure markers framed — unframed words stay infrastructure', () => {
    writeReactor();

    const runWith = (output: string) =>
      runAdapter(['core/src/Main.java'], {
        exec: (command) => result(command, { exitCode: 1, output }),
      });

    const dependencyLine =
      '[ERROR] Could not resolve dependencies for project example:core';

    // Every Maven-framed marker outranks the dependency carve-out...
    for (const marker of [
      '[ERROR] COMPILATION ERROR :',
      '[ERROR] /tmp/x/core/src/main/java/Main.java:[12,5] cannot find symbol',
      '[ERROR] There are test failures.',
    ]) {
      const report = runWith(`${dependencyLine}\n${marker}`);
      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
    }

    // ...but the same words in a test's own stdout do not.
    const unframed = runWith(`${dependencyLine}\nCOMPILATION ERROR`);
    expect(unframed.note).toContain('infrastructure evidence');
    expect(unframed.test[0]).toMatchObject({ infrastructure: true });
  });

  it('classifies a spawn-level death without an exit code as infrastructure', () => {
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => result(command, { exitCode: null, output: '' }),
    });

    expect(report.ok).toBe(false);
    expect(report.timedOut).toEqual([]);
    expect(report.note).toContain('without an exit code');
    expect(report.note).toContain('infrastructure evidence');
  });

  it('discloses successful tests without fresh XML', () => {
    writeReactor();
    const report = runAdapter(['core/src/Main.java']);

    expect(report.ok).toBe(true);
    expect(report.note).toContain('no fresh Surefire/Failsafe XML');
  });

  it('keeps fresh failing reports as test evidence when the run times out', () => {
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      timeout: 2,
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="2" failures="1" errors="1" skipped="0"><testcase classname="example.CoreTest" name="fails"><failure/></testcase></testsuite>',
        );
        return result(command, { exitCode: null, timedOut: true, seconds: 2 });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.note).toContain('ran out of time');
    expect(report.note).toContain('1 failure(s) and 1 error(s)');
    expect(report.note).toContain('treat those as test failures');
    expect(report.note).not.toContain('not a defect in the diff');
    expect(report.test[0]?.output).toContain('[maven-test-failure]');
  });

  it('keeps fresh failing reports as test evidence when the run dies without an exit code', () => {
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="example.CoreTest" name="fails"><failure/></testcase></testsuite>',
        );
        return result(command, { exitCode: null });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.note).toContain('ended without an exit code');
    expect(report.note).toContain('1 failure(s) and 0 error(s)');
    expect(report.note).toContain('treat those as test failures');
    expect(report.note).not.toContain(
      'This is infrastructure evidence, not a source finding.',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'does not classify a launch failure as infrastructure when the wrapper changed',
    () => {
      // On win32 `mvnw` is the other platform's wrapper and is skipped by
      // ownership, so the adapter sees no Maven target to run.

      // The PR's own wrapper edit may be what broke startup; the pinned intent
      // (changed-wrapper failures are never environmental) covers the
      // launch-failure disjunct too, not just the 126/127 wrapper one.
      writeReactor();
      writeWrapper();

      const report = runAdapter(['mvnw'], {
        exec: (command) =>
          result(command, {
            exitCode: 1,
            output:
              'Error: The JAVA_HOME environment variable is not defined correctly',
          }),
      });

      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not launder a PR-caused fallback launch failure into infrastructure',
    () => {
      // The diff drops the wrapper's executable bit; mavenExecutable falls
      // back to system mvn, executedWrapper is null, and a runner without
      // system Maven dies 127. That death is the diff's own doing — filing
      // it as infrastructure would let a PR that broke the build ship with
      // no finding.
      writeReactor();
      writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n'); // no executable bit

      const report = runAdapter(['mvnw'], {
        exec: (command) =>
          result(command, { exitCode: 127, output: 'sh: 1: mvn: not found' }),
      });

      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
      expect(report.test[0]?.infrastructure).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'discloses when a changed wrapper falls back to the system mvn',
    () => {
      // On win32 `mvnw` is dropped by ownership, only the Java source is
      // owned, and the run narrows to `-pl core -am test` instead of the
      // reactor-wide command pinned here.

      // No executable bit: mavenExecutable falls back to system mvn, so the
      // wrapper the diff changes is never executed — the run must say so.
      writeReactor();
      writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
      const calls: string[] = [];

      const report = runAdapter(
        ['mvnw', 'core/src/main/java/example/Core.java'],
        {
          exec: (command) => {
            calls.push(command);
            return result(command);
          },
        },
      );

      expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
      expect(report.note).toContain('wrapper change itself was not exercised');
    },
  );

  it('does not treat a test-fixture POM as a dependency input', () => {
    // A fixture pom.xml under a module's src/ tree cannot change the reactor's
    // dependency resolution; a genuine outage there stays infrastructure.
    writeReactor();
    writeProject('core/src/test/resources/projects/sample');

    const report = runAdapter(
      ['core/src/test/resources/projects/sample/pom.xml'],
      {
        exec: (command) =>
          result(command, {
            exitCode: 1,
            output:
              '[ERROR] Could not resolve dependencies for project example:core',
          }),
      },
    );

    expect(report.note).toContain('infrastructure evidence');
  });

  it('reports insufficient disk space instead of running Maven on a full disk', () => {
    statfsSyncMock.mockReturnValue({ bavail: 5.4e8, bsize: 1 }); // ~0.5G free
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.ok).toBe(false);
    expect(report.build).toEqual([]);
    expect(report.test).toEqual([]);
    expect(calls).toEqual([]);
    expect(report.note).toContain('Insufficient disk space');
  });

  it('re-checks the disk floor after the warm-up, before the lifecycle', () => {
    // The warm-up is the phase that fills the disk: a cold reactor's
    // dependency:go-offline can consume the headroom the preflight
    // passed, and the lifecycle must not run on the now-full disk.
    statfsSyncMock
      .mockReturnValueOnce({ bavail: 16 * 1024 ** 3, bsize: 1 })
      .mockReturnValueOnce({ bavail: 0, bsize: 1 });
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/src/Main.java'], {
      timeout: 60,
      install: true,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    // Only the warm-up ran; the lifecycle was skipped and disclosed.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('dependency:go-offline');
    expect(report.ok).toBe(false);
    expect(report.build).toEqual([]);
    expect(report.test).toEqual([]);
    expect(report.note).toContain('Insufficient disk space');
    expect(report.note).toContain('warm-up');
  });

  it('attributes failures to the failing cases in declaration order', () => {
    // Surefire writes passing cases self-closing, in execution order: a
    // passing case must not absorb the following case's failure, and the
    // real failing cases must be the ones reported.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="4" failures="2" errors="0" skipped="0">' +
            '<testcase classname="example.CoreTest" name="alpha" time="0.01"/>' +
            '<testcase classname="example.CoreTest" name="beta" time="0.01"><failure message="boom"/></testcase>' +
            '<testcase classname="example.CoreTest" name="gamma" time="0.01"/>' +
            '<testcase classname="example.CoreTest" name="delta" time="0.01"><failure message="boom"/></testcase>' +
            '</testsuite>',
        );
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    const output = report.test[0]?.output ?? '';
    expect(output).toContain('example.CoreTest#beta');
    expect(output).toContain('example.CoreTest#delta');
    expect(output).not.toContain('CoreTest#alpha');
    expect(output).not.toContain('CoreTest#gamma');
  });

  it('keeps counts and identity when attribute values carry `>`', () => {
    // A \`>\` is legal unescaped inside a quoted XML attribute value —
    // parameterized-test and @DisplayName names carry them.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite name="Params [a > b]" tests="1" failures="1" errors="0" skipped="0">' +
            '<testcase classname="example.T" name="fails [x > y]"><failure message="boom"/></testcase>' +
            '</testsuite>',
        );
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    expect(report.ok).toBe(false);
    const output = report.test[0]?.output ?? '';
    expect(output).toContain('tests=1, failures=1, errors=0, skipped=0');
    expect(output).toContain('example.T#fails [x > y]');
  });

  it('aggregates every suite in one report file', () => {
    // Aggregate JUnit writers (jest-junit, karma) emit several <testsuite>
    // elements per file; reading only the first undercounts later suites'
    // failures to zero and discards the failing cases.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Aggregate.xml'),
          '<testsuites>' +
            '<testsuite name="one" tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.One" name="pass"/></testsuite>' +
            '<testsuite name="two" tests="1" failures="1" errors="0" skipped="0">' +
            '<testcase classname="example.Two" name="fails"><failure/></testcase>' +
            '</testsuite>' +
            '</testsuites>',
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(false);
    const output = report.test[0]?.output ?? '';
    expect(output).toContain('tests=2, failures=1, errors=0, skipped=0');
    expect(output).toContain('example.Two#fails');
    expect(report.note).toContain('exited 0');
  });

  it('ignores oversized report files rather than parsing them', () => {
    // Evidence files are PR-controlled: the size cap keeps a multi-megabyte
    // file from burning the outer deadline, at the cost of its evidence.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Huge.xml'),
          '<testsuite tests="1" failures="1" errors="0" skipped="0">' +
            '<testcase classname="example.Huge" name="x"'.repeat(60_000),
        );
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.output).not.toContain('TEST-Huge.xml');
  });

  it('does not pass a zero exit that recorded framed compile errors', () => {
    // A fail-never setting (-fn/--fail-never) makes Maven exit 0 over a
    // compilation failure; no Surefire XML exists for freshFailures to see.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output:
            '[ERROR] COMPILATION ERROR :\n' +
            '[ERROR] /x/core/src/main/java/example/Main.java:[12,5] cannot find symbol',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.swallowedFailure).toBe(true);
    expect(report.test[0]?.infrastructure).toBeUndefined();
    expect(report.note).toContain('exited 0');
    expect(report.note).toContain('fail-never');
    expect(report.note).not.toContain('Maven test passed');
  });

  it('classifies a fail-never dependency failure as infrastructure', () => {
    // The same masking at the dependency phase — unless the diff changed
    // the resolution inputs — stays environmental like the exit-1 form.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
    expect(report.note).toContain('infrastructure evidence');
    expect(report.note).toContain('fail-never');
  });

  it('keeps a fail-never dependency failure PR-attributed when the inputs changed', () => {
    // The exit-0 half of the dependency carve-out exception: with resolution
    // inputs changed, the swallowed failure stays a failed run — not green,
    // and not laundered into an environmental result.
    writeReactor();

    const report = runAdapter(['core/pom.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBeUndefined();
    expect(report.test[0]?.swallowedFailure).toBe(true);
    expect(report.note).toContain('fail-never');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('keeps Kotlin compile failures source-attributed beside dependency words', () => {
    writeReactor();

    const report = runAdapter(['core/src/Main.kt'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not transfer artifact org.example:lib:pom:1 from central: Connection timed out\n' +
            '[ERROR] Failed to execute goal org.jetbrains.kotlin:kotlin-maven-plugin:1.9.0:compile (default-compile) on project core: Compilation failure\n' +
            '[ERROR] /x/core/src/main/kotlin/example/Main.kt: (12, 5): Unresolved reference: foo',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('still builds the owning module for compilable files under a doc prefix', () => {
    // The docs?/ prefix exempts documentation EXTENSIONS only: a .java file
    // under doc/ is compilable input, not documentation.
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/README.md', 'core/doc/Helper.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('maven');
    expect(report.affected).toEqual(['core']);
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl core -am test',
    ]);
  });

  it('leaves module repository metadata without Maven targets', () => {
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/LICENSE', 'core/.gitignore'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('maven');
    expect(report.ok).toBe(true);
    expect(report.affected).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('treats settings referenced by .mvn/maven.config as dependency inputs', () => {
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(join(root, '.mvn', 'maven.config'), '-s\nsettings.xml\n');
    writeFileSync(join(root, 'settings.xml'), '<settings/>\n');

    const report = runAdapter(['settings.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('fails closed past the read cap for .mvn/maven.config', () => {
    // The one PR-controlled read without a size cap: a config past the
    // cap is treated like an unreadable one (its referenced locations
    // unknown), while the config FILE itself stays a dependency input
    // through the `.mvn/` prefix — so the suppression still stands.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(
      join(root, '.mvn', 'maven.config'),
      `-s\nsettings.xml ${'x'.repeat(2 * 1024 * 1024)}\n`,
    );
    writeFileSync(join(root, 'settings.xml'), '<settings/>\n');

    // Oversized: the settings reference is unknown, so a dependency
    // outage over a changed settings.xml keeps the infrastructure
    // carve-out...
    const oversized = runAdapter(['settings.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });
    expect(oversized.note).toContain('infrastructure evidence');

    // ...and under the cap the identical config suppresses it.
    writeFileSync(join(root, '.mvn', 'maven.config'), '-s\nsettings.xml\n');
    const undersized = runAdapter(['settings.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });
    expect(undersized.note).toContain('Correlate compiler or test errors');
    expect(undersized.note).not.toContain('infrastructure evidence');
  });

  it('leaves no Maven target when only the other platform wrapper changed', () => {
    // POSIX executes ./mvnw, win32 mvnw.cmd; a change confined to the other
    // platform's wrapper cannot affect this platform's run, so no reactor-wide
    // run burns the deadline verifying nothing.
    writeReactor();
    const win32 = process.platform === 'win32';
    const executed = win32 ? 'mvnw.cmd' : 'mvnw';
    const other = win32 ? 'mvnw' : 'mvnw.cmd';
    writeFileSync(join(root, executed), win32 ? '@echo off\n' : '#!/bin/sh\n');
    if (!win32) chmodSync(join(root, executed), 0o755);
    writeFileSync(join(root, other), win32 ? '#!/bin/sh\n' : '@echo off\n');
    const calls: string[] = [];

    const report = runAdapter([other], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.note).toContain('no Maven target');

    // The carve-out itself still holds in its reachable shape: when the diff
    // ALSO changes module sources, the other platform's wrapper is not a
    // resolution input and cannot suppress the dependency carve-out.
    const mixed = runAdapter([other, 'core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });
    expect(mixed.note).toContain('infrastructure evidence');
    expect(mixed.note).toContain('wrapper change itself was not exercised');
  });

  it('clamps negative report counts to zero', () => {
    // A malformed failures="-3" must not cancel legitimate counts when
    // totals roll up across reports.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="-3" errors="0" skipped="0">' +
            '<testcase classname="example.T" name="pass"/></testsuite>',
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(true);
    expect(report.test[0]?.output).toContain(
      '[maven-test-report] core (1 report(s)): tests=1, failures=0, errors=0, skipped=0',
    );
  });

  it('runs a dependency warm-up with its own deadline when installing', () => {
    // A review worktree is cold by construction; without the warm-up the
    // cold resolve shares the single lifecycle deadline with compilation
    // and the tests. The warm-up runs first, narrowed to the same scope,
    // and its result is recorded as the report's install.
    writeReactor();
    const calls: Array<[string, number]> = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/main/java/example/Core.java'],
      timeout: 9,
      // A budget above the two 9s deadlines keeps them whole; the budget
      // regime itself is pinned by the tests below.
      budget: 600,
      install: true,
      exec: (command, _cwd, timeoutMs) => {
        calls.push([command, timeoutMs]);
        return result(command);
      },
    });

    expect(calls).toEqual([
      [
        'mvn --batch-mode --no-transfer-progress -pl core -am dependency:go-offline -q',
        9_000,
      ],
      ['mvn --batch-mode --no-transfer-progress -pl core -am test', 9_000],
    ]);
    expect(report.install?.command).toContain('dependency:go-offline');
    expect(report.ok).toBe(true);
    expect(report.note).not.toContain('Dependency warm-up');
  });

  it('keeps module attribution for failing projects past the rollup cap', () => {
    // The omitted-failing-rollup marker used to zero the failure counts of
    // every project past the cap; when the case-line cap ALSO dropped the
    // claimed module's lines, both attribution channels went dark and the
    // `-am` carve-out discarded a run that failed inside the claim. Each
    // omitted project keeps one module-prefixed failure marker.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        for (let i = 0; i < 101; i++) {
          const module = `m${String(i).padStart(3, '0')}`;
          const dir = join(root, module, 'target', 'surefire-reports');
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'TEST-Fail.xml'),
            '<testsuite tests="1" failures="1" errors="0" skipped="0">' +
              `<testcase classname="example.T${i}" name="fails"><failure/></testcase>` +
              '</testsuite>',
          );
        }
        return result(command, { exitCode: 1 });
      },
    });

    const output = report.test[0]?.output ?? '';
    // m100 sorts last in byte order and sits past the 100-project rollup
    // cap — its failure attribution survives as a module-prefixed marker.
    expect(output).toContain('[maven-test-failure] m100/target/');
    expect(output).toContain('1 more failing project rollup(s) omitted');
    expect(report.ok).toBe(false);
  }, 30_000);

  it('keeps the lifecycle verdict when the warm-up fails or times out', () => {
    // The warm-up is best-effort: a partial local repository is
    // content-addressed and resumable (unlike a partial node_modules), so
    // no warm-up outcome may block the lifecycle run or change its verdict.
    writeReactor();

    const timedOut = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      // Keep both 5s deadlines whole despite the warm-up's wall time.
      budget: 600,
      install: true,
      exec: (command, _cwd, timeoutMs) =>
        command.includes('dependency:go-offline')
          ? result(command, {
              exitCode: null,
              timedOut: true,
              seconds: 5,
              deadlineMs: timeoutMs,
            })
          : result(command),
    });
    expect(timedOut.ok).toBe(true);
    expect(timedOut.test).toHaveLength(1);
    // The report-level list names EVERY command killed by its deadline —
    // the warm-up too, like the npm adapter's install command.
    expect(
      timedOut.timedOut.some((c) => c.includes('dependency:go-offline')),
    ).toBe(true);
    expect(timedOut.note).toContain('Dependency warm-up');
    expect(timedOut.note).toContain('ran out of time (5s)');

    const failed = runAdapter(['core/src/Main.java'], {
      budget: 600,
      install: true,
      exec: (command) =>
        command.includes('dependency:go-offline')
          ? result(command, { exitCode: 1 })
          : result(command),
    });
    expect(failed.ok).toBe(true);
    expect(failed.note).toContain('Dependency warm-up');
    expect(failed.note).toContain('exited 1');

    // A spawn death without a deadline is its own arm: the note must not
    // read "ran out of time" for a warm-up the deadline never touched.
    const spawnDied = runAdapter(['core/src/Main.java'], {
      budget: 600,
      install: true,
      exec: (command) =>
        command.includes('dependency:go-offline')
          ? result(command, { exitCode: null })
          : result(command),
    });
    expect(spawnDied.ok).toBe(true);
    expect(spawnDied.note).toContain('Dependency warm-up');
    expect(spawnDied.note).toContain('ended without an exit code');
  });

  it('widens to the full reactor when the -pl selector exceeds the launch-safe length', () => {
    // A wide diff selects many modules at once; on large reactors the
    // comma-joined selector approaches cmd.exe's 8191-character line limit,
    // so past the cap the run widens to the full reactor instead of shipping
    // a command line the platform may refuse to launch.
    const leaves = Array.from(
      { length: 100 },
      (_, i) =>
        `module-with-a-rather-long-directory-name-${String(i).padStart(2, '0')}`,
    );
    writeProject('.', ['agg']);
    writeProject('agg', leaves);
    for (const leaf of leaves) writeProject(`agg/${leaf}`);
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      // Source files, not POMs: a POM change is reactor-wide on its own, and
      // this case must reach the selector-length guard instead.
      changedFiles: leaves.map((leaf) => `agg/${leaf}/src/main/java/Main.java`),
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.affected).toEqual(['.']);
    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.note).toContain('selector exceeded 4096 characters');
    expect(report.note).toContain('full reactor');
  });

  it('does not launder a test-printed launch diagnostic into infrastructure', () => {
    // Unframed launch words count only in the prelude before Maven's own
    // output starts: once a Maven-framed line has appeared, a test printing
    // `mvn: command not found` in its stdout must not mask a source failure.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output: [
            '[INFO] Scanning for projects...',
            '[INFO] --- surefire:test ---',
            'sh: 1: mvn: not found',
          ].join('\n'),
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('treats .mvn/wrapper configuration as part of the wrapper', () => {
    // maven-wrapper.properties names the distribution ./mvnw downloads and
    // executes; a diff touching it controls what the wrapper runs exactly
    // as one touching the script does, so the startup failure is the
    // diff's to answer for, not the environment's.
    writeReactor();
    writeExecutedWrapper();

    const report = runAdapter(['.mvn/wrapper/maven-wrapper.properties'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            'Error: The JAVA_HOME environment variable is not defined correctly',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('builds the owning module for resource-like text files outside doc locations', () => {
    // A .txt is only exempted at doc-shaped locations: a resource wired
    // into the artifact via maven-resources-plugin (which points at
    // arbitrary dirs) must keep the build instead of silently skipping it.
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/config/messages.txt'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.affected).toEqual(['core']);
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl core -am test',
    ]);
  });

  it('still exempts doc-extension files at the module top level and in site/', () => {
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/notes.txt', 'core/site/index.rst'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.ok).toBe(true);
    expect(report.affected).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('does not parse CDATA-wrapped report content as markup', () => {
    // `<system-out>` CDATA is the standard vehicle for test output that
    // itself contains XML; scanning it as markup fabricated phantom suites
    // and failure evidence for a passing one-test suite.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.CoreTest" name="passes">' +
            '<system-out><![CDATA[<testsuite tests="3" failures="2" errors="1">' +
            '<testcase classname="ghost.Case" name="phantom"><failure/>' +
            '</testcase></testsuite>]]></system-out>' +
            '</testcase></testsuite>',
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(true);
    expect(report.test[0]?.output).toContain('tests=1, failures=0');
    expect(report.test[0]?.output).not.toContain('[maven-test-failure]');
  });

  it('files a resolution failure against a diff that deleted a POM', () => {
    // `legacy/pom.xml` exists only in the diff — the shape a deletion leaves.
    // Deleting a POM is one of the likeliest ways a diff breaks resolution
    // (`Non-resolvable parent POM`, a module Maven can no longer read), and
    // deciding WHICH deleted POMs could have caused THIS failure needs the
    // effective model this adapter deliberately does not carry. So any
    // changed POM withdraws the infrastructure carve-out: over-attributing
    // costs a visible failure carrying Maven's own output, while
    // under-attributing ships the diff's own breakage as someone else's
    // outage.
    writeReactor();

    const report = runAdapter(['core/src/Main.java', 'legacy/pom.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).not.toContain('infrastructure evidence');
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('parses a report of unterminated openers in linear time', () => {
    // The quadratic pre-fix regex scan spent seconds per 256 KiB of
    // never-closed `<testcase` openers — a denial of service through
    // PR-controlled report bytes. The linear scan must stay fast at the
    // size cap; the bound is generous (slow CI) yet far below the
    // pre-fix extrapolation of tens of seconds at this input size. The
    // suite header is load-bearing: without it parseTestReport returns at
    // `suites === 0` and never reaches the testcase walk this pins.
    writeReactor();
    const startedAt = Date.now();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.CoreTest" name="passes"/>' +
            '</testsuite>' +
            '<testcase x '.repeat(100_000),
        );
        return result(command);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // The garbage ends in an opener whose `>` never comes: the interrupted
    // header walk discards every later body, so the report is rejected and
    // the run fails closed instead of reading the surviving prefix green.
    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
  }, 20_000);

  it('fails closed past the fresh-report evidence cap, and discloses the omission', () => {
    // The mtime freshness filter accepts any writer, so the PR's own
    // tests control how many reports exist at parse time. Past the cap
    // the parse stops; the reports beyond it carry UNKNOWN failure
    // status, so the run must not certify a clean pass over them — the
    // evidence block discloses the omission and the verdict fails closed.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 1005; i++) {
          writeFileSync(
            join(dir, `TEST-Case${String(i).padStart(4, '0')}.xml`),
            '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
              `<testcase classname="example.Case${i}" name="passes"/>` +
              '</testsuite>',
          );
        }
        return result(command);
      },
    });

    expect(report.ok).toBe(false);
    expect(report.note).toContain('not certified as a pass');
    expect(report.test[0]?.output).toContain(
      '5 more fresh report(s) not parsed',
    );
    expect(report.test[0]?.output).toContain(
      '1000-report evidence cap was reached',
    );
  }, 30_000);

  it('caps the failing cases one report accumulates, and counts the drop', () => {
    // One report can carry tens of thousands of failing `<testcase>`
    // entries; the parse caps them while building, and the omission
    // marker accounts for the drop instead of silently losing it.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        const cases = Array.from(
          { length: 250 },
          (_, i) =>
            `<testcase classname="example.Bulk" name="case${i}"><failure/></testcase>`,
        ).join('');
        writeFileSync(
          join(dir, 'TEST-Bulk.xml'),
          `<testsuite tests="250" failures="250" errors="0" skipped="0">${cases}</testsuite>`,
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(false);
    const output = report.test[0]?.output ?? '';
    expect(output).toContain('tests=250, failures=250');
    expect(output).toContain('50 more failing case(s) omitted');
    // The kept case lines stop at the display cap.
    expect(output.match(/\[maven-test-failure\] core\/target/g)?.length).toBe(
      200,
    );
  }, 30_000);

  it('parses a suite header of unpaired attribute-name runs in linear time', () => {
    // `xmlAttributes` backtracked quadratically on a long attribute-name
    // run with no `=` — the same denial-of-service class, entering through
    // the suite header instead of the testcase walk.
    writeReactor();
    const startedAt = Date.now();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          `<testsuite ${'a'.repeat(1_000_000)} tests="1" failures="0" ` +
            'errors="0" skipped="0"></testsuite>',
        );
        return result(command);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(report.ok).toBe(true);
  }, 20_000);
  it('walks stacked openers-before-closers reports in linear time', () => {
    // Every opener preceding every closer used to re-find the same early
    // closing tag for each later opener — quadratic inside the 2 MiB cap,
    // and still reporting ok:true while burning the outer deadline. Bodies
    // are consumed forward-only now, so the walk stays O(n).
    writeReactor();
    const startedAt = Date.now();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.T" name="t">'.repeat(30_000) +
            '</testcase>'.repeat(30_000) +
            '</testsuite>',
        );
        return result(command);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(report.ok).toBe(true);
  }, 20_000);

  it('treats attached -s<path> settings as dependency inputs too', () => {
    // commons-cli accepts the attached short form (`-sci/settings.xml`);
    // missing it laundered a PR-caused resolution break into
    // infrastructure.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    mkdirSync(join(root, 'ci'));
    writeFileSync(join(root, '.mvn', 'maven.config'), '-sci/settings.xml\n');
    writeFileSync(join(root, 'ci', 'settings.xml'), '<settings/>\n');

    const report = runAdapter(['ci/settings.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('quotes the deadline the lifecycle actually ran under in its timeout note', () => {
    // The warm-up spends shared budget first, so the lifecycle fires a
    // shorter deadline than the --timeout flag; the note must quote the
    // number that fired, not the flag default.
    writeReactor();
    let clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    try {
      const report = runAdapter(['core/src/Main.java'], {
        timeout: 300,
        budget: 60,
        install: true,
        exec: (command, _cwd, timeoutMs) => {
          clock += 45_000;
          return command.includes('dependency:go-offline')
            ? result(command, { deadlineMs: timeoutMs })
            : result(command, {
                exitCode: null,
                timedOut: true,
                seconds: 15,
                deadlineMs: timeoutMs,
              });
        },
      });

      expect(report.ok).toBe(false);
      expect(report.note).toContain('ran out of time (15s)');
      expect(report.note).not.toContain('ran out of time (300s)');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('spends the whole-call budget across warm-up and lifecycle', () => {
    // The warm-up and the lifecycle command share one budget: each gets
    // the smaller of its own deadline and what remains, and --budget
    // shortens the sum (both execs would otherwise take the full 300s).
    writeReactor();
    let clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const calls: Array<[string, number]> = [];

    try {
      const report = runAdapter(['core/src/Main.java'], {
        timeout: 300,
        budget: 60,
        install: true,
        exec: (command, _cwd, timeoutMs) => {
          calls.push([command, timeoutMs]);
          clock += 40_000;
          return result(command);
        },
      });

      expect(calls).toEqual([
        [
          'mvn --batch-mode --no-transfer-progress -pl core -am dependency:go-offline -q',
          60_000,
        ],
        ['mvn --batch-mode --no-transfer-progress -pl core -am test', 20_000],
      ]);
      expect(report.ok).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('discloses instead of attempting a lifecycle below the attempt floor', () => {
    // A warm-up that spends the budget leaves less than the 15s floor for
    // the lifecycle: an "attempt" would manufacture a fake timeout, so the
    // run discloses that nothing could be built or tested.
    writeReactor();
    let clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const calls: string[] = [];

    try {
      const report = runAdapter(['core/src/Main.java'], {
        timeout: 300,
        budget: 60,
        install: true,
        exec: (command, _cwd, timeoutMs) => {
          calls.push(command);
          clock += 50_000;
          // A cold reactor's warm-up really does eat the budget by timing
          // out; the disclosure must survive the budget early-return. The
          // recorded deadline mirrors the production exec: the note must
          // quote the 60s that fired, not the 300s flag default.
          return command.includes('dependency:go-offline')
            ? result(command, {
                exitCode: null,
                timedOut: true,
                seconds: 50,
                deadlineMs: timeoutMs,
              })
            : result(command);
        },
      });

      expect(calls).toEqual([
        'mvn --batch-mode --no-transfer-progress -pl core -am dependency:go-offline -q',
      ]);
      expect(report.ok).toBe(false);
      expect(report.test).toEqual([]);
      expect(report.install?.command).toContain('dependency:go-offline');
      expect(report.note).toContain('whole-call budget (60s) was spent');
      expect(report.note).toContain('informational');
      expect(report.note).toContain('ran out of time (60s)');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runs nothing when the budget is below the attempt floor from the start', () => {
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/src/Main.java'], {
      timeout: 300,
      budget: 5,
      install: true,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.install).toBeNull();
    // Nothing ever ran, so the note must not claim the budget "was
    // spent" — it names the floor the grant fell short of instead.
    expect(report.note).toContain('granted budget (5s) is below the');
    expect(report.note).toContain('15s minimum');
    expect(report.note).not.toContain('was spent');
  });

  it('applies the attempt floor to a --no-install run with no warm-up', () => {
    // The disclosure check runs unconditionally after the warm-up block: a
    // lifecycle-only run below the floor must not execute a sub-floor
    // deadline and record the manufactured timeout as a real run.
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['core/src/Main.java'], {
      timeout: 300,
      budget: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual([]);
    expect(report.install).toBeNull();
    expect(report.ok).toBe(false);
    expect(report.note).toContain('granted budget (5s) is below the');
    expect(report.note).toContain('15s minimum');
  });

  it.each([
    ['[ERROR] Non-resolvable import POM for example:bom:1 at line 42'],
    ['[ERROR] Failure to find example:core:jar:1 in central was cached'],
    ['[ERROR] Could not find artifact example:core:jar:1 in central'],
    ['[ERROR] Failed to collect dependencies at example:core:jar:1'],
    ['[ERROR] Failed to read artifact descriptor for example:core:jar:1'],
    ['[ERROR] Non-resolvable parent POM for example:core:1'],
    [
      '[ERROR] org.apache.maven.plugin.dependency.PluginResolutionException: boom',
    ],
    [
      '[ERROR] org.eclipse.aether.resolution.DependencyResolutionException: boom',
    ],
    ["[ERROR] No plugin found for prefix 'jetty'"],
    ['[ERROR] Unknown host: repo.maven.apache.org'],
    ['[ERROR] Name or service not known'],
    ['[ERROR] Temporary failure in name resolution'],
    ['[ERROR] Connection reset'],
    [
      '[ERROR] PKIX path building failed: unable to find valid certification path',
    ],
    ['[ERROR] status code: 401, reason phrase: Unauthorized'],
    ['[ERROR] status code: 403, reason phrase: Forbidden'],
    ['[ERROR] status code: 407, reason phrase: Proxy Authentication Required'],
    ['[ERROR] status code: 429, reason phrase: Too Many Requests'],
    ['[ERROR] status code: 503, reason phrase: Service Unavailable'],
  ])('classifies %s as a dependency failure', (line) => {
    expect(isDependencyFailureLine(line)).toBe(true);
  });

  it('falls back to mvn for an EMPTY executable wrapper', () => {
    // An empty ./mvnw passes the existence/exec-bit gates and exits 0 over
    // a build that never started — the run would read green.
    writeProject('.');
    writeFileSync(join(root, 'mvnw'), '');
    chmodSync(join(root, 'mvnw'), 0o755);
    expect(mavenExecutable(root, 'linux')).toBe('mvn');

    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
    expect(mavenExecutable(root, 'linux')).toBe('./mvnw');

    // The win32 branch carries the same size gate on `mvnw.cmd`.
    writeFileSync(join(root, 'mvnw.cmd'), '');
    expect(mavenExecutable(root, 'win32')).toBe('mvn');
    writeFileSync(join(root, 'mvnw.cmd'), '@echo off\n');
    expect(mavenExecutable(root, 'win32')).toBe('mvnw.cmd');
  });

  it('reads a fail-never plugin goal failure as a swallowed failure', () => {
    // Under fail-never Maven exits 0 over ANY failed goal, and only the
    // compile/dependency/launch classes were recognized before: a
    // checkstyle goal failure read green.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output:
            '[INFO] BUILD SUCCESS\n' +
            '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-checkstyle-plugin:3.3.1:check (validate) on project core: You have 1 Checkstyle violation.',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.swallowedFailure).toBe(true);
    expect(report.note).toContain('fail-never');
  });

  it('keeps a swallowed dependency goal failure infrastructure', () => {
    // `Failed to execute goal on project …` matches the goal framing too;
    // a dependency-class death must keep its acquisition carve-out.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output:
            '[ERROR] Failed to execute goal on project core: Could not resolve dependencies for project example:core:jar:1',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
    expect(report.note).toContain('infrastructure evidence');
  });

  it('does not read forged framing as swallowed failure over green fresh reports', () => {
    // Surefire echoes test stdout into the build output verbatim, so a
    // fully green run whose test PRINTS an `[ERROR] Failed to execute goal`
    // line used to flip swallowedFailure and read the run as failing. With
    // green fresh reports and no fail-never setting, framed lines cannot be
    // Maven's own — Maven prints no `[ERROR]` on success.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="T" name="ok"/></testsuite>',
        );
        return result(command, {
          exitCode: 0,
          output:
            'some test printed:\n' +
            '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-checkstyle-plugin:3.3.1:check on project fixture: boom\n' +
            '[INFO] BUILD SUCCESS',
        });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.test[0]?.swallowedFailure).toBeUndefined();
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('keeps fail-never swallowed failures failing beside green fresh reports', () => {
    // The one setting that lets framed `[ERROR]` failures coexist with a
    // green exit AND green reports: a multi-module run where an upstream
    // module tested green and a later module's goal failure was swallowed.
    // Detectable from `.mvn/maven.config`, so the defense stays off there.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(join(root, '.mvn', 'maven.config'), '-fn\n');
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="T" name="ok"/></testsuite>',
        );
        return result(command, {
          exitCode: 0,
          output:
            '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-checkstyle-plugin:3.3.1:check on project extension: boom\n' +
            '[INFO] BUILD SUCCESS',
        });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.swallowedFailure).toBe(true);
  });

  it('folds rescue overflow into evidenceCapped', () => {
    // The trim's rescue cap can drop failure-evidence lines before the
    // adapter classifies the output: the same epistemic state as the
    // fresh-report gaps — refuse to certify, never read green.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => result(command, { exitCode: 0, rescueOverflow: true }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
    expect(report.note).toContain('rescue cap');
  });

  it('classifies a localized system-mvn launch death as infrastructure', () => {
    // The shape arm covered only `./mvnw`; a system `mvn` launch death was
    // classified exclusively by the English-only wording regexes — under a
    // non-English LANG the environmental absence read as a source failure.
    // No wrapper in this fixture: the platform falls back to system `mvn`.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 127,
          output: 'mvn : commande introuvable',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
    expect(report.note).toContain('infrastructure evidence');
  });

  it('discloses the unscopable npm half of a mixed root', () => {
    // npm's gate refused this root package.json (an unmodeled glob), so
    // Maven was selected ALONE — the green run must not certify files no
    // Maven module owns.
    writeReactor();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'frontend', workspaces: ['packages/**'] }),
    );

    const report = runAdapter(['core/src/Main.java']);

    expect(report.ok).toBe(true);
    expect(report.note).toContain('files outside the Maven reactor');
    expect(report.note).toContain('were NOT verified');
  });

  it('treats a changed path outside the worktree as unowned, never as reactor evidence', () => {
    // The `../outside` escape the sandbox nesting above exists to contain:
    // an out-of-worktree path must not reach owningProject, whose upward
    // walk could find a pom.xml ABOVE the worktree and emit an
    // out-of-worktree `-pl` selector.
    writeReactor();
    writeProject('../outside');

    expect(
      detectMavenOwnership(root, ['../outside/src/main/java/Main.java']),
    ).toEqual({ reactorWide: false, modules: [] });
    expect(
      detectMavenOwnership(root, [
        'core/../../outside/src/main/java/Main.java',
      ]),
    ).toEqual({ reactorWide: false, modules: [] });
  });

  it('fails closed to reactor-wide for a real module nested under a src/ path', () => {
    // The positive control for the root-collapse guard: a reactor can
    // aggregate `<module>src/core</module>`, and `-pl .` would compile only
    // the root — the changed module untested under a green verdict.
    writeProject('.', ['src/core']);
    writeProject('src/core');
    const calls: string[] = [];

    const report = runAdapter(['src/core/src/main/java/Foo.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.affected).toEqual(['.']);
  });

  it('reads a skip-tests setting as a swallowed failure, never a pass', () => {
    // `-DskipTests` exits 0 having run ZERO tests, and Surefire's skip path
    // emits no framed error and no XML — without the marker check the run
    // was certified green over nothing.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output: '[INFO] Tests are skipped.\n[INFO] BUILD SUCCESS',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.swallowedFailure).toBe(true);
    expect(report.note).toContain('Tests are skipped.');
    expect(report.note).toContain('nothing was tested');
  });

  it('classifies a wrapper distribution-download failure as infrastructure', () => {
    // The canonical cold-worktree acquisition failure: the download dies
    // before Maven's JVM starts, so the diagnostics are unframed and exit 1
    // — not the 126/127 wrapper-launch shapes.
    writeReactor();
    writeWrapper();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            "wget: unable to resolve host address 'repo.maven.apache.org'\n",
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
    expect(report.note).toContain('infrastructure evidence');
  });

  it('classifies colored Maven output exactly like plain output', () => {
    // `-Dstyle.color=always` interleaves SGR codes before the framed tokens;
    // every classification predicate anchors on the framing, so the strip
    // must happen before classification — colored bytes once laundered a
    // failed compile under fail-never into a green verdict.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output:
            '\x1b[1;31m[ERROR]\x1b[m COMPILATION ERROR\n' +
            '\x1b[1;31m[ERROR]\x1b[m /repo/core/src/Main.java:[3,5] cannot find symbol\n' +
            '\x1b[1;32m[INFO]\x1b[m BUILD SUCCESS',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.swallowedFailure).toBe(true);
    expect(report.note).toContain('fail-never');
  });

  it('fails closed when the report sweep is truncated by a wide fan-out', () => {
    // One directory holding more than MAX_DIR_ENTRIES entries used to cost
    // an unbounded Dirent array AND truncated silently — a fresh failing
    // report beyond the truncation point would read green.
    writeReactor();
    const wide = join(root, 'wide');
    mkdirSync(wide);
    for (let i = 0; i < 10_001; i++) {
      writeFileSync(join(wide, `f${i}`), '');
    }

    const report = runAdapter(['core/src/Main.java']);

    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
    expect(report.note).toContain('not certified as a pass');
    expect(report.test[0]?.output).toContain('the report sweep was truncated');
  }, 30_000);

  it('does not flag a directory read exactly to the entry cap as truncated', () => {
    // The cap check used to run BEFORE the read, so a directory holding
    // exactly MAX_DIR_ENTRIES entries — read to exhaustion — still flagged
    // truncated, and the flag's propagation to evidenceCapped refused
    // certification of a fully-green, fully-read run.
    writeReactor();
    const wide = join(root, 'wide');
    mkdirSync(wide);
    for (let i = 0; i < 10_000; i++) {
      writeFileSync(join(wide, `f${i}`), '');
    }

    expect(reportPaths(root)).toEqual({ paths: [], truncated: false });
  }, 30_000);

  it('fails closed when a fresh report is too large to parse', () => {
    // A masked exit 0 over one oversized failing report: the size cap
    // rejects the parse, and the rejection must count as unknown evidence —
    // not fail open where the count cap fails closed.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Big.xml'),
          `<testsuite tests="1" failures="1" errors="0" skipped="0"><!-- ${'x'.repeat(2 * 1024 * 1024)} --></testsuite>`,
        );
        return result(command, {
          exitCode: 0,
          output: '[INFO] BUILD SUCCESS',
        });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
    expect(report.test[0]?.output).toContain('could not be parsed');
  });

  it('never follows a symlinked report directory out of the worktree', () => {
    // The queue descent skips symlinks via Dirent.isDirectory(), but the
    // direct report-dir listing resolves them: a symlinked surefire-reports
    // once injected outside stale reports as fresh evidence.
    writeReactor();
    const outside = join(sandbox, 'outside-reports');
    mkdirSync(outside);
    writeFileSync(
      join(outside, 'TEST-Stale.xml'),
      '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="T" name="stale"><failure/></testcase></testsuite>',
    );
    mkdirSync(join(root, 'core', 'target'), { recursive: true });
    symlinkSync(outside, join(root, 'core', 'target', 'surefire-reports'));

    const report = runAdapter(['core/src/Main.java']);

    expect(report.ok).toBe(true);
    expect(report.test[0]?.output).not.toContain('TEST-Stale.xml');
  });

  it('ignores a commented-out testsuite in a fresh report', () => {
    // The twin of the CDATA case: aggregate writers emit commented-out
    // markup, and scanning it fabricated phantom failure evidence.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Real.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="Real" name="ok"/></testsuite>\n' +
            '<!-- <testsuite tests="3" failures="2" errors="0" skipped="0"><testcase classname="Ghost" name="phantom"><failure/></testcase></testsuite> -->',
        );
        return result(command, {
          exitCode: 0,
          output: '[INFO] BUILD SUCCESS',
        });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.test[0]?.output).not.toContain('Ghost');
    expect(report.test[0]?.output).not.toContain('[maven-test-failure]');
  });

  it('emits a fallback failure line for a report with failures but no case bodies', () => {
    // The invariant test-plan's guards key on: failures>0 ⇒ at least one
    // [maven-test-failure] line. A header-only failing report emitted none.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-HeaderOnly.xml'),
          '<testsuite tests="1" failures="1" errors="0" skipped="0"/>',
        );
        return result(command, {
          exitCode: 0,
          output: '[INFO] BUILD SUCCESS',
        });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.output).toContain(
      '[maven-test-failure] core/target/surefire-reports/TEST-HeaderOnly.xml: ' +
        '1 failure(s), 0 error(s) recorded without case detail',
    );
  });

  it('treats -Dmaven.repo.local locations referenced by .mvn/maven.config as dependency inputs', () => {
    // The twin of the settings-inputs case: the launcher injects the
    // property into the very command the adapter runs, so a changed local
    // repository location must suppress the infrastructure carve-out.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(
      join(root, '.mvn', 'maven.config'),
      '-Dmaven.repo.local=local-repo\n',
    );
    mkdirSync(join(root, 'local-repo'));

    const report = runAdapter(['local-repo/corrupt.jar'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('treats every -Dmaven.repo.local.tail entry as a dependency input', () => {
    // Maven 3.9's chained local repositories: EVERY entry is a resolution
    // location the PR can change.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(
      join(root, '.mvn', 'maven.config'),
      '-Dmaven.repo.local.tail=repo-a,repo-b\n',
    );
    mkdirSync(join(root, 'repo-a'));
    mkdirSync(join(root, 'repo-b'));

    const report = runAdapter(['repo-b/corrupt.jar'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('fails closed to reactor-wide for a real module nested under a non-root aggregator src/ path', () => {
    // The R1-1 positive control beyond the root: `agg` aggregates
    // `<module>src/core</module>`; collapsing to `agg` would run
    // `-pl agg -am`, and `-am` adds only UPSTREAM projects — the changed
    // module would never compile or test under a green verdict.
    writeProject('.', ['agg']);
    writeProject('agg', ['src/core']);
    writeProject('agg/src/core');
    const calls: string[] = [];

    const report = runAdapter(['agg/src/core/src/main/java/Foo.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.affected).toEqual(['.']);
  });

  it('still scopes to the owning module when only test-data-shape fixtures sit under its src/', () => {
    // `src/test/` and `src/it/` are the principled fixture shapes: the skip
    // there must not cost the module a reactor-wide run.
    writeReactor();
    writeProject('core/src/it/projects/sample');
    const calls: string[] = [];

    runAdapter(
      ['core/src/main/java/Core.java', 'core/src/it/projects/sample/App.java'],
      {
        exec: (command) => {
          calls.push(command);
          return result(command);
        },
      },
    );

    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl core -am test',
    ]);
  });

  it('cross-checks surefire stdout summaries against a relocated report directory', () => {
    // Reports written to a non-default `<reportsDirectory>` sit outside the
    // sweep; the framed `Tests run:` summary Surefire prints even under
    // testFailureIgnore is the cross-check that keeps the run green no
    // more. A FAILING summary is `[ERROR]`-framed on real Maven (verified
    // 3.8.7 / surefire 3.2.5) — the `[INFO]` twin stays covered because
    // the regex admits both.
    writeReactor();
    for (const framing of ['[ERROR]', '[INFO]']) {
      const report = runAdapter(['core/src/Main.java'], {
        exec: (command) =>
          result(command, {
            exitCode: 0,
            output:
              `${framing} Tests run: 5, Failures: 2, Errors: 0, Skipped: 0\n` +
              '[INFO] BUILD SUCCESS',
          }),
      });

      expect(report.ok).toBe(false);
      expect(report.test[0]?.swallowedFailure).toBe(true);
      expect(report.test[0]?.infrastructure).toBeUndefined();
      expect(report.note).toContain('fail-never or testFailureIgnore');
    }
  });

  // chmod is the only lever this case has: a root user reads through it,
  // so the branch under test is unreachable there — the repo convention.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed when a reports directory is unreadable',
    () => {
      // An unreadable directory is the same epistemic state as the caps: the
      // sweep did not see everything. chmod 000 is within what a PR's own
      // test/shutdown hook can do — the threat model this file grants.
      writeReactor();
      const dir = join(root, 'core', 'target', 'surefire-reports');
      const report = runAdapter(['core/src/Main.java'], {
        exec: (command) => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'TEST-Core.xml'),
            '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="T" name="f"><failure/></testcase></testsuite>',
          );
          chmodSync(dir, 0o000);
          return result(command);
        },
      });

      // Restore so the sandbox cleanup can remove the tree.
      chmodSync(dir, 0o755);
      expect(report.ok).toBe(false);
      expect(report.test[0]?.evidenceCapped).toBe(true);
    },
  );

  it('rejects a report whose comment swallows a later failing suite', () => {
    // A raw `<!--` in unescaped `<system-out>` text whose matching `-->`
    // sits inside a LATER failing suite: honoring it swallowed the failing
    // header. The comment interior closes elements still open where it
    // started — the swallowing shape — so the report joins the parser's
    // fail-closed rejections instead of reading green.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="A" name="passes">' +
            '<system-out>before <!-- swallow</system-out></testcase>' +
            '<testsuite tests="1" failures="1" errors="0" skipped="0">' +
            '<testcase classname="B" name="fails"><failure/></testcase>' +
            '</testsuite> after --></testsuite>',
        );
        return result(command, { exitCode: 0, output: '[INFO] BUILD SUCCESS' });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
  });

  it('keeps CDATA-wrapped system-out with XML samples parseable', () => {
    // Surefire's own writer wraps test stdout in CDATA immediately after
    // the `<system-out>` open tag, and that stdout routinely contains XML
    // samples closing the very elements open around the section — that one
    // shape stays exempt from the swallowing probe the twin below applies.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="A" name="passes">' +
            '<system-out><![CDATA[</system-out></testcase> sample]]></system-out>' +
            '</testcase></testsuite>',
        );
        return result(command, { exitCode: 0, output: '[INFO] BUILD SUCCESS' });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.test[0]?.evidenceCapped).toBeUndefined();
  });

  it('rejects a report whose CDATA swallows a later failing suite', () => {
    // The CDATA twin of the comment swallow: a raw `<![CDATA[` in unescaped
    // `<system-out>` text — with OTHER content before it, not the tight
    // surefire shape — whose `]]>` sits inside a LATER failing suite
    // deletes that suite's evidence. The interior-close probe applies to
    // CDATA too, so the report joins the parser's fail-closed rejections
    // instead of reading green.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="A" name="passes">' +
            '<system-out>before <![CDATA[ swallow</system-out></testcase>' +
            '<testsuite tests="1" failures="1" errors="0" skipped="0">' +
            '<testcase classname="B" name="fails"><failure/></testcase>' +
            '</testsuite> after ]]></testsuite>',
        );
        return result(command, { exitCode: 0, output: '[INFO] BUILD SUCCESS' });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
  });

  it('reads failing case bodies as failures when the header is zeroed', () => {
    // A rewritten report: `failures="0" errors="0"` attributes over a live
    // `<failure>` body. The parsed proof of failure is authoritative — the
    // green-wash this adapter's threat model exists to catch.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.T" name="fails"><failure message="boom"/></testcase>' +
            '</testsuite>',
        );
        return result(command, { exitCode: 0, output: '[INFO] BUILD SUCCESS' });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.output).toContain(
      '[maven-test-failure] core/target/surefire-reports/TEST-Core.xml: example.T#fails',
    );
  });

  it('does not cut a testcase body on a quoted </testcase> attribute value', () => {
    // The close-tag walk is quote-aware like the header walk: a literal
    // `</testcase>` inside a quoted attribute value is content, not
    // markup. Cutting the body there silently lost the `<failure>` after
    // it and read a failing report green.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.CoreTest" name="t">' +
            '<property name="</testcase>"/>' +
            '<failure>boom</failure>' +
            '</testcase></testsuite>',
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.output).toContain(
      '[maven-test-failure] core/target/surefire-reports/TEST-Core.xml: example.CoreTest#t',
    );
  });

  it('refuses a report whose last testcase never closes', () => {
    // A file truncated mid-case has no closing tag to attribute a body to;
    // returning the partially-parsed prefix read the recorded failure body
    // away into a green verdict. Fail closed like the interrupted header
    // walk — the rejection counts as unknown evidence.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="2" failures="0" errors="0" skipped="0">' +
            '<testcase classname="T" name="a"><failure>boom</failure></testcase>' +
            '<testcase classname="T" name="b">',
        );
        return result(command);
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
    expect(report.note).toContain('failure status is unknown');
  });

  it('renders an errors-only report rollup with the errors folded into failures', () => {
    // Every rollup emitter hardcodes errors=0 and folds errors into
    // failures=; pin the real emitter path end-to-end. The fixture carries
    // its error ONLY in the header (no failing case body): dropping
    // `summary.errors` from failedCount would render failures=0 here while
    // every other assertion stayed green, and the rollup would read clean.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="1" skipped="0"><testcase classname="example.CoreTest" name="errors"/></testsuite>',
        );
        return result(command);
      },
    });

    expect(report.test[0]?.output).toContain(
      '[maven-test-report] core (1 failing report(s)): tests=1, failures=1, errors=0, skipped=0',
    );
    expect(report.ok).toBe(false);
  });

  it('treats a fully-read zero-suite report as known-empty, not unknown', () => {
    // A small suite-less XML a PR's own tests write (failsafe-summary.xml is
    // the same shape) contributes no evidence and no gap — it must not hold
    // the whole run uncertified.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'failsafe-summary.xml'), '<failsafe-summary/>');
        return result(command, { exitCode: 0, output: '[INFO] BUILD SUCCESS' });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.test[0]?.evidenceCapped).toBeUndefined();
  });

  it('classifies a wrapper SHA-256 validation failure as infrastructure', () => {
    // apache/maven-wrapper prints this verbatim on a checksum mismatch; the
    // pinning fixture uses the wording a real wrapper emits.
    writeReactor();
    writeWrapper();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            'Error: Failed to validate Maven distribution SHA-256, ' +
            'your Maven distribution might be compromised.',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
  });

  it('classifies a silent bootstrap download death as infrastructure', () => {
    // Both wrapper generations try wget before curl, and the distribution
    // download runs it quiet: a DNS failure dies exit 4 with EMPTY output —
    // no wording to match. The curl fallback dies the same way on its own
    // codes (resolve, connect, HTTP error, timeout). The absence of any
    // Maven-framed line pins the death to bootstrap.
    writeReactor();
    writeExecutedWrapper();

    for (const exitCode of [4, 6, 7, 8, 22, 28]) {
      const report = runAdapter(['core/src/Main.java'], {
        exec: (command) => result(command, { exitCode, output: '' }),
      });

      expect(report.ok).toBe(false);
      expect(report.test[0]?.infrastructure).toBe(true);
      expect(report.note).toContain('infrastructure evidence');
    }
  });

  it('classifies the curl bootstrap die message as infrastructure', () => {
    // Hosts without wget fall back to `curl --silent`, which suppresses
    // curl's own `curl: (N)` line; the wrapper's die wording is all the
    // output the death leaves.
    writeReactor();
    writeWrapper();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            'curl: Failed to fetch https://archive.apache.org/dist/maven/' +
            'maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
  });

  it('classifies the wrapper-jar SHA-256 wording as infrastructure', () => {
    // The jar-mode wrapper names the WRAPPER where the distribution mode
    // names the distribution; both are checksum verdicts this run's
    // launcher printed before Maven existed.
    writeReactor();
    writeWrapper();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            'Error: Failed to validate Maven wrapper SHA-256, your Maven ' +
            'wrapper might be compromised.',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
  });

  it('classifies the missing checksum-tool message as infrastructure', () => {
    // Both wrapper generations print this verbatim and exit 1 when a
    // checksum was requested and neither sha256sum nor shasum exists.
    writeReactor();
    writeWrapper();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            'Checksum validation was requested but neither ' +
            "'sha256sum' or 'shasum' are available.",
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'classifies a localized wrapper launch failure as infrastructure',
    () => {
      // bash/dash localize the 126/127 diagnostics under a non-English
      // LANG; the classification keys on the shape — an unmodified wrapper
      // dying at a launch exit code with no Maven-framed output — not the
      // wording.
      writeReactor();
      writeWrapper();

      for (const [output, exitCode] of [
        ['/bin/sh: 1: ./mvnw: Keine Berechtigung', 126],
        ['sh: ./mvnw: Datei oder Verzeichnis nicht gefunden', 127],
      ] as const) {
        const report = runAdapter(['core/src/Main.java'], {
          exec: (command) => result(command, { exitCode, output }),
        });
        expect(report.note).toContain('infrastructure evidence');
      }
    },
  );

  it('reads a PR-modified stub wrapper printing fake framing as never run', () => {
    // A wrapper the PR itself modifies is executed deliberately and can
    // print `[INFO] BUILD SUCCESS` itself: framed output alone cannot
    // prove Maven ran there — fresh reports must, or the run fails closed.
    writeReactor();
    writeExecutedWrapper();

    const report = runAdapter([executedWrapperName, 'core/src/Main.java'], {
      exec: (command) =>
        result(command, { exitCode: 0, output: '[INFO] BUILD SUCCESS' }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.neverRan).toBe(true);
    expect(report.note).toContain('changed by the diff');
  });

  it('treats single-dash long settings spellings in maven.config as dependency inputs', () => {
    // commons-cli accepts `-settings <path>` exactly like `--settings`;
    // reading the token through the `-s` prefix regex recorded `ettings`
    // and let the PR's own breakage launder into infrastructure.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    mkdirSync(join(root, 'ci'));
    writeFileSync(join(root, 'ci', 'conf.xml'), '<settings/>\n');

    const withConfig = (config: string) => {
      writeFileSync(join(root, '.mvn', 'maven.config'), config);
      return runAdapter(['ci/conf.xml'], {
        exec: (command) =>
          result(command, {
            exitCode: 1,
            output:
              '[ERROR] Could not resolve dependencies for project example:core',
          }),
      });
    };

    const paired = withConfig('-settings\nci/conf.xml\n');
    expect(paired.note).toContain('Correlate compiler or test errors');
    expect(paired.note).not.toContain('infrastructure evidence');

    const attached = withConfig('-settings=ci/conf.xml\n');
    expect(attached.note).toContain('Correlate compiler or test errors');
    expect(attached.note).not.toContain('infrastructure evidence');
  });

  it('splits -Dmaven.repo.local.tail on comma only, never on |', () => {
    // Maven parses the chain with `split(",")`: a `|` is part of a path.
    // Reading it as a separator recorded a phantom input that could
    // withdraw the infrastructure carve-out for an unrelated outage.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(
      join(root, '.mvn', 'maven.config'),
      '-Dmaven.repo.local.tail=cache|warm\n',
    );
    mkdirSync(join(root, 'cache|warm'));

    const own = runAdapter(['cache|warm/corrupt.jar'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });
    expect(own.note).toContain('Correlate compiler or test errors');
    expect(own.note).not.toContain('infrastructure evidence');

    // The phantom half of the old split must NOT record as an input: a
    // change under `cache/` alone keeps the carve-out.
    mkdirSync(join(root, 'cache'));
    const phantom = runAdapter(['cache/corrupt.jar'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });
    expect(phantom.note).toContain('infrastructure evidence');
  });

  it('widens the run to the full reactor for a root-level miscellaneous file', () => {
    // A root file no exemption claims is the unknown-input case: it must
    // widen the run, not drop it.
    writeReactor();
    const calls: string[] = [];

    const report = runAdapter(['checkstyle.xml'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.affected).toEqual(['.']);
  });

  it('parses a failing case whose classname carries İ through the fallback scan', () => {
    // `İ`.toLowerCase() lengthens UTF-16 text, which switches
    // xmlOpenTagHeaders to its case-insensitive fallback scan; the parse
    // must still attribute the failure body to its case.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Ilk.xml'),
          '<testsuite tests="1" failures="1" errors="0" skipped="0">' +
            '<testcase classname="İlk" name="fails">' +
            '<failure>boom</failure>' +
            '</testcase>' +
            '</testsuite>',
        );
        return result(command, {
          exitCode: 1,
          output: 'There are test failures.',
        });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.output).toContain('İlk#fails');
  });

  it('rejects a report whose unclosed attribute quote hides failure bodies', () => {
    // A greenwash shape: the suite header says zero failures, an opener's
    // quote never closes, and every `<failure>` body sits after the hole.
    // The interrupted walk discards those bodies, so the report must be
    // rejected — reading the surviving prefix would greenwash the run.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.CoreTest" name="passes"/>' +
            '<testcase classname="example.Hidden" name="broken' +
            '<failure>boom</failure>' +
            '</testcase>' +
            '</testsuite>',
        );
        return result(command, { exitCode: 0, output: '' });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.evidenceCapped).toBe(true);
  });

  it('discloses captured source failures when an interrupted run recorded them', () => {
    // Under fail-never a PR-caused compile failure does not end the build:
    // it runs on to the deadline, and the interruption must not launder
    // the captured failure into pure infrastructure.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      timeout: 2,
      exec: (command) =>
        result(command, {
          exitCode: null,
          timedOut: true,
          seconds: 2,
          output: '[ERROR] COMPILATION ERROR : something the diff broke',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.note).toContain('ran out of time');
    expect(report.note).toContain('records source or goal failures');
    expect(report.note).not.toContain('not a defect in the diff');
  });

  it('still scans the queue backlog when the fan-out bound truncates', () => {
    // The memory guard caps the DIRECTORY QUEUE, not the scan count: ten
    // children with a budget of three scan the root plus two children,
    // and the reports those two hold must still be read even though the
    // sweep truncates. A truncation that stopped the scan instead of the
    // enqueue would read none — evidence the budget could have kept.
    for (let i = 0; i < 10; i++) {
      const reportDir = join(root, `m${i}`, 'target', 'surefire-reports');
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'TEST-M.xml'), '<testsuite tests="1"/>');
    }

    const sweep = reportPaths(root, 3);
    expect(sweep.truncated).toBe(true);
    expect(sweep.paths).toHaveLength(2);
  });

  it('reads an unframed selector-rejection wording from test stdout as evidence, not rejection', () => {
    // The classifier anchors on Maven's framing: a PR test echoing the
    // wording must not discard the run's fresh evidence into `unsupported`.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="T" name="ok"/></testsuite>',
        );
        return result(command, {
          exitCode: 0,
          output:
            'some test printed: Could not find the selected project in the reactor: core\n' +
            '[INFO] BUILD SUCCESS',
        });
      },
    });

    expect(report.toolchain).toBe('maven');
    expect(report.ok).toBe(true);
  });

  it('falls back to mvn when the wrapper name is a directory', () => {
    // A directory named `mvnw` is searchable (passes X_OK) but dies exit 126
    // on execution; the isFile() gate treats it as absent on both platforms.
    writeProject('.');
    mkdirSync(join(root, 'mvnw'));
    chmodSync(join(root, 'mvnw'), 0o755);
    expect(mavenExecutable(root, 'linux')).toBe('mvn');

    mkdirSync(join(root, 'mvnw.cmd'));
    expect(mavenExecutable(root, 'win32')).toBe('mvn');
  });

  it('reads a non-empty stub wrapper that exits 0 as never run, not as tested nothing', () => {
    // Trimming the wrapper to `#!/bin/sh` keeps the exec bit and passes the
    // size gate: exit 0, zero reports, zero Maven output. Enumerating
    // wrapper shapes misses it; classifying the run does not. The fixture
    // writes the wrapper this platform EXECUTES so the neverRan path is
    // pinned through its executed-wrapper variant on both platforms.
    writeReactor();
    writeExecutedWrapper();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => result(command, { exitCode: 0, output: '' }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.neverRan).toBe(true);
    expect(report.note).toContain('without starting Maven');
  });

  it('mirrors Maven line-by-line maven.config reading for spaced arguments', () => {
    // Maven reads one argument per line: `-s` and a spaced path are two
    // lines. Whitespace tokenizing recorded the truncated path and let the
    // PR's own breakage launder into infrastructure.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(
      join(root, '.mvn', 'maven.config'),
      '-s\nci/my settings.xml\n',
    );
    mkdirSync(join(root, 'ci'));
    writeFileSync(join(root, 'ci', 'my settings.xml'), '<settings/>\n');

    const report = runAdapter(['ci/my settings.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('does not read maven.config comment lines as arguments', () => {
    // A `#` line naming flags must not record a spurious input that could
    // withdraw the carve-out for an unrelated environmental failure.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(join(root, '.mvn', 'maven.config'), '# -s ci/real.xml\n');
    mkdirSync(join(root, 'ci'));
    writeFileSync(join(root, 'ci', 'real.xml'), '<settings/>\n');

    const report = runAdapter(['ci/real.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).toContain('infrastructure evidence');
  });

  it.each([
    '-s=ci/settings.xml\n',
    // Maven reads one argument PER LINE: the paired forms are two lines.
    '--settings\nci/settings.xml\n',
    '--settings=ci/settings.xml\n',
    '-gs\nci/settings.xml\n',
    '-gs=ci/settings.xml\n',
  ])(
    'treats the %j maven.config spelling as a settings dependency input',
    (config) => {
      writeReactor();
      mkdirSync(join(root, '.mvn'));
      writeFileSync(join(root, '.mvn', 'maven.config'), config);
      mkdirSync(join(root, 'ci'));
      writeFileSync(join(root, 'ci', 'settings.xml'), '<settings/>\n');

      const report = runAdapter(['ci/settings.xml'], {
        exec: (command) =>
          result(command, {
            exitCode: 1,
            output:
              '[ERROR] Could not resolve dependencies for project example:core',
          }),
      });

      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
    },
  );

  it('treats a POM nested under a bare src/ module path as a resolution input', () => {
    // A reactor can aggregate `<module>src/core</module>`: that POM feeds
    // resolution like any other. Excluding EVERY src/-nested POM laundered
    // the PR's own resolution breakage into an infrastructure outage.
    writeProject('.', ['src/core']);
    writeProject('src/core');

    const report = runAdapter(['src/core/pom.xml'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output: '[ERROR] Non-resolvable parent POM for example:core',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it.skipIf(process.platform === 'win32')(
    'treats a symlinked .mvn/maven.config as unreadable instead of hanging on it',
    () => {
      // The isFile() gate: a symlink to a character device reports size 0
      // and passes any size cap — readFileSync would block forever.
      writeReactor();
      mkdirSync(join(root, '.mvn'));
      symlinkSync('/dev/zero', join(root, '.mvn', 'maven.config'));

      const report = runAdapter(['core/src/Main.java']);

      expect(report.ok).toBe(true);
    },
  );

  it('exercises the wrapper-skip arm through the platform parameter', () => {
    // The arm that skips the OTHER platform's wrapper, reachable without
    // depending on the host's process.platform.
    writeReactor();
    expect(detectMavenOwnership(root, ['mvnw'], 'win32')).toEqual({
      reactorWide: false,
      modules: [],
    });
    expect(detectMavenOwnership(root, ['mvnw.cmd'], 'linux')).toEqual({
      reactorWide: false,
      modules: [],
    });
    // The SAME platform's wrapper is still reactor-wide evidence.
    expect(detectMavenOwnership(root, ['mvnw'], 'linux').reactorWide).toBe(
      true,
    );
  });

  it('decodes XML entities in failing case identities', () => {
    // Parameterized Surefire names escape `<` / `&`; the decoded identity is
    // what Agent 7 correlates against the changed files.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="1" errors="0" skipped="0">' +
            '<testcase classname="example.T" name="a &amp; b &lt; c"><failure/></testcase>' +
            '</testsuite>',
        );
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    expect(report.test[0]?.output).toContain(
      '[maven-test-failure] core/target/surefire-reports/TEST-Core.xml: example.T#a & b < c',
    );
  });

  it('pins the Scala and Groovy source-failure alternants', () => {
    // For Scala/Groovy repos these alternants are the ONLY source-failure
    // signal; a regex rewrite breaking just them must not ship green.
    expect(
      isSourceFailureLine(
        '[ERROR] /tmp/x/core/src/main/scala/Main.scala:12: not found: value foo',
      ),
    ).toBe(true);
    expect(
      isSourceFailureLine(
        '[ERROR] /tmp/x/core/src/main/groovy/Main.groovy: 3: unable to resolve class',
      ),
    ).toBe(true);
  });

  it('keys the entry disk floor on the install flag', () => {
    // 2 GiB free sits inside the [1 GiB build, 3 GiB install) window: the
    // install floor skips a warm-cache run it should admit.
    writeReactor();
    statfsSyncMock.mockReturnValue({ bavail: 2 * 1024 ** 3, bsize: 1 });

    const installing = runAdapter(['core/src/Main.java'], { install: true });
    expect(installing.ok).toBe(false);
    expect(installing.note).toContain('Insufficient disk space');

    const warmCache = runAdapter(['core/src/Main.java'], { install: false });
    expect(warmCache.ok).toBe(true);
    expect(warmCache.note).not.toContain('Insufficient disk space');
  });

  it('does not blame the warm-up in the second preflight note when none ran', () => {
    // A --no-install run passes the first preflight, then free space falls
    // below the build floor: the note must not assert a download that never
    // happened.
    writeReactor();
    statfsSyncMock.mockReturnValueOnce({ bavail: 16 * 1024 ** 3, bsize: 1 });
    statfsSyncMock.mockReturnValue({ bavail: 0.5 * 1024 ** 3, bsize: 1 });

    const report = runAdapter(['core/src/Main.java'], { install: false });

    expect(report.ok).toBe(false);
    expect(report.note).toContain(
      'free space fell below the build floor between the preflight and the lifecycle command',
    );
    expect(report.note).not.toContain('warm-up consumed');
  });

  it('keeps a wrapper-config-only diff from withdrawing the mvn launch carve-out', () => {
    // `.mvn/wrapper/**` feeds the wrapper scripts — which never ran here (no
    // wrapper in the tree; the system `mvn` launch died). The config cannot
    // have caused that death, so the outage stays infrastructure.
    writeReactor();
    const report = runAdapter(['.mvn/wrapper/maven-wrapper.properties'], {
      exec: (command) =>
        result(command, { exitCode: 127, output: 'sh: 1: mvn: not found' }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBe(true);
  });

  it('attributes a timed-out reactor-wide run to the selector the diff made unexpressible', () => {
    // The timedOut note must carry the TRUE widening cause: a selectorUnsafe
    // widening is not "inputs every module inherits".
    writeProject('.', ['od,d']);
    writeProject('od,d');

    const report = runAdapter(['od,d/src/main/java/Main.java'], {
      exec: (command) => result(command, { exitCode: null, timedOut: true }),
    });

    expect(report.ok).toBe(false);
    expect(report.note).toContain('ran out of time');
    expect(report.note).toContain('cannot express');
    expect(report.note).not.toContain('inputs every module inherits');
  });

  it('fails closed when the report sweep exceeds the scanned-directory cap', () => {
    // The scan-count cap is the same fail-closed state as the fan-out bound;
    // the cap is a parameter so the test reaches it without building 20,000
    // directories.
    writeReactor();
    for (let i = 0; i < 10; i++) {
      mkdirSync(join(root, `d${i}`, 'nested'), { recursive: true });
    }

    expect(reportPaths(root, 5).truncated).toBe(true);
    expect(reportPaths(root, 100).truncated).toBe(false);
  });

  it('caps the accumulated report paths when the per-dimension product blows up', () => {
    // Every cap bounded ONE dimension; nothing bounded their product — two
    // modules x both report dirs x 5,100 XMLs respects the per-dir entry
    // cap and the scanned-dir cap yet accumulates past the path cap. The
    // sweep must stop collecting instead of retaining and statSync-ing
    // hundreds of thousands of paths.
    writeReactor();
    for (const module of ['core', 'extension']) {
      for (const reportDir of ['surefire-reports', 'failsafe-reports']) {
        const dir = join(root, module, 'target', reportDir);
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 5_100; i++) {
          writeFileSync(join(dir, `t${reportDir[0]}${i}.xml`), '');
        }
      }
    }

    const { paths, truncated } = reportPaths(root);

    expect(truncated).toBe(true);
    expect(paths.length).toBe(20_000);
  }, 60_000);

  it('matches unmatched closers against a deep open stack in linear time', () => {
    // The closeTag membership scan went quadratic on PR-controlled bytes:
    // k never-closed openers plus k unmatched closers is k full stack
    // scans — measured seconds at 20k pairs through the real adapter
    // (extrapolating to tens of minutes at the report cap), the same
    // denial-of-service class the other linear pins in this suite. The
    // trailing comment is load-bearing: without a CDATA/comment marker
    // stripOpaqueSections returns before scanning at all.
    writeReactor();
    const startedAt = Date.now();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0"/>' +
            '<opener>'.repeat(50_000) +
            '</closer>'.repeat(50_000) +
            '<!-- trailing -->',
        );
        return result(command);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(report.ok).toBe(true);
  }, 20_000);

  it('scans comment-interior close tokens against a deep stack in linear time', () => {
    // The swallow check ran `.some(...)` over the whole open stack for
    // EVERY close token inside a comment — the second quadratic site,
    // reachable through a single `<!--` marker. The interior names match
    // nothing open, so the report stays parseable and the scan must stay
    // fast.
    writeReactor();
    const startedAt = Date.now();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Core.xml'),
          '<testsuite tests="1" failures="0" errors="0" skipped="0"/>' +
            '<opener>'.repeat(30_000) +
            '<!--' +
            '</closer>'.repeat(30_000) +
            '-->' +
            '<testcase classname="example.T" name="passes"/>',
        );
        return result(command);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(report.ok).toBe(true);
  }, 20_000);

  it('prints per-report clamped totals on the failing rollup', () => {
    // Surefire does not guarantee tests >= failures + skipped within one
    // report, and test-plan clamps per parsed LINE: raw pre-aggregated
    // totals would let one anomalous report cancel its batchmates' passed
    // counts (report A below parses to -3 passed without the per-report
    // clamp). The failing rollup must emit the same clamped shape the
    // clean rollup does.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'TEST-Anomalous.xml'),
          '<testsuite tests="2" failures="2" errors="0" skipped="3"/>',
        );
        writeFileSync(
          join(dir, 'TEST-Normal.xml'),
          '<testsuite tests="10" failures="1" errors="0" skipped="0">' +
            '<testcase classname="example.T" name="fails"><failure/></testcase>' +
            '</testsuite>',
        );
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    // Per-report truth: A passed max(0, 2-2-3)=0, B passed max(0, 10-1-0)=9
    // — so tests = 9 passed + 3 failed with skipped zeroed, and the line
    // clamp parses back to 9 instead of the old wash-down to 6.
    expect(report.test[0]?.output).toContain(
      '[maven-test-report] core (2 failing report(s)): ' +
        'tests=12, failures=3, errors=0, skipped=0',
    );
  });

  it('reads [ERROR]-framed stdout test failures as source-side, not infrastructure', () => {
    // Real Maven frames a failing module's stdout summary `[ERROR]`, and a
    // test throwing ConnectException prints dependency-flavored wording the
    // dependency matcher claims. With the failing reports relocated out of
    // the sweep, the stdout summary is the only evidence that the run
    // executed failing tests — that is source-side, never an acquisition
    // outage.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] ConnTest.connects:7 \u00bb Connect Connection refused\n' +
            '[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0\n' +
            '[INFO] BUILD FAILURE',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.infrastructure).toBeUndefined();
    expect(report.test[0]?.swallowedFailure).toBeUndefined();
    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('does not launder a swallowed stdout test failure into infrastructure', () => {
    // The exit-0 twin of the ConnectException wash: a fail-never run whose
    // stdout records executed failing tests beside dependency-flavored
    // wording is a swallowed test failure, not an acquisition outage.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: 0,
          output:
            '[ERROR] Could not transfer artifact org.example:lib:pom:1 from central: Connection timed out\n' +
            '[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0\n' +
            '[INFO] BUILD SUCCESS',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.swallowedFailure).toBe(true);
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  // chmod is the only lever this case has; the repo convention for it.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed when a target directory is unreadable',
    () => {
      // The lstat gate one level ABOVE the report dir: an unreadable
      // `target` used to read as 'no reports dir here', certifying green a
      // run whose fresh failing reports the sweep could not see. chmod 000
      // is within the threat model this file grants.
      writeReactor();
      const target = join(root, 'core', 'target');
      const report = runAdapter(['core/src/Main.java'], {
        exec: (command) => {
          const dir = join(target, 'surefire-reports');
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'TEST-Core.xml'),
            '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase classname="T" name="f"><failure/></testcase></testsuite>',
          );
          chmodSync(target, 0o000);
          return result(command);
        },
      });

      // Restore so the sandbox cleanup can remove the tree.
      chmodSync(target, 0o755);
      expect(report.ok).toBe(false);
      expect(report.test[0]?.evidenceCapped).toBe(true);
    },
  );

  it('names a quiet maven.config as the never-ran alternative cause', () => {
    // `-q`/`--quiet` in the PR-writable config strips every framed line the
    // neverRan check keys on: a quiet run that skipped its tests exits 0
    // with empty output, indistinguishable there from a wrapper that never
    // started — the note must name the real alternative.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(join(root, '.mvn', 'maven.config'), '-q\n-DskipTests\n');

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => result(command, { exitCode: 0, output: '' }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.neverRan).toBe(true);
    expect(report.note).toContain('`-q`/`--quiet`');
  });

  it('does not name the quiet setting when the config has none', () => {
    // Control for the note above: the same empty-output shape without the
    // flag points at the wrapper only.
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => result(command, { exitCode: 0, output: '' }),
    });

    expect(report.ok).toBe(false);
    expect(report.test[0]?.neverRan).toBe(true);
    expect(report.note).toContain('empty or');
    expect(report.note).not.toContain('--quiet');
  });

  it('names stdout-recorded failures in a timed-out run', () => {
    // The deadline kill is infrastructure, but the captured framed `Tests
    // run:` summaries are failures Surefire already recorded — the note
    // must not assert a purely informational result over them.
    writeReactor();
    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) =>
        result(command, {
          exitCode: null,
          timedOut: true,
          output: '[ERROR] Tests run: 5, Failures: 2, Errors: 0, Skipped: 0',
        }),
    });

    expect(report.ok).toBe(false);
    expect(report.note).toContain('ran out of time');
    expect(report.note).toContain('treat those as test failures');
  });

  it('omits the mixed-root caveat when package.json is a directory', () => {
    // npm's applies() fails closed on a DIRECTORY named package.json
    // (EISDIR swallowed to no manifests), so Maven runs alone with no npm
    // half — the caveat would be false.
    writeReactor();
    mkdirSync(join(root, 'package.json'));

    const report = runAdapter(['core/src/Main.java']);

    expect(report.ok).toBe(true);
    expect(report.note).not.toContain('Mixed root');
  });

  it('keeps the mixed-root caveat for a real root package.json', () => {
    writeReactor();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );

    const report = runAdapter(['core/src/Main.java']);

    expect(report.ok).toBe(true);
    expect(report.note).toContain('Mixed root');
  });

  it('applies() requires a REGULAR pom.xml file', () => {
    // A DIRECTORY named pom.xml passes existsSync but selects Maven over a
    // shape `mvn` refuses to build — the same isFile() gate mavenExecutable
    // and mavenConfigDependencyInputs apply. This is also what keeps a
    // polyglot base selecting npm instead of falling unsupported.
    const plain = join(sandbox, 'applies-plain');
    mkdirSync(plain);
    expect(mavenToolchainAdapter.applies(plain)).toBe(false);

    writeFileSync(join(plain, 'pom.xml'), pom());
    expect(mavenToolchainAdapter.applies(plain)).toBe(true);

    const dirPom = join(sandbox, 'applies-dir');
    mkdirSync(join(dirPom, 'pom.xml'), { recursive: true });
    expect(mavenToolchainAdapter.applies(dirPom)).toBe(false);
  });
});
