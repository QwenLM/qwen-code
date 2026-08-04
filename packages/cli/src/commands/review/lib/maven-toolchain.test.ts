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
        inheritors: {},
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
        inheritors: {},
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
        inheritors: {},
      },
    });
  });

  it('still fails closed on an unpaired comment opener', () => {
    // A bare \`-->\` in text or an attribute value is well-formed CharData
    // and parses fine; only an opener with no terminator is unsafe.
    writeFileSync(
      join(root, 'pom.xml'),
      pom(['core']).replace('</modules>', '<!--\n  </modules>'),
    );
    writeProject('core');

    expect(readMavenReactor(root).error).toContain('Cannot safely parse');
  });

  it.each([
    ['${module.name}', 'property expressions'],
    ['../outside', 'paths escaping the reactor'],
    ['missing', 'missing child POMs'],
    // cmd.exe expands %VAR% even inside `"…"`, and no legitimate Maven
    // module path uses `%`.
    ['a%b', 'shell-active module entries'],
    // `-pl` splits its selector on commas, and Maven reads any selector
    // carrying `:` as `[groupId]:artifactId` coordinates, never a path —
    // neither shape can reach a shell selector.
    ['a,b', '-pl selector separators'],
    ['a:b', '-pl coordinate markers'],
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

  it('discloses that a reactor-wide timeout is expected to exceed the deadline', () => {
    // On the large reactors this adapter targets, a root-POM change selects
    // the whole reactor, and `test` over it cannot finish in the default
    // deadline — say so, so no agent spends turns re-deriving it.
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['pom.xml'],
      timeout: 300,
      install: false,
      exec: (command) =>
        result(command, { exitCode: null, timedOut: true, seconds: 300 }),
    });

    expect(report.note).toContain('infrastructure result');
    expect(report.note).toContain('reactor-wide');
    expect(report.note).toContain('same scope');
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

  it('does not classify unframed disk-full words as a launch failure', () => {
    // `No space left on device` without Maven's `[ERROR]` framing is a test
    // exercising a disk-full path, not an outage; free text cannot tell the
    // two apart, so the framing decides, as for dependency failures.
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    for (const changed of ['pom.xml', '.mvn/maven.config', 'core/pom.xml']) {
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

    // No executable wrapper exists on disk, so the run used the system
    // `mvn`: a wrapper file this run never executed cannot have caused its
    // resolution failure, so the carve-out stays — with a disclosure.
    for (const changed of ['mvnw', 'mvnw.cmd']) {
      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: [changed],
        timeout: 5,
        install: false,
        exec: (command) => result(command, { exitCode: 1, output }),
      });
      expect(report.note).toContain('infrastructure evidence');
      expect(report.note).toContain('wrapper change itself was not exercised');
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

  it('does not launder a compile failure into infrastructure when dependency words share the output', () => {
    // A flaky mirror, or an upstream module pulled in by `-am`, can put one
    // `[ERROR] Could not transfer artifact` line in the same output as a
    // real compile error. The compile failure writes no Surefire XML, so
    // only the source markers keep it from reading as infrastructure.
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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
      mavenToolchainAdapter.run({
        root,
        changedFiles: ['core/src/Main.java'],
        timeout: 5,
        install: false,
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
        inheritors: {},
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

  it('attributes failures to the failing cases in declaration order', () => {
    // Surefire writes passing cases self-closing, in execution order: a
    // passing case must not absorb the following case's failure, and the
    // real failing cases must be the ones reported.
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

  it('keeps Kotlin compile failures source-attributed beside dependency words', () => {
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.kt'],
      timeout: 5,
      install: false,
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

  it('ignores CDATA markers that only appear inside comments', () => {
    // A CDATA-before-comments strip paired the commented \`<![CDATA[\` with a
    // commented \`]]>\` later in the file and swallowed the real markup
    // between them; inside a comment both are literal text.
    writeFileSync(
      join(root, 'pom.xml'),
      `
<project>
  <!-- CDATA sections look like this: <![CDATA[ -->
  <modules>
    <module>app</module>
  </modules>
  <!-- and they end like this: ]]> -->
</project>
`,
    );
    writeProject('app');

    expect(readMavenReactor(root)).toEqual({
      reactor: {
        modules: ['app'],
        projectDirs: ['.', 'app'],
        children: { '.': ['app'] },
        inheritors: {},
      },
    });
  });

  it('keeps parsing POMs whose content carries literal comment markers', () => {
    // replace/templating plugins substitute tokens like \`-->\` into text and
    // attribute values; well-formed CharData must not fail the reactor closed.
    writeFileSync(
      join(root, 'pom.xml'),
      `
<project>
  <build><plugins><plugin><configuration>
    <replacement>--></replacement>
    <arg value="a --> b"/>
  </configuration></plugin></plugins></build>
  <modules>
    <module>core</module>
  </modules>
</project>
`,
    );
    writeProject('core');

    expect(readMavenReactor(root).reactor?.modules).toEqual(['core']);
  });

  it('still builds the owning module for compilable files under a doc prefix', () => {
    // The docs?/ prefix exempts documentation EXTENSIONS only: a .java file
    // under doc/ is compilable input, not documentation.
    writeReactor();
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/README.md', 'core/doc/Helper.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/LICENSE', 'core/.gitignore'],
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

  const childPomInheriting = (relativePath?: string): string =>
    pom().replace(
      '<project>',
      `<project>
  <parent>
    <groupId>example</groupId>
    <artifactId>fixture</artifactId>
    <version>1</version>${
      relativePath ? `\n    <relativePath>${relativePath}</relativePath>` : ''
    }
  </parent>`,
    );

  it('fans a parent POM change out to the modules inheriting it', () => {
    writeProject('.', ['parent', 'core', 'ext']);
    writeProject('parent');
    writeProject('core');
    writeProject('ext');
    for (const module of ['core', 'ext']) {
      writeFileSync(
        join(root, module, 'pom.xml'),
        childPomInheriting('../parent/pom.xml'),
      );
    }

    const parsed = readMavenReactor(root);
    expect(parsed).toEqual({
      reactor: {
        modules: ['core', 'ext', 'parent'],
        projectDirs: ['.', 'core', 'ext', 'parent'],
        children: { '.': ['core', 'ext', 'parent'] },
        inheritors: { parent: ['core', 'ext'] },
      },
    });
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(
      detectMavenOwnership(root, ['parent/pom.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['core', 'ext', 'parent'],
      inactiveProjects: [],
    });
  });

  it('resolves a defaulted relativePath to the matching parent', () => {
    writeProject('.', ['core']);
    writeProject('core');
    writeFileSync(join(root, 'core', 'pom.xml'), childPomInheriting());

    // No explicit <relativePath>: Maven defaults to ../pom.xml, which here
    // is the root project carrying the declared artifactId.
    expect(readMavenReactor(root).reactor?.inheritors).toEqual({
      '.': ['core'],
    });
  });

  it('drops a parent edge whose artifactId does not match', () => {
    writeProject('.', ['core']);
    writeProject('core');
    writeFileSync(
      join(root, 'core', 'pom.xml'),
      childPomInheriting('../parent/pom.xml').replace(
        '<artifactId>fixture</artifactId>',
        '<artifactId>corporate-parent</artifactId>',
      ),
    );
    writeProject('parent');

    // The local pom does not carry the declared parent; Maven resolves it
    // from the repository, so there is no local edge to model.
    expect(readMavenReactor(root).reactor?.inheritors).toEqual({});
  });

  it('treats settings referenced by .mvn/maven.config as dependency inputs', () => {
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    writeFileSync(join(root, '.mvn', 'maven.config'), '-s settings.xml\n');
    writeFileSync(join(root, 'settings.xml'), '<settings/>\n');

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['settings.xml'],
      timeout: 5,
      install: false,
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

  it('treats a reactor-member POM under src/ as a dependency input', () => {
    // A reactor aggregating a project under another project's src/ models
    // it as a live member everywhere else, so changing its POM is a
    // resolution input too — not an inert fixture.
    writeProject('.', ['app', 'core/src/it/app']);
    writeProject('app');
    writeProject('core/src/it/app');

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/it/app/pom.xml'],
      timeout: 5,
      install: false,
      exec: (command) =>
        result(command, {
          exitCode: 1,
          output:
            '[ERROR] Could not resolve dependencies for project example:app',
        }),
    });

    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the carve-out when only the other platform wrapper changed',
    () => {
      // POSIX executes ./mvnw; a changed mvnw.cmd cannot affect the run.
      writeReactor();
      writeWrapper();
      writeFileSync(join(root, 'mvnw.cmd'), '@echo off\n');
      const calls: string[] = [];

      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: ['mvnw.cmd'],
        timeout: 5,
        install: false,
        exec: (command) => {
          calls.push(command);
          return result(command, {
            exitCode: 1,
            output:
              '[ERROR] Could not resolve dependencies for project example:core',
          });
        },
      });

      expect(calls[0]).toContain('./mvnw');
      expect(report.note).toContain('infrastructure evidence');
      expect(report.note).toContain('wrapper change itself was not exercised');
    },
  );

  it('clamps negative report counts to zero', () => {
    // A malformed failures="-3" must not cancel legitimate counts when
    // totals roll up across reports.
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
});
