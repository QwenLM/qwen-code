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
import type { CommandResult } from '../build-test.js';
import { observedTestCounts } from '../test-plan.js';
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

  it('fails closed on an XML entity in a captured id or relativePath', () => {
    // Maven decodes entities before matching parent resolution, but this
    // harness captures raw text: `my&#45;app` and `my-app` would compare
    // unequal here and silently drop a real inheritance edge. The parse
    // fails closed instead, like the `<module>` gate.
    writeProject('.', ['core']);
    writeProject('core');
    writeFileSync(
      join(root, 'core', 'pom.xml'),
      childPomInheriting('../parent/pom.xml').replace(
        '<artifactId>fixture</artifactId>',
        '<artifactId>fix&#45;ture</artifactId>',
      ),
    );
    writeProject('parent');

    expect(readMavenReactor(root).error).toContain('Cannot safely parse');
  });

  it('fails closed on a tag whose quote never closes', () => {
    // An unterminated QUOTE swallows the rest of the document into the
    // phantom tag and used to return a successful-but-shrunken structure
    // with every later `<module>` silently lost; it must fail closed like
    // any other unparseable shape.
    writeFileSync(
      join(root, 'pom.xml'),
      '<project attr="unterminated>\n' +
        '  <modules><module>core</module></modules>\n' +
        '</project>',
    );
    writeProject('core');

    expect(readMavenReactor(root).error).toContain('Cannot safely parse');
  });

  it.skipIf(process.platform === 'win32')(
    'deduplicates symlink-aliased reactor dirs by real path',
    () => {
      // Each level lists two symlinks to the next level: 2^depth distinct
      // LEXICAL paths at constant depth. A lexical dedup key walks every
      // one of them; the realpath key walks one per real pom.
      for (let level = 0; level < 30; level++) {
        writeProject(`d${level}`, ['s1', 's2']);
      }
      writeProject('d30');
      for (let level = 0; level < 30; level++) {
        symlinkSync(join(root, `d${level + 1}`), join(root, `d${level}`, 's1'));
        symlinkSync(join(root, `d${level + 1}`), join(root, `d${level}`, 's2'));
      }
      writeFileSync(join(root, 'pom.xml'), pom(['d0']));

      const startedAt = Date.now();
      const parsed = readMavenReactor(root);
      expect(parsed.error).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // Linear in the number of REAL poms, not 2^depth.
      expect(parsed.reactor?.modules.length).toBeLessThan(200);
    },
    20_000,
  );

  it('parses a shared named-parent chain once per file, not once per heir', () => {
    // Every heir declares the same 30-file parent chain; the worklist
    // memoizes each file's parse, so the walk costs O(files), not
    // O(heirs x files) — probe-measured at seconds the other way.
    writeProject(
      '.',
      Array.from({ length: 25 }, (_, i) => `heir${i}`),
    );
    for (let i = 0; i < 25; i++) {
      writeProject(`heir${i}`);
      writeFileSync(
        join(root, `heir${i}`, 'pom.xml'),
        childPomInheriting('../parents/p0.xml').replace(
          '<artifactId>fixture</artifactId>',
          '<artifactId>parent0</artifactId>',
        ),
      );
    }
    mkdirSync(join(root, 'parents'), { recursive: true });
    // Pad each file so a parse costs milliseconds: without the memo the
    // 750 pops re-read and re-parse each file once PER HEIR (~8s
    // probe-measured at this size), with it each file parses once.
    const padding = `<!-- ${'x'.repeat(1_000_000)} -->`;
    for (let i = 0; i < 30; i++) {
      const next = i + 1;
      const base =
        next < 30
          ? childPomInheriting(`p${next}.xml`).replace(
              '<artifactId>fixture</artifactId>',
              `<artifactId>parent${next}</artifactId>`,
            )
          : pom();
      writeFileSync(
        join(root, 'parents', `p${i}.xml`),
        base
          .replace(
            /<artifactId>fixture<\/artifactId>/,
            `<artifactId>parent${i}</artifactId>`,
          )
          .replace('</project>', `${padding}\n</project>`),
      );
    }

    const startedAt = Date.now();
    const parsed = readMavenReactor(root);
    expect(parsed.error).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(parsed.reactor?.parentPomFiles).toContain('parents/p0.xml');
  }, 30_000);

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
    } else if (module !== 'missing') {
      // A real child POM under every other declared name, so the named
      // gate — not the missing-child-POM gate — is the SOLE error source:
      // with no child pom these cases passed even with their character
      // gate removed (mutation-verified), masked by the existsSync check.
      // ':' cannot appear in a Windows directory name, so that case keeps
      // the missing-child fallback on win32.
      if (!(process.platform === 'win32' && module.includes(':'))) {
        writeProject(module);
      }
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

  it('scopes a named parent change to its heirs when its dir hosts no project', () => {
    // The named parent lives in a directory that is NOT a reactor member:
    // the inheritor closure already computed the exact scope, and the
    // unowned catch-all must not widen it to the full reactor.
    writeProject('.', ['app']);
    writeProject('app');
    mkdirSync(join(root, 'build-parent'), { recursive: true });
    writeFileSync(join(root, 'build-parent', 'parent.xml'), pom());
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../build-parent/parent.xml'),
    );

    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(
      detectMavenOwnership(root, ['build-parent/parent.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['app'],
      inactiveProjects: [],
    });
  });

  it('does not over-scope closures through a named parent in an active module dir', () => {
    // core hosts BOTH its own pom.xml (aggregating core/sub, inherited by
    // ext) and the named file parent.xml (inherited by app). File-keyed
    // edges keep the two closures apart in both directions.
    writeProject('.', ['core', 'app', 'ext']);
    writeProject('core', ['sub']);
    writeProject('core/sub');
    writeProject('app');
    writeProject('ext');
    writeFileSync(join(root, 'core', 'parent.xml'), pom());
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../core/parent.xml'),
    );
    for (const module of ['ext']) {
      writeFileSync(
        join(root, module, 'pom.xml'),
        childPomInheriting('../core/pom.xml'),
      );
    }

    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');
    // Changing core/pom.xml reaches core's aggregation and inheritance —
    // but NOT app, which inherits the named file, not core/pom.xml.
    expect(
      detectMavenOwnership(root, ['core/pom.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['core', 'core/sub', 'ext'],
      inactiveProjects: [],
    });
    // Changing core/parent.xml reaches app — but NOT core/sub or ext,
    // which the named file does not touch.
    expect(
      detectMavenOwnership(root, ['core/parent.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['app', 'core'],
      inactiveProjects: [],
    });
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
    // The deadline is wall clock from the top of the call: freeze it so
    // the forwarded deadline asserts exactly.
    const clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    let report: ReturnType<typeof mavenToolchainAdapter.run>;
    try {
      report = mavenToolchainAdapter.run({
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

  it.skipIf(process.platform === 'win32')(
    'does not classify a changed wrapper permission failure as infrastructure',
    () => {
      // On win32 `mvnw` is the other platform's wrapper and is skipped by
      // ownership, so the adapter sees no Maven target to run.

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
    // resolution failure, so the carve-out stays — with a disclosure. Only
    // this platform's wrapper is exercised: a change confined to the OTHER
    // platform's wrapper leaves no Maven target to run at all (see the
    // other-platform-wrapper test below).
    const platformWrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
    for (const changed of [platformWrapper]) {
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: ['mvnw'],
        timeout: 5,
        install: false,
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
    },
  );

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

  it('re-checks the disk floor after the warm-up, before the lifecycle', () => {
    // The warm-up is the phase that fills the disk: a cold reactor's
    // dependency:go-offline can consume the headroom the preflight
    // passed, and the lifecycle must not run on the now-full disk.
    statfsSyncMock
      .mockReturnValueOnce({ bavail: 16 * 1024 ** 3, bsize: 1 })
      .mockReturnValueOnce({ bavail: 0, bsize: 1 });
    writeReactor();
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
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

  it('keeps a fail-never dependency failure PR-attributed when the inputs changed', () => {
    // The exit-0 half of the dependency carve-out exception: with resolution
    // inputs changed, the swallowed failure stays a failed run — not green,
    // and not laundered into an environmental result.
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/pom.xml'],
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
    expect(report.test[0]?.infrastructure).toBeUndefined();
    expect(report.test[0]?.swallowedFailure).toBe(true);
    expect(report.note).toContain('fail-never');
    expect(report.note).not.toContain('infrastructure evidence');
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
    const oversized = mavenToolchainAdapter.run({
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
    expect(oversized.note).toContain('infrastructure evidence');

    // ...and under the cap the identical config suppresses it.
    writeFileSync(join(root, '.mvn', 'maven.config'), '-s settings.xml\n');
    const undersized = mavenToolchainAdapter.run({
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
    expect(undersized.note).toContain('Correlate compiler or test errors');
    expect(undersized.note).not.toContain('infrastructure evidence');
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: [other],
      timeout: 5,
      install: false,
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
    const mixed = mavenToolchainAdapter.run({
      root,
      changedFiles: [other, 'core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const failed = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
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
    // A mid-level aggregator change closes over every aggregation
    // descendant; on large reactors the comma-joined selector approaches
    // cmd.exe's 8191-character line limit, so past the cap the run widens
    // to the full reactor instead of shipping a command line the platform
    // may refuse to launch.
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
      changedFiles: ['agg/pom.xml'],
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['.mvn/wrapper/maven-wrapper.properties'],
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
    expect(report.test[0]?.infrastructure).toBeUndefined();
  });

  it('builds the owning module for resource-like text files outside doc locations', () => {
    // A .txt is only exempted at doc-shaped locations: a resource wired
    // into the artifact via maven-resources-plugin (which points at
    // arbitrary dirs) must keep the build instead of silently skipping it.
    writeReactor();
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/config/messages.txt'],
      timeout: 5,
      install: false,
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/notes.txt', 'core/site/index.rst'],
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return result(command);
      },
    });

    expect(report.ok).toBe(true);
    expect(report.affected).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reads a CDATA-wrapped parent artifactId instead of silently dropping the edge', () => {
    writeProject('.', ['core']);
    writeProject('core');
    writeFileSync(
      join(root, 'core', 'pom.xml'),
      pom().replace(
        '<project>',
        `<project>
  <parent>
    <groupId>example</groupId>
    <artifactId><![CDATA[fixture]]></artifactId>
    <version>1</version>
  </parent>`,
      ),
    );

    expect(readMavenReactor(root).reactor?.inheritors).toEqual({
      '.': ['core'],
    });
  });

  it('fails closed when CDATA content carries markup of its own', () => {
    // Unwrapped CDATA containing `<` cannot be tokenized unambiguously;
    // failing the whole POM closed beats silently misparsing it.
    writeFileSync(
      join(root, 'pom.xml'),
      pom(['core']).replace(
        '<modules>',
        '<build><x><![CDATA[ a < b ]]></x></build>\n  <modules>',
      ),
    );
    writeProject('core');

    expect(readMavenReactor(root).error).toContain('Cannot safely parse');
  });

  it('fails closed on BALANCED markup inside CDATA too', () => {
    // Balanced CDATA markup tokenizes cleanly, which is exactly the
    // hazard: at the right stack depth it could overwrite a real
    // `<relativePath>` and silently delete the inheritance edge. CDATA is
    // text; any `<` inside it fails the POM closed.
    writeProject('.', ['core']);
    writeProject('core');
    writeFileSync(
      join(root, 'core', 'pom.xml'),
      childPomInheriting('../parent/pom.xml').replace(
        '</parent>',
        '<![CDATA[<relativePath>nowhere</relativePath>]]></parent>',
      ),
    );
    writeProject('parent');

    expect(readMavenReactor(root).error).toContain('Cannot safely parse');
  });

  it('resolves a named parent FILE relativePath and fans its change out', () => {
    // Maven accepts a parent FILE of any name (DefaultModelBuilder appends
    // pom.xml only when the resolved path is a directory): the Druid shape,
    // `<relativePath>../base/parent.xml</relativePath>`. The edge must be
    // recorded, and changing the named file must walk the inheritor closure
    // exactly like changing the directory's pom.xml.
    writeProject('.', ['base', 'app']);
    writeProject('base');
    writeProject('app');
    writeFileSync(join(root, 'base', 'parent.xml'), pom());
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../base/parent.xml'),
    );

    const parsed = readMavenReactor(root);
    // Named-parent heirs are keyed on the FILE: keying them on `base`
    // would conflate them with the inheritors of base/pom.xml itself.
    expect(parsed.reactor?.inheritors).toEqual({ 'base/parent.xml': ['app'] });
    expect(parsed.reactor?.parentPomFiles).toEqual(['base/parent.xml']);
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(
      detectMavenOwnership(root, ['base/parent.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['app', 'base'],
      inactiveProjects: [],
    });
  });

  it('does not parse CDATA-wrapped report content as markup', () => {
    // `<system-out>` CDATA is the standard vehicle for test output that
    // itself contains XML; scanning it as markup fabricated phantom suites
    // and failure evidence for a passing one-test suite.
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

  it('keeps a dependency outage infrastructure when the changed POM is deleted', () => {
    // `legacy/pom.xml` exists only in the diff — a deleted POM cannot be a
    // resolution input, so it must not suppress the infrastructure
    // carve-out for an outage the diff cannot have caused.
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java', 'legacy/pom.xml'],
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
    expect(report.test[0]?.infrastructure).toBe(true);
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

  it('caps the fresh reports one run parses, and discloses the omission', () => {
    // The mtime freshness filter accepts any writer, so the PR's own
    // tests control how many reports exist at parse time. Past the cap
    // the parse stops and the evidence block says so — nothing reads
    // thousands of reports without a disclosure.
    writeReactor();

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

    expect(report.ok).toBe(true);
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
      timeout: 5,
      install: false,
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

  it('walks descendants of a module named after an Object.prototype key', () => {
    // children/inheritors are indexed by PR-controlled dir names; a plain
    // Record read `constructor` as the inherited prototype member and the
    // `?? []` guard never fired — one module name threw a TypeError out of
    // the whole ownership walk.
    writeProject('.', ['constructor', 'heir']);
    writeProject('constructor');
    writeProject('heir');
    writeFileSync(
      join(root, 'heir', 'pom.xml'),
      childPomInheriting('../constructor/pom.xml'),
    );

    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(parsed.reactor.inheritors).toEqual({ constructor: ['heir'] });
    expect(
      detectMavenOwnership(root, ['constructor/pom.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['constructor', 'heir'],
      inactiveProjects: [],
    });
  });

  it('fails closed on reactor nesting deeper than the cap', () => {
    // Real reactors nest a handful of levels; a deeper chain is a hostile
    // checkout shape, and the walk must hand back the { error } contract
    // instead of overflowing the stack.
    let parent = '.';
    for (let i = 0; i < 600; i++) {
      const name = `d${i}`;
      writeProject(parent, [name]);
      parent = parent === '.' ? name : `${parent}/${name}`;
    }
    writeProject(parent);

    const parsed = readMavenReactor(root);
    expect(parsed.error).toContain('deeper than 512 levels');
  });

  it('treats a changed named parent POM as a dependency input', () => {
    // Ownership routing models named parent files as build inputs; the
    // resolution carve-out must too, or a PR-caused resolution failure
    // through one is laundered into infrastructure.
    writeProject('.', ['base', 'app']);
    writeProject('base');
    writeProject('app');
    writeFileSync(join(root, 'base', 'parent.xml'), pom());
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../base/parent.xml'),
    );

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['base/parent.xml'],
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

  it('treats attached -s<path> settings as dependency inputs too', () => {
    // commons-cli accepts the attached short form (`-sci/settings.xml`);
    // missing it laundered a PR-caused resolution break into
    // infrastructure.
    writeReactor();
    mkdirSync(join(root, '.mvn'));
    mkdirSync(join(root, 'ci'));
    writeFileSync(join(root, '.mvn', 'maven.config'), '-sci/settings.xml\n');
    writeFileSync(join(root, 'ci', 'settings.xml'), '<settings/>\n');

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['ci/settings.xml'],
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

  it('fails closed on a POM larger than the read cap', () => {
    // A hostile PR can commit a module pom.xml inside GitHub's per-file
    // limit that the tokenizer would amplify into gigabytes of heap; the
    // read is size-capped and fails closed like the other unreadable shapes.
    writeProject('.', ['huge']);
    mkdirSync(join(root, 'huge'), { recursive: true });
    writeFileSync(
      join(root, 'huge', 'pom.xml'),
      'x'.repeat(2 * 1024 * 1024 + 1),
    );

    const parsed = readMavenReactor(root);
    expect(parsed.error).toContain('larger than the 2097152-byte read cap');

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['huge/pom.xml'],
      timeout: 5,
      install: false,
      exec: (command) => result(command),
    });
    expect(report.toolchain).toBe('unsupported');
    expect(report.note).toContain('read cap');
  });

  it('walks a parent chain that passes through named parent files', () => {
    // app -> base/parent.xml (named file) -> grand/parent2.xml (named
    // file): Maven merges the WHOLE chain into app, so the higher file's
    // directory must carry an inheritance edge to app too, and both named
    // files are dependency inputs / parent-config changes.
    writeProject('.', ['grand', 'base', 'app']);
    writeProject('grand');
    writeProject('base');
    writeProject('app');
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../base/parent.xml'),
    );
    writeFileSync(
      join(root, 'base', 'parent.xml'),
      childPomInheriting('../grand/parent2.xml'),
    );
    writeFileSync(join(root, 'grand', 'parent2.xml'), pom());

    const parsed = readMavenReactor(root);
    expect(parsed.reactor?.inheritors).toEqual({
      'base/parent.xml': ['app'],
      'grand/parent2.xml': ['app'],
    });
    expect(parsed.reactor?.parentPomFiles).toEqual([
      'base/parent.xml',
      'grand/parent2.xml',
    ]);
    if (!parsed.reactor) throw new Error('expected reactor');
    // A change to the HIGHER parent reaches the transitive inheritor.
    expect(
      detectMavenOwnership(root, ['grand/parent2.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['app', 'grand'],
      inactiveProjects: [],
    });
  });

  it('walks an inheritance chain through an out-of-reactor pom.xml', () => {
    // app inherits ../shared/parent/pom.xml, which the reactor aggregates
    // nowhere and which itself inherits ../../parent-bom/pom.xml: Maven
    // merges the WHOLE chain into app, so the edge must survive the
    // pom.xml-spelled intermediate instead of dying on it.
    writeProject('.', ['app', 'parent-bom']);
    writeProject('app');
    writeProject('parent-bom');
    mkdirSync(join(root, 'shared', 'parent'), { recursive: true });
    writeFileSync(
      join(root, 'shared', 'parent', 'pom.xml'),
      childPomInheriting('../../parent-bom/pom.xml'),
    );
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../shared/parent/pom.xml'),
    );

    const parsed = readMavenReactor(root);
    expect(parsed.reactor?.inheritors).toEqual({
      'shared/parent': ['app'],
      'parent-bom': ['app'],
    });
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(
      detectMavenOwnership(root, ['parent-bom/pom.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['app', 'parent-bom'],
      inactiveProjects: [],
    });
    // Changing the intermediate itself fails closed exactly like its
    // named-file twin: it is a project outside the root reactor.
    expect(
      detectMavenOwnership(root, ['shared/parent/pom.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: [],
      inactiveProjects: ['shared/parent'],
    });
  });

  it('routes a wrapper-spelled named parent file instead of skipping it', () => {
    // A root-level parent FILE literally named after the OTHER platform's
    // wrapper is still a recorded build input: the wrapper skip must not
    // swallow its closure into a green no-op.
    writeProject('.', ['app']);
    writeProject('app');
    const wrapper = process.platform === 'win32' ? 'mvnw' : 'mvnw.cmd';
    writeFileSync(join(root, wrapper), pom());
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting(`../${wrapper}`),
    );

    const parsed = readMavenReactor(root);
    expect(parsed.reactor?.parentPomFiles).toEqual([wrapper]);
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(detectMavenOwnership(root, [wrapper], parsed.reactor)).toEqual({
      reactorWide: true,
      modules: [],
      inactiveProjects: [],
    });
  });

  it('fails closed for a real project located exactly at a src path', () => {
    // A standalone project at src/pom.xml is not test data: the fixture
    // guard only fires strictly beneath src/, or the out-of-reactor abort
    // never sees the shape and `-pl . -am` tests the wrong project.
    writeProject('.');
    writeProject('src');

    const parsed = readMavenReactor(root);
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(
      detectMavenOwnership(root, ['src/main/java/App.java'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: [],
      inactiveProjects: ['src'],
    });
  });

  it('keeps the chain through a named parent file inside the heir dir', () => {
    // core/pom.xml inherits core/parent.xml, which itself inherits
    // ../gp/pom.xml; app inherits core through the same file. The self-dir
    // guard must skip only a true pom.xml self-reference: the named file
    // keeps its registration, its chain continuation, and its fan-out.
    writeProject('.', ['core', 'app', 'gp']);
    writeProject('core');
    writeProject('app');
    writeProject('gp');
    writeFileSync(
      join(root, 'core', 'pom.xml'),
      childPomInheriting('parent.xml'),
    );
    writeFileSync(
      join(root, 'core', 'parent.xml'),
      childPomInheriting('../gp/pom.xml'),
    );
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../core/parent.xml'),
    );

    const parsed = readMavenReactor(root);
    expect(parsed.reactor?.inheritors).toEqual({
      'core/parent.xml': ['app'],
      gp: ['app', 'core'],
    });
    expect(parsed.reactor?.parentPomFiles).toEqual(['core/parent.xml']);
    if (!parsed.reactor) throw new Error('expected reactor');
    expect(detectMavenOwnership(root, ['gp/pom.xml'], parsed.reactor)).toEqual({
      reactorWide: false,
      modules: ['app', 'core', 'gp'],
      inactiveProjects: [],
    });
    expect(
      detectMavenOwnership(root, ['core/parent.xml'], parsed.reactor),
    ).toEqual({
      reactorWide: false,
      modules: ['app', 'core'],
      inactiveProjects: [],
    });
  });

  it('strips dense comment sections in linear time', () => {
    // stripOpaqueSections re-ran indexOf for BOTH markers from the scan
    // position on every iteration — quadratic on comment-dense CDATA-free
    // reports (~34s per 1 MiB measured), on PR-controlled bytes. The
    // forward walk must stay fast at this size.
    writeReactor();
    const startedAt = Date.now();

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
          '<testsuite tests="1" failures="0" errors="0" skipped="0">' +
            '<testcase classname="example.CoreTest" name="passes"/>' +
            '<!-- comment -->'.repeat(60_000) +
            '</testsuite>',
        );
        return result(command);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(report.ok).toBe(true);
  }, 20_000);

  it('keeps the inactive-project abort for an out-of-reactor named parent', () => {
    // standalone/parent.xml backs app's inheritance edge, but standalone
    // is not a reactor member: changing the named parent must fail closed
    // exactly like changing any other file of standalone/.
    writeProject('.', ['app']);
    writeProject('app');
    writeProject('standalone');
    writeFileSync(join(root, 'standalone', 'parent.xml'), pom());
    writeFileSync(
      join(root, 'app', 'pom.xml'),
      childPomInheriting('../standalone/parent.xml'),
    );
    const calls: string[] = [];

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['standalone/parent.xml'],
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

  it('quotes the deadline the lifecycle actually ran under in its timeout note', () => {
    // The warm-up spends shared budget first, so the lifecycle fires a
    // shorter deadline than the --timeout flag; the note must quote the
    // number that fired, not the flag default.
    writeReactor();
    let clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    try {
      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: ['core/src/Main.java'],
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
      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: ['core/src/Main.java'],
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
      const report = mavenToolchainAdapter.run({
        root,
        changedFiles: ['core/src/Main.java'],
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

    const report = mavenToolchainAdapter.run({
      root,
      changedFiles: ['core/src/Main.java'],
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
});
