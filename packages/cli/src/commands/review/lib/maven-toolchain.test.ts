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
  mavenExecutable,
  mavenToolchainAdapter,
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
  output: '',
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

  it('treats a fixture POM under the root project src/ as test data too', () => {
    writeProject('.');
    writeProject('src/test/resources/projects/sample');
    const calls: string[] = [];

    const report = runAdapter(['src/test/resources/projects/sample/App.java'], {
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    // Not `unsupported`: the fixture belongs to the root project's test data,
    // which runs narrowed to the root project.
    expect(report.toolchain).toBe('maven');
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl . -am test',
    ]);
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
    // mvn.cmd/mvnw.cmd on Windows, when JAVA_HOME points at an invalid
    // directory — the only JAVA_HOME failure wording the Windows launcher
    // emits for it.
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
      '[maven-test-report] core/target/surefire-reports/TEST-SameTest.xml: tests=2, failures=1, errors=0, skipped=0',
    );
    expect(output).toContain(
      '[maven-test-failure] core/target/surefire-reports/TEST-SameTest.xml: example.SameTest#coreFailure',
    );
    expect(output).toContain(
      '[maven-test-report] extension (1 report(s)): tests=3, failures=0, errors=0, skipped=1',
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
    // Failing reports keep per-report identity, capped.
    expect(output).toContain('TEST-Fail0.xml');
    // The marker carries per-report CLAMPED passed totals (each omitted
    // report here passed zero), so one anomalous report inside the batch
    // cannot cancel its batchmates' counts at parse time.
    expect(output).toContain(
      '[maven-test-report] 20 more failing report(s) omitted: ' +
        'tests=0, failures=0, errors=0, skipped=0',
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
    writeReactor();

    const report = runAdapter(['core/src/Main.java'], {
      exec: (command) => {
        const dir = join(root, 'core', 'target', 'surefire-reports');
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 103; i++) {
          writeFileSync(
            join(dir, `TEST-Fail${i}.xml`),
            // Fail99 sorts into the omitted tail and passes zero despite
            // recording a test; its batchmates each pass one.
            i === 99
              ? '<testsuite tests="1" failures="5" errors="0" skipped="0"><testcase classname="example.T" name="fails"><failure/></testcase></testsuite>'
              : '<testsuite tests="2" failures="1" errors="0" skipped="0"><testcase classname="example.T" name="fails"><failure/></testcase></testsuite>',
          );
        }
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

    const output = report.test[0]?.output ?? '';
    expect(output).toContain(
      '[maven-test-report] 3 more failing report(s) omitted: ' +
        'tests=2, failures=0, errors=0, skipped=0',
    );
    // 100 kept failing-report lines pass one test each; the batch passes 2.
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
    writeFileSync(join(root, '.mvn', 'maven.config'), '-s settings.xml\n');
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
      `-s settings.xml ${'x'.repeat(2 * 1024 * 1024)}\n`,
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
    writeFileSync(join(root, '.mvn', 'maven.config'), '-s settings.xml\n');
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
    expect(timedOut.timedOut).toEqual([]);
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
    writeWrapper();

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
    expect(report.ok).toBe(true);
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

  it.each([
    ['[ERROR] Non-resolvable import POM for example:bom:1 at line 42'],
    ['[ERROR] Failure to find example:core:jar:1 in central was cached'],
    ['[ERROR] Could not find artifact example:core:jar:1 in central'],
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
});
