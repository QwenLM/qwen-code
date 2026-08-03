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
import type { CommandResult } from '../build-test.js';
import {
  detectMavenOwnership,
  mavenExecutable,
  mavenToolchainAdapter,
  readMavenReactor,
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

  it('recursively reads literal modules, ignores comments, and assigns deepest ownership', () => {
    writeFileSync(
      join(root, 'pom.xml'),
      pom(['core', 'nested-parent']).replace(
        '<modules>',
        '<modules><!-- <module>missing</module> -->',
      ),
    );
    writeProject('core');
    writeProject('nested-parent', ['nested-leaf']);
    writeProject('nested-parent/nested-leaf');

    const parsed = readMavenReactor(root);
    expect(parsed).toEqual({
      reactor: {
        modules: ['core', 'nested-parent', 'nested-parent/nested-leaf'],
        projectDirs: [
          '.',
          'core',
          'nested-parent',
          'nested-parent/nested-leaf',
        ],
        children: {
          '.': ['core', 'nested-parent'],
          'nested-parent': ['nested-parent/nested-leaf'],
        },
      },
    });
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(
      detectMavenOwnership(
        root,
        [
          'nested-parent/nested-leaf/src/test/java/LeafTest.java',
          'nested-parent/README.md',
        ],
        parsed.reactor,
      ),
    ).toEqual({
      reactorWide: false,
      // The nested-parent README is documentation, so it produces no target;
      // only the real source change selects a module.
      modules: ['nested-parent/nested-leaf'],
      inactiveProjects: [],
    });
  });

  it('ignores profile and plugin module elements outside direct project modules', () => {
    writeFileSync(
      join(root, 'pom.xml'),
      pom(['core']).replace(
        '</project>',
        `<parent><relativePath/></parent>
        <profiles>
          <profile>
            <id>jdk25</id>
            <modules><module>test-jdk25</module></modules>
          </profile>
        </profiles>
        <build><plugins><plugin><configuration><module>plugin-value</module></configuration></plugin></plugins></build>
        </project>`,
      ),
    );
    writeProject('core');

    expect(readMavenReactor(root)).toEqual({
      reactor: {
        modules: ['core'],
        projectDirs: ['.', 'core'],
        children: { '.': ['core'] },
      },
    });
  });

  it('parses modules past CDATA sections and `>` inside attribute values', () => {
    // Both constructs occur in real POMs (antrun/checkstyle/xml-generation
    // config) and used to fail the whole reactor closed.
    writeFileSync(
      join(root, 'pom.xml'),
      `
<project>
  <build><plugins><plugin><configuration>
    <script><![CDATA[ if (a --> b) { fail(); } ]]></script>
    <arg value="a > b"/>
  </configuration></plugin></plugins></build>
  <modules>
    <module>core</module>
  </modules>
</project>
`,
    );
    writeProject('core');

    expect(readMavenReactor(root)).toEqual({
      reactor: {
        modules: ['core'],
        projectDirs: ['.', 'core'],
        children: { '.': ['core'] },
      },
    });
  });

  it('still fails closed on an unbalanced comment marker', () => {
    writeFileSync(
      join(root, 'pom.xml'),
      pom(['core']).replace('</modules>', '-->\n  </modules>'),
    );
    writeProject('core');

    expect(readMavenReactor(root).error).toContain('Cannot safely parse');
  });

  it.each([
    ['${module.name}', 'property expressions'],
    ['../outside', 'paths escaping the reactor'],
    ['missing', 'missing child POMs'],
  ])('fails closed for %s', (module, _description) => {
    writeProject('.', [module]);
    if (module === '../outside') {
      const outside = join(root, '..', 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'pom.xml'), pom());
    }

    const parsed = readMavenReactor(root);
    expect(parsed.error).toBeTruthy();
    expect(
      mavenToolchainAdapter.run({
        root,
        changedFiles: ['src/Main.java'],
        timeout: 5,
        install: false,
        exec: (command) => result(command),
      }),
    ).toMatchObject({ toolchain: 'unsupported', build: [], test: [] });
  });

  it('marks Maven build files reactor-wide, scopes root sources to the root project, and leaves docs without targets', () => {
    writeReactor();
    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');

    expect(
      detectMavenOwnership(
        root,
        ['pom.xml', '.mvn/maven.config', 'mvnw', 'mvnw.cmd'],
        parsed.reactor,
      ),
    ).toEqual({
      reactorWide: true,
      modules: [],
      inactiveProjects: [],
    });

    // The root artifact's own src/ is owned by the root project '.': it
    // verifies with `-pl . -am`, not the entire reactor.
    expect(
      detectMavenOwnership(
        root,
        ['src/main/java/example/Root.java'],
        parsed.reactor,
      ),
    ).toEqual({
      reactorWide: false,
      modules: ['.'],
      inactiveProjects: [],
    });

    expect(
      mavenToolchainAdapter.run({
        root,
        changedFiles: ['docs/guide.md'],
        timeout: 5,
        install: false,
        exec: (command) => result(command),
      }),
    ).toMatchObject({
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/README.md', 'core/docs/guide.md'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/test/resources/expected.txt'],
      timeout: 5,
      install: false,
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

  it('fails closed for a Maven project outside the root reactor', () => {
    writeReactor();
    writeProject('standalone');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['standalone/src/main/java/example/Standalone.java'],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('unsupported');
    expect(report.note).toContain('outside the root reactor: standalone');
    expect(calls).toEqual([]);
  });

  it('fails closed for documentation in a project outside the root reactor', () => {
    // The out-of-reactor check outranks the documentation exemption: the
    // fail-closed rule applies to ANY changed path belonging to such a
    // project, whatever its extension.
    writeReactor();
    writeProject('standalone');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['standalone/README.md'],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('unsupported');
    expect(report.note).toContain('outside the root reactor: standalone');
    expect(calls).toEqual([]);
  });

  it('keeps verifying the owning module when a test-fixture POM sits under its src/', () => {
    // maven-invoker ITs, archetype fixtures, and src/test/resources/projects/*
    // trees are test DATA: Maven never builds them as reactor modules and no
    // profile activates them. Reading one as a standalone project used to fail
    // the WHOLE diff closed — including the real source change beside it.
    writeReactor();
    writeProject('core/src/test/resources/projects/sample');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: [
        'core/src/main/java/Core.java',
        'core/src/test/resources/projects/sample/App.java',
      ],
      timeout: 5,
      install: false,
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

  it('treats a fixture POM under the root project src/ as test data too', () => {
    writeProject('.');
    writeProject('src/test/resources/projects/sample');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['src/test/resources/projects/sample/App.java'],
      timeout: 5,
      install: false,
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

  it('fails closed for an inactive Maven project nested under a reactor module', () => {
    writeReactor();
    writeProject('nested-parent/profile-child');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: [
        'nested-parent/profile-child/src/main/java/example/ProfileChild.java',
      ],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('unsupported');
    expect(report.note).toContain(
      'outside the root reactor: nested-parent/profile-child',
    );
    expect(calls).toEqual([]);
  });

  it('fans a module POM change out to the modules aggregated beneath it', () => {
    // A nested aggregator's pom.xml is inherited by its descendants; `-pl
    // <aggregator> -am` alone would compile the packaging=pom parent and
    // test nothing that inherits the change.
    writeReactor();
    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');

    expect(
      detectMavenOwnership(root, ['nested-parent/pom.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['nested-parent', 'nested-parent/nested-leaf'],
      inactiveProjects: [],
    });

    const calls: string[] = [];
    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['nested-parent/pom.xml'],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('maven');
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl nested-parent,nested-parent/nested-leaf -am test',
    ]);
  });

  it('scopes root-project source fixtures with documentation extensions to the root project', () => {
    writeProject('.');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['src/test/resources/expected.txt'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: [
        'extension/src/main/java/example/Extension.java',
        'core/src/main/java/example/Core.java',
      ],
      timeout: 17,
      install: false,
      exec: (command, cwd, timeout) => {
        calls.push([command, cwd, timeout]);
        return result(command);
      },
    });

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
    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/main/java/example/Core.java'],
      timeout: 5,
      install: false,
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
    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['.mvn/maven.config'],
      timeout: 5,
      install: false,
      exec: (command) => result(command),
    });

    expect(report.affected).toEqual(['.']);
    expect(report.test[0]?.command).toBe(
      'mvn --batch-mode --no-transfer-progress test',
    );
    // A full-reactor run must not carry the narrowed-run scope statement.
    expect(report.note).not.toContain('downstream dependents were NOT built');
  });

  it('classifies timeout and dependency resolution without fresh reports as infrastructure', () => {
    writeReactor();
    const timeout = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 2,
      install: false,
      exec: (command) =>
        result(command, { exitCode: null, timedOut: true, seconds: 2 }),
    });
    expect(timeout.ok).toBe(false);
    expect(timeout.timedOut).toEqual([timeout.test[0]?.command]);
    expect(timeout.note).toContain('infrastructure result');

    const resolution = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 2,
      install: false,
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

  it('does not classify a changed wrapper permission failure as infrastructure', () => {
    writeReactor();
    writeWrapper();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['mvnw'],
      timeout: 5,
      install: false,
      exec: (command) =>
        result(command, {
          exitCode: 126,
          output: '/bin/sh: ./mvnw: Permission denied',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('does not hide a permission failure behind `./mvnw` spelled differently', () => {
    // The guard compares normalized paths: `./mvnw` and absolute paths name
    // the same wrapper the raw comparison missed.
    writeReactor();
    writeWrapper();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['./mvnw'],
      timeout: 5,
      install: false,
      exec: (command) =>
        result(command, {
          exitCode: 126,
          output: '/bin/sh: ./mvnw: Permission denied',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it.each([
    ['sh: 1: mvn: not found', 127],
    // cmd.exe's wording when Maven is absent on Windows (exit 9009).
    ["'mvn' is not recognized as an internal or external command", 9009],
    ['java.io.IOException: No space left on device', 1],
    ['Error: The JAVA_HOME environment variable is not defined correctly', 1],
    ['Unable to locate a Java Runtime', 1],
  ])(
    'classifies unchanged Maven startup failures as infrastructure',
    (output, exitCode) => {
      writeReactor();

      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: ['core/src/Main.java'],
        timeout: 5,
        install: false,
        exec: (command) => result(command, { exitCode, output }),
      });

      expect(report.note).toContain('infrastructure evidence');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'classifies an unchanged wrapper launch failure as infrastructure',
    () => {
      // The guard needs `executable === './mvnw'`, unreachable on win32.
      writeReactor();
      writeWrapper();

      const runWith = (exitCode: number, output: string) =>
        mavenToolchainAdapter.run({
          root,
          changedFiles: ['core/src/Main.java'],
          timeout: 5,
          install: false,
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

    for (const changed of [
      'pom.xml',
      '.mvn/maven.config',
      'core/pom.xml',
      'mvnw',
      'mvnw.cmd',
    ]) {
      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: [changed],
        timeout: 5,
        install: false,
        exec: (command) => result(command, { exitCode: 1, output }),
      });
      expect(report.note).toContain('Correlate compiler or test errors');
      expect(report.note).not.toContain('infrastructure evidence');
    }
  });

  it('does not treat an inner permission error as a wrapper startup failure', () => {
    writeReactor();
    writeWrapper();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java', 'extension/src/Extension.java'],
      timeout: 5,
      install: false,
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
        return result(command, { exitCode: 1, output: '[ERROR] Tests failed' });
      },
    });

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
    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');

    const metadata = [
      '.github/workflows/ci.yml',
      '.gitignore',
      '.gitattributes',
      'LICENSE',
      'CODEOWNERS',
      '.editorconfig',
    ];
    expect(detectMavenOwnership(root, metadata, parsed.reactor)).toEqual({
      reactorWide: false,
      modules: [],
      inactiveProjects: [],
    });

    const calls: string[] = [];
    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['.github/workflows/ci.yml'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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
    expect(output).toContain(
      '[maven-test-report] 20 more failing report(s) omitted: ' +
        'tests=20, failures=20, errors=0, skipped=0',
    );
  });

  it('caps the clean per-project rollup lines', () => {
    const modules = Array.from({ length: 120 }, (_, i) => `mod${i}`);
    writeProject('.', modules);
    for (const module of modules) writeProject(module);

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['mod0/src/main/java/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const unframed = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output: 'java.net.ConnectException: Connection refused',
        }),
    });
    expect(unframed.note).toContain('Correlate compiler or test errors');
    expect(unframed.note).not.toContain('infrastructure evidence');

    const framed = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Failed to execute goal on project core: Could not transfer artifact org.example:dep:jar:1: Connection refused',
        }),
    });
    expect(framed.note).toContain('infrastructure evidence');
  });

  it('classifies a spawn-level death without an exit code as infrastructure', () => {
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
      exec: (command) => result(command, { exitCode: null, output: '' }),
    });

    expect(report.ok).toBe(false);
    expect(report.timedOut).toEqual([]);
    expect(report.note).toContain('without an exit code');
    expect(report.note).toContain('infrastructure evidence');
  });

  it('discloses successful tests without fresh XML', () => {
    writeReactor();
    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
      exec: (command) => result(command),
    });

    expect(report.ok).toBe(true);
    expect(report.note).toContain('no fresh Surefire/Failsafe XML');
  });

  it('fails closed for documentation inside an inactive project nested under a module', () => {
    // The out-of-reactor check outranks the documentation exemption in the
    // OWNED branch too: core/legacy is a standalone project under the active
    // module core, so its README belongs to an out-of-reactor project and
    // must not slip past as a no-op doc change.
    writeReactor();
    writeProject('core/legacy');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/legacy/README.md'],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.toolchain).toBe('unsupported');
    expect(report.note).toContain('outside the root reactor: core/legacy');
    expect(calls).toEqual([]);
  });

  it('fans a module POM change out to modules aggregated through ../ entries', () => {
    // A `<module>../its/app-it</module>` entry sits outside the aggregator's
    // directory; the descendant that inherits the changed parent config must
    // still be selected — a directory-prefix scan silently drops it.
    writeProject('.', ['app']);
    writeProject('app', ['../its/app-it']);
    writeProject('its/app-it');
    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');

    expect(detectMavenOwnership(root, ['app/pom.xml'], parsed.reactor)).toEqual(
      {
        reactorWide: false,
        modules: ['app', 'its/app-it'],
        inactiveProjects: [],
      },
    );

    const calls: string[] = [];
    mavenToolchainAdapter.run({
      root,
      changedFiles: ['app/pom.xml'],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });
    expect(calls).toEqual([
      'mvn --batch-mode --no-transfer-progress -pl app,its/app-it -am test',
    ]);
  });

  it('resolves mutually aggregating module POMs without recursing forever', () => {
    // Mutually aggregating POMs are invalid Maven but legal file content;
    // the visited guard must resolve them instead of overflowing the stack.
    writeProject('.', ['a']);
    writeProject('a', ['../b']);
    writeProject('b', ['../a']);

    expect(readMavenReactor(root)).toEqual({
      reactor: {
        modules: ['a', 'b'],
        projectDirs: ['.', 'a', 'b'],
        children: { '.': ['a'], a: ['b'], b: ['a'] },
      },
    });
  });

  it('keeps fresh failing reports as test evidence when the run times out', () => {
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 2,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

  it('does not classify a launch failure as infrastructure when the wrapper changed', () => {
    // The PR's own wrapper edit may be what broke startup; the pinned intent
    // (changed-wrapper failures are never environmental) covers the
    // launch-failure disjunct too, not just the 126/127 wrapper one.
    writeReactor();
    writeWrapper();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['mvnw'],
      timeout: 5,
      install: false,
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            'Error: The JAVA_HOME environment variable is not defined correctly',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it('discloses when a changed wrapper falls back to the system mvn', () => {
    // No executable bit: mavenExecutable falls back to system mvn, so the
    // wrapper the diff changes is never executed — the run must say so.
    writeReactor();
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['mvnw', 'core/src/main/java/example/Core.java'],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
    expect(report.note).toContain('wrapper change itself was not exercised');
  });

  it('does not treat a test-fixture POM as a dependency input', () => {
    // A fixture pom.xml under a module's src/ tree cannot change the reactor's
    // dependency resolution; a genuine outage there stays infrastructure.
    writeReactor();
    writeProject('core/src/test/resources/projects/sample');

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/test/resources/projects/sample/pom.xml'],
      timeout: 5,
      install: false,
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:core',
        }),
    });

    expect(report.note).toContain('infrastructure evidence');
  });

  it('reports insufficient disk space instead of running Maven on a full disk', () => {
    statfsSyncMock.mockReturnValue({ bavail: 5.4e8, bsize: 1 }); // ~0.5G free
    writeReactor();
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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
});
