/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
} from './maven-toolchain.js';

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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'maven-toolchain-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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
      modules: ['nested-parent', 'nested-parent/nested-leaf'],
      unowned: [],
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
      reactor: { modules: ['core'], projectDirs: ['.', 'core'] },
    });
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

  it('marks root code and Maven files reactor-wide and leaves docs without targets', () => {
    writeReactor();
    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');

    expect(
      detectMavenOwnership(
        root,
        [
          'pom.xml',
          '.mvn/maven.config',
          'mvnw',
          'mvnw.cmd',
          'src/main/java/example/Root.java',
        ],
        parsed.reactor,
      ),
    ).toEqual({
      reactorWide: true,
      modules: [],
      unowned: [],
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

  it('runs the root reactor for source fixtures with documentation extensions', () => {
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
    expect(calls).toEqual(['mvn --batch-mode --no-transfer-progress test']);
  });

  it('prefers the wrapper, runs from root, narrows modules, and forwards timeout', () => {
    writeReactor();
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
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

    expect(calls).toEqual([
      [
        './mvnw --batch-mode --no-transfer-progress -pl core,extension -am test',
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
  });

  it('does not classify a changed wrapper permission failure as infrastructure', () => {
    writeReactor();
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');

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

  it.each([
    ['/bin/sh: ./mvnw: Permission denied', true, 126],
    ['sh: 1: mvn: not found', false, 127],
    ['java.io.IOException: No space left on device', false, 1],
  ])(
    'classifies unchanged Maven startup failures as infrastructure',
    (output, wrapper, exitCode) => {
      writeReactor();
      if (wrapper) writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');

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

  it('does not treat an inner permission error as a wrapper startup failure', () => {
    writeReactor();
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');

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
          output: 'java.net.ConnectException: Connection refused',
        });
      },
    });

    expect(report.test[0]?.output).toContain('[maven-test-failure]');
    expect(report.note).toContain('Correlate compiler or test errors');
    expect(report.note).not.toContain('infrastructure evidence');
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

  it('selects the wrapper a platform can execute', () => {
    writeProject('.');
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
    writeFileSync(join(root, 'mvnw.cmd'), '@echo off\n');

    expect(mavenExecutable(root, 'linux')).toBe('./mvnw');
    expect(mavenExecutable(root, 'darwin')).toBe('./mvnw');
    expect(mavenExecutable(root, 'win32')).toBe('mvnw.cmd');

    rmSync(join(root, 'mvnw'));
    rmSync(join(root, 'mvnw.cmd'));
    expect(mavenExecutable(root, 'linux')).toBe('mvn');
    expect(mavenExecutable(root, 'win32')).toBe('mvn');
  });

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
      unowned: metadata,
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
      '[maven-test-report] 20 more failing report(s) omitted',
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
});
