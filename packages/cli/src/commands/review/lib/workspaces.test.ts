/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workspaceDirFor,
  isWorkspaceMember,
  isNegationExcluded,
  affectedWorkspaces,
  buildSetFor,
  dependencyClosure,
  chainsCommands,
  declaredBuildHeapMb,
  hasUnmodeledWorkspaceGlob,
  readWorkspaceGlobs,
  readRootPackage,
  readWorkspacePackages,
  reverseDependencyClosure,
  rootBuildFanOutScript,
  scriptFansOut,
  type WorkspacePackage,
} from './workspaces.js';

// This repo's own globs, in this repo's own order. The order is the point: npm
// evaluates them in sequence and the last match wins.
const GLOBS = [
  'packages/*',
  'packages/channels/base',
  'packages/channels/telegram',
  'packages/channels/qqbot',
  '!packages/desktop',
];

describe('workspaceDirFor', () => {
  it('gives `packages/*` one path segment, not the whole subtree', () => {
    expect(
      workspaceDirFor('packages/cli/src/commands/review/submit.ts', GLOBS),
    ).toBe('packages/cli');
  });

  it('lets an explicitly-listed nested workspace win over the star that also matches it', () => {
    // `packages/*` matches this too, and would claim `packages/channels`, which is
    // not a package at all. The explicit glob is listed after it, so it wins — and
    // the build/test commands are scoped to a directory that has a package.json.
    expect(workspaceDirFor('packages/channels/qqbot/src/x.ts', GLOBS)).toBe(
      'packages/channels/qqbot',
    );
  });

  it('honours a negation, so a separate toolchain is not a member', () => {
    // packages/desktop has its own lockfile and is not part of this npm workspace.
    // Building it from the root fails.
    expect(
      workspaceDirFor('packages/desktop/apps/electron/src/main.ts', GLOBS),
    ).toBeNull();
    expect(isWorkspaceMember('packages/desktop/src/a.test.ts', GLOBS)).toBe(
      false,
    );
  });

  it('re-includes what a negation excluded when a later glob matches again', () => {
    // npm's own rule: last match wins, whichever direction it points.
    const globs = ['packages/*', '!packages/desktop', 'packages/desktop'];
    expect(workspaceDirFor('packages/desktop/src/a.ts', globs)).toBe(
      'packages/desktop',
    );
  });

  it('falls back to the surviving OUTER member when a negation excludes a nested one', () => {
    // npm keeps packages/desktop in the graph — only src is excluded — and
    // desktop's test runner collects src/**, so the file is felt by the outer
    // member's suite. Declaring it felt by NOTHING would certify "a complete
    // answer" over a suite that can fail.
    const globs = ['packages/*', 'packages/desktop/*', '!packages/desktop/src'];
    expect(workspaceDirFor('packages/desktop/src/x.test.ts', globs)).toBe(
      'packages/desktop',
    );
    expect(isNegationExcluded('packages/desktop/src/x.test.ts', globs)).toBe(
      false,
    );
  });

  it('treats a ./-prefixed glob like its bare form', () => {
    // npm accepts `./packages/*`; the walker stripped `./` from FILE paths
    // only, so the glob form matched nothing and every member was dropped.
    expect(workspaceDirFor('packages/cli/src/a.ts', ['./packages/*'])).toBe(
      'packages/cli',
    );
    expect(hasUnmodeledWorkspaceGlob(['./packages/*'])).toBe(false);
  });

  it('returns null for a file inside no workspace', () => {
    expect(workspaceDirFor('README.md', GLOBS)).toBeNull();
    expect(workspaceDirFor('integration-tests/foo.test.ts', GLOBS)).toBeNull();
    expect(workspaceDirFor('.github/workflows/ci.yml', GLOBS)).toBeNull();
  });

  it('tolerates a `./` prefix', () => {
    expect(workspaceDirFor('./packages/cli/src/a.ts', GLOBS)).toBe(
      'packages/cli',
    );
  });
});

describe('readWorkspaceGlobs', () => {
  it('reads the array form', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*', 'apps/web'] }),
    );
    expect(readWorkspaceGlobs(root)).toEqual(['packages/*', 'apps/web']);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the object form `{ workspaces: { packages: [...] } }` npm also accepts', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: { packages: ['packages/*'] } }),
    );
    expect(readWorkspaceGlobs(root)).toEqual(['packages/*']);
    rmSync(root, { recursive: true, force: true });
  });

  it('is empty for a package.json with no workspaces (and never throws)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r' }));
    expect(readWorkspaceGlobs(root)).toEqual([]);
    expect(readWorkspaceGlobs(join(root, 'nope'))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('readRootPackage', () => {
  it('returns the root as a single `.` package when it has a build/test script', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'solo',
        scripts: { build: 'tsc', lint: 'eslint' },
      }),
    );
    const p = readRootPackage(root);
    expect(p).toEqual({
      dir: '.',
      name: 'solo',
      scripts: ['build', 'lint'],
      deps: [],
      scriptsText: { build: 'tsc', lint: 'eslint' },
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null when the root has no build or test script', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'solo', scripts: { lint: 'eslint' } }),
    );
    expect(readRootPackage(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null (never throws) when there is no readable package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    expect(readRootPackage(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null (never throws) when the root manifest body is `null`', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(root, 'package.json'), 'null');
    expect(readRootPackage(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the declared dependencies — a root suite can depend on a workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        scripts: { test: 'vitest' },
        dependencies: { '@x/core': '*' },
        devDependencies: { '@x/tool': '*' },
      }),
    );
    expect(readRootPackage(root)?.deps).toEqual(['@x/core', '@x/tool']);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('isNegationExcluded', () => {
  it('is true when a positive glob claims the file but a negation excludes it', () => {
    expect(isNegationExcluded('packages/desktop/src/main.rs', GLOBS)).toBe(
      true,
    );
  });

  it('is false for a file inside an included workspace', () => {
    expect(isNegationExcluded('packages/cli/src/a.ts', GLOBS)).toBe(false);
  });

  it('is false for a file no positive glob claims — genuinely outside', () => {
    expect(isNegationExcluded('scripts/build.js', GLOBS)).toBe(false);
    expect(isNegationExcluded('README.md', GLOBS)).toBe(false);
  });

  it('is false when a later glob re-includes what the negation excluded', () => {
    const globs = ['packages/*', '!packages/desktop', 'packages/desktop'];
    expect(isNegationExcluded('packages/desktop/src/a.ts', globs)).toBe(false);
  });

  it('keeps a member owned under a partial negation (`!packages/desktop/*`)', () => {
    // npm keeps packages/desktop itself a member — a glob with a subpath
    // cannot match the dir itself — so a file under it is still owned and its
    // suite can feel a change there; it is NOT negation-excluded.
    const globs = ['packages/*', '!packages/desktop/*'];
    expect(workspaceDirFor('packages/desktop/src/main.ts', globs)).toBe(
      'packages/desktop',
    );
    expect(isNegationExcluded('packages/desktop/src/main.ts', globs)).toBe(
      false,
    );
  });
});

describe('readWorkspacePackages', () => {
  let root: string;

  const setup = (globs: string[]): void => {
    root = mkdtempSync(join(tmpdir(), 'ws-read-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: globs }),
    );
  };
  const teardown = (): void => {
    rmSync(root, { recursive: true, force: true });
  };
  const write = (dir: string, body: object | string): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'package.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  };

  it('returns the packages and reports a manifest that does not parse as skipped', () => {
    setup(['packages/*']);
    write('packages/good', { name: '@x/good' });
    write('packages/bad', '{ not json');
    const { packages, skipped } = readWorkspacePackages(root);
    expect(packages.map((p) => p.dir)).toEqual(['packages/good']);
    expect(skipped).toEqual(['packages/bad']);
    teardown();
  });

  it('reports a manifest with no usable `name` as skipped — npm links it all the same', () => {
    // A nameless member is invisible to the dependency graph but NOT to npm:
    // its dependencies link, so its reverse edges must not be silently lost.
    setup(['packages/*']);
    write('packages/core', { name: '@x/core' });
    write('packages/nameless', { dependencies: { '@x/core': '*' } });
    write('packages/numbered', { name: 42 });
    write('packages/array', '[1, 2]');
    const { packages, skipped } = readWorkspacePackages(root);
    expect(packages.map((p) => p.dir)).toEqual(['packages/core']);
    expect(skipped).toEqual([
      'packages/array',
      'packages/nameless',
      'packages/numbered',
    ]);
    teardown();
  });

  it('reports a manifest whose body is the JSON literal `null` as skipped', () => {
    // `null` parses successfully, so it never reaches the parse-catch; the
    // name check must classify it instead of throwing past the try/catch and
    // crashing the whole build-test run.
    setup(['packages/*']);
    write('packages/core', { name: '@x/core' });
    write('packages/nullish', 'null');
    const { packages, skipped } = readWorkspacePackages(root);
    expect(packages.map((p) => p.dir)).toEqual(['packages/core']);
    expect(skipped).toEqual(['packages/nullish']);
    teardown();
  });

  it('collects optionalDependencies — npm links a workspace member listed there', () => {
    setup(['packages/*']);
    write('packages/core', { name: '@x/core' });
    write('packages/cond', {
      name: '@x/cond',
      optionalDependencies: { '@x/core': '*' },
    });
    const { packages } = readWorkspacePackages(root);
    expect(packages.find((p) => p.dir === 'packages/cond')?.deps).toEqual([
      '@x/core',
    ]);
    teardown();
  });

  it('collects peerDependencies — npm links a workspace member listed there', () => {
    setup(['packages/*']);
    write('packages/core', { name: '@x/core' });
    write('packages/peer', {
      name: '@x/peer',
      peerDependencies: { '@x/core': '*' },
    });
    const { packages } = readWorkspacePackages(root);
    expect(packages.find((p) => p.dir === 'packages/peer')?.deps).toEqual([
      '@x/core',
    ]);
    teardown();
  });

  it('ignores a dir with no manifest — npm does not treat it as a workspace', () => {
    setup(['packages/*']);
    write('packages/good', { name: '@x/good' });
    mkdirSync(join(root, 'packages', 'assets'), { recursive: true });
    const { skipped } = readWorkspacePackages(root);
    expect(skipped).toEqual([]);
    teardown();
  });

  it('ignores a broken manifest in a NEGATED dir — not a workspace, not our graph', () => {
    setup(['packages/*', '!packages/desktop']);
    write('packages/good', { name: '@x/good' });
    write('packages/desktop', '{ not json');
    const { packages, skipped } = readWorkspacePackages(root);
    expect(packages.map((p) => p.dir)).toEqual(['packages/good']);
    expect(skipped).toEqual([]);
    teardown();
  });

  it('checks literally-listed workspace dirs too, not only starred bases', () => {
    setup(['packages/*', 'integrations/ctx']);
    write('integrations/ctx', '{ not json');
    const { skipped } = readWorkspacePackages(root);
    expect(skipped).toEqual(['integrations/ctx']);
    teardown();
  });

  it('reports a literal member shadowed by a LATER star glob as skipped', () => {
    // npm expands both entry orders to the same member set, but this walker's
    // last-match-wins ownership gives the literal member's files to the star —
    // the graph cannot represent it, so it is disclosed, not silently dropped.
    setup(['packages/foo/nested', 'packages/*']);
    write('packages/foo', { name: '@x/foo' });
    write('packages/foo/nested', { name: '@x/nested' });
    const { packages, skipped } = readWorkspacePackages(root);
    expect(packages.map((p) => p.dir)).toEqual(['packages/foo']);
    expect(skipped).toEqual(['packages/foo/nested']);
    teardown();
  });

  it('keeps the same literal member when the star comes FIRST', () => {
    setup(['packages/*', 'packages/foo/nested']);
    write('packages/foo', { name: '@x/foo' });
    write('packages/foo/nested', { name: '@x/nested' });
    const { packages, skipped } = readWorkspacePackages(root);
    expect(packages.map((p) => p.dir)).toEqual([
      'packages/foo',
      'packages/foo/nested',
    ]);
    expect(skipped).toEqual([]);
    teardown();
  });

  it('expands ./-prefixed globs like their bare form', () => {
    setup(['./packages/*']);
    write('packages/good', { name: '@x/good' });
    const { packages } = readWorkspacePackages(root);
    expect(packages.map((p) => p.dir)).toEqual(['packages/good']);
    teardown();
  });

  it('includes a SYMLINKED member — npm links it as a workspace all the same', () => {
    // Dirent.isDirectory() is false for a symlink, but npm records the member
    // ({resolved, link: true}) and links its dependencies — dropping it would
    // be a dependent the graph cannot see.
    setup(['packages/*']);
    write('packages/core', { name: '@x/core' });
    mkdirSync(join(root, 'shared', 'linked-pkg'), { recursive: true });
    write('shared/linked-pkg', {
      name: '@x/linked',
      dependencies: { '@x/core': '*' },
    });
    symlinkSync(
      join(root, 'shared', 'linked-pkg'),
      join(root, 'packages', 'linked'),
    );
    const { packages } = readWorkspacePackages(root);
    const linked = packages.find((p) => p.dir === 'packages/linked');
    expect(linked?.name).toBe('@x/linked');
    expect(linked?.deps).toEqual(['@x/core']);
    teardown();
  });
});

describe('scriptFansOut', () => {
  it('detects --workspaces and the -ws/--ws shorthands', () => {
    for (const script of [
      'npm run test --workspaces --if-present',
      'npm test -ws',
      'npm test --ws',
      'npm run build --workspaces',
    ]) {
      expect(scriptFansOut(script)).toBe(true);
    }
  });

  it('does not fire on -w/--workspace (singular), an explicit opt-out, or a plain suite', () => {
    for (const script of [
      'vitest',
      'npm test --workspace=packages/cli',
      'npm test -w packages/cli',
      'vitest run --workspaces=false',
    ]) {
      expect(scriptFansOut(script)).toBe(false);
    }
  });

  it('is false for a non-string script', () => {
    expect(scriptFansOut(undefined)).toBe(false);
    expect(scriptFansOut(42)).toBe(false);
    expect(scriptFansOut(null)).toBe(false);
  });

  it("detects pnpm's -r/--recursive, and flags that end at a quote", () => {
    for (const script of [
      'pnpm -r run build',
      'corepack pnpm -r ${filter} run build',
      'pnpm --recursive test',
      "execSync('npm run build --workspaces')",
    ]) {
      expect(scriptFansOut(script)).toBe(true);
    }
    for (const script of [
      'pnpm run build',
      'pnpm --filter @x/core run build',
      'pnpm exec mocha -r ts-node/register',
      'rm -r dist',
      "execSync('vitest run --workspaces=false')",
      // The flag as data, not as an argument a command is given.
      "if (process.argv.includes('--workspaces')) fanOut()",
    ]) {
      expect(scriptFansOut(script)).toBe(false);
    }
  });
});

describe('chainsCommands', () => {
  it('sees every way a script runs a second command', () => {
    for (const script of [
      'pnpm -r run build && node scripts/gen.js',
      'pnpm -r run build || true',
      'pnpm -r run build; node scripts/gen.js',
      'pnpm -r run build | tee build.log',
      'pnpm -r run build & wait',
      'pnpm -r run build\nnode scripts/gen.js',
    ]) {
      expect(chainsCommands(script)).toBe(true);
    }
    for (const script of ['pnpm -r run build', 'node scripts/build.js ', '']) {
      expect(chainsCommands(script)).toBe(false);
    }
  });
});

describe('rootBuildFanOutScript', () => {
  const withRoot = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };

  it('names the local build script a `node <file>` hands off to when it fans out', () => {
    // This repo's own root build: the fan-out lives in scripts/build.js,
    // between a license header and comments of its own.
    const root = withRoot({
      'scripts/build.js': [
        '/**',
        ' * @license',
        ' */',
        '// build all workspaces/packages in dependency order',
        "execSync(`corepack pnpm -r ${filter} run build`, { stdio: 'inherit' });",
        "execSync('node scripts/generate-settings-schema.ts'); // root's own",
      ].join('\n'),
    });
    expect(
      rootBuildFanOutScript(
        root,
        'cross-env NODE_OPTIONS="--max-old-space-size=6144" node scripts/build.js',
      ),
    ).toBe('scripts/build.js');
    rmSync(root, { recursive: true, force: true });
  });

  it("is undefined for a build script that compiles the root's own sources", () => {
    const root = withRoot({
      'scripts/build.js': "execSync('tsc -p tsconfig.json');",
    });
    expect(
      rootBuildFanOutScript(root, 'node scripts/build.js'),
    ).toBeUndefined();
    expect(rootBuildFanOutScript(root, 'tsc -p .')).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not count a fan-out that only a comment mentions', () => {
    const root = withRoot({
      'scripts/line.js': [
        '// was: pnpm -r run build — too slow',
        "execSync('tsc -p tsconfig.json');",
      ].join('\n'),
      'scripts/block.js': [
        '/* not `npm run build --workspaces`: one package only */',
        "execSync('tsc -p tsconfig.json');",
      ].join('\n'),
      'scripts/url.js':
        "fetch('https://example.com/x'); execSync('pnpm -r run build');",
      // Flush against the code, with no space before the `//`.
      'scripts/flush.js':
        "execSync('tsc -p tsconfig.json');// pnpm -r run build",
    });
    expect(rootBuildFanOutScript(root, 'node scripts/line.js')).toBeUndefined();
    expect(
      rootBuildFanOutScript(root, 'node scripts/flush.js'),
    ).toBeUndefined();
    expect(
      rootBuildFanOutScript(root, 'node scripts/block.js'),
    ).toBeUndefined();
    // A `//` that is not a comment leaves the line alone.
    expect(rootBuildFanOutScript(root, 'node scripts/url.js')).toBe(
      'scripts/url.js',
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("steps over node's flags, a preload's value included, to the script itself", () => {
    const root = withRoot({
      'scripts/build.js': "execSync('corepack pnpm -r run build');",
      'hooks.js': "execSync('corepack pnpm -r run build');",
    });
    for (const build of [
      'node --max-old-space-size=6144 scripts/build.js',
      'node --import tsx/esm scripts/build.js',
      // The preload fans out too, and is still not the script the build runs.
      'node --require ./hooks.js scripts/build.js',
      'node -r ./hooks.js scripts/build.js',
    ]) {
      expect(rootBuildFanOutScript(root, build)).toBe('scripts/build.js');
    }
    expect(
      rootBuildFanOutScript(root, `node -e "require('./hooks.js')"`),
    ).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('sees a fan-out between two globs, whose `/*` and `*/` are not a comment', () => {
    const root = withRoot({
      'scripts/build.js': [
        "const dirs = globSync('packages/*/src');",
        "execSync('pnpm -r run build');",
        "const files = globSync('scripts/**/*.js');",
      ].join('\n'),
    });
    expect(rootBuildFanOutScript(root, 'node scripts/build.js')).toBe(
      'scripts/build.js',
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('reads nothing outside the root, and treats an unreadable script as no fan-out', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ws-'));
    const root = join(parent, 'repo');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(parent, 'outside.js'), "execSync('pnpm -r run build');");
    expect(rootBuildFanOutScript(root, 'node ../outside.js')).toBeUndefined();
    expect(
      rootBuildFanOutScript(root, `node ${join(parent, 'outside.js')}`),
    ).toBeUndefined();
    // A link whose own path stays inside the root, to a file that does not.
    symlinkSync(join(parent, 'outside.js'), join(root, 'scripts', 'link.js'));
    expect(rootBuildFanOutScript(root, 'node scripts/link.js')).toBeUndefined();
    expect(
      rootBuildFanOutScript(root, 'node scripts/missing.js'),
    ).toBeUndefined();
    expect(rootBuildFanOutScript(root, undefined)).toBeUndefined();
    rmSync(parent, { recursive: true, force: true });
  });

  it("follows a link that stays inside the root, and reads no file of more than a script's size", () => {
    const root = withRoot({
      'tools/build.js': "execSync('pnpm -r run build');",
      // The fan-out is at the start, so only the size can turn it away.
      'scripts/big.js':
        "execSync('pnpm -r run build');\n" + '//'.repeat(600 * 1024),
    });
    symlinkSync(join(root, 'tools', 'build.js'), join(root, 'build.js'));
    expect(rootBuildFanOutScript(root, 'node build.js')).toBe('build.js');
    expect(rootBuildFanOutScript(root, 'node scripts/big.js')).toBeUndefined();
    // A directory is not a script.
    mkdirSync(join(root, 'dir.js'));
    expect(rootBuildFanOutScript(root, 'node dir.js')).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('counts only a command the script runs, not text it prints or tests for', () => {
    const root = withRoot({
      'scripts/log.js': [
        "console.error('if this fails, run pnpm -r run build by hand');",
        "execSync('tsc -b');",
      ].join('\n'),
      // A quote inside a regex literal throws the comment pass off, so the
      // comment after it survives; it still runs nothing.
      'scripts/regex.js': [
        `const q = src.replace(/'/g, '"'); // old: pnpm -r run build`,
        "execSync('tsc -b');",
      ].join('\n'),
      'scripts/flag.js':
        "if (process.argv.includes('--workspaces')) execSync('tsc -b');",
      // An argv split out of the command is not read: the build runs as
      // written.
      'scripts/argv.js': "spawnSync('pnpm', ['-r', 'run', 'build']);",
      'scripts/spawn.js':
        "spawnSync('npm run build --workspaces', { shell: true });",
    });
    for (const file of ['log', 'regex', 'flag', 'argv']) {
      expect(
        rootBuildFanOutScript(root, `node scripts/${file}.js`),
      ).toBeUndefined();
    }
    expect(rootBuildFanOutScript(root, 'node scripts/spawn.js')).toBe(
      'scripts/spawn.js',
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a TypeScript hand-off, run by node or tsx, past a flag whose value is a path', () => {
    const root = withRoot({
      'scripts/build.ts': "execSync('pnpm -r run build');",
      'scripts/build.js': "execSync('pnpm -r run build');",
    });
    expect(rootBuildFanOutScript(root, 'node scripts/build.ts')).toBe(
      'scripts/build.ts',
    );
    expect(rootBuildFanOutScript(root, 'tsx scripts/build.ts')).toBe(
      'scripts/build.ts',
    );
    expect(
      rootBuildFanOutScript(
        root,
        'node --redirect-warnings warn.log scripts/build.js',
      ),
    ).toBe('scripts/build.js');
    // A second line is a second command, with its own runner.
    expect(
      rootBuildFanOutScript(
        root,
        'node scripts/setup.js\nnode scripts/build.js',
      ),
    ).toBe('scripts/build.js');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('declaredBuildHeapMb', () => {
  const rootWithBuild = (build: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', scripts: { build } }),
    );
    return root;
  };

  it("reads the heap the root's build script declares", () => {
    const root = rootWithBuild(
      'cross-env NODE_OPTIONS="--max-old-space-size=6144" node scripts/build.js',
    );
    expect(declaredBuildHeapMb(root)).toBe(6144);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads it only from a NODE_OPTIONS assignment, which is what reaches the compilers', () => {
    for (const [build, mb] of [
      [
        "NODE_OPTIONS='--enable-source-maps --max-old-space-size=8192' tsc -b",
        8192,
      ],
      ['NODE_OPTIONS=--max-old-space-size=4096 tsc -b', 4096],
      // A child's argument, a usage string, a comment's worth of text, and a
      // flag that sizes only the build script's own process.
      ['node scripts/x.js --max-old-space-size=1024', undefined],
      ['echo "usage: build [--max-old-space-size=1024]" && tsc -b', undefined],
      ['node --max-old-space-size=2048 scripts/build.js', undefined],
    ] as const) {
      const root = rootWithBuild(build);
      expect(declaredBuildHeapMb(root)).toBe(mb);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes the largest of several declarations, in any spelling V8 accepts', () => {
    for (const [build, mb] of [
      [
        'NODE_OPTIONS=--max-old-space-size=1024 node a.js && NODE_OPTIONS=--max-old-space-size=8192 tsc -b',
        8192,
      ],
      ['NODE_OPTIONS=--max_old_space_size=3072 tsc -b', 3072],
      ['NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=6144" tsc -b', 6144],
    ] as const) {
      const root = rootWithBuild(build);
      expect(declaredBuildHeapMb(root)).toBe(mb);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is undefined when the root build declares no heap, or there is no root build', () => {
    const root = rootWithBuild('tsc --build');
    expect(declaredBuildHeapMb(root)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
    const empty = mkdtempSync(join(tmpdir(), 'ws-'));
    expect(declaredBuildHeapMb(empty)).toBeUndefined();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('hasUnmodeledWorkspaceGlob', () => {
  it('is false for the shapes the walker models — literals and a trailing /*', () => {
    expect(hasUnmodeledWorkspaceGlob(GLOBS)).toBe(false);
    expect(hasUnmodeledWorkspaceGlob(['packages/*', 'apps/web'])).toBe(false);
    expect(hasUnmodeledWorkspaceGlob(['!packages/desktop'])).toBe(false);
  });

  it('is true for `**`, an inner `*`, or a `foo-*` prefix the walker cannot model', () => {
    // A diff inside these resolves to an empty affected set, which would read as a
    // confident "nothing to build" — so build-test must fall back instead.
    expect(hasUnmodeledWorkspaceGlob(['packages/**'])).toBe(true);
    expect(hasUnmodeledWorkspaceGlob(['packages/*/lib'])).toBe(true);
    expect(hasUnmodeledWorkspaceGlob(['packages/foo-*'])).toBe(true);
    expect(hasUnmodeledWorkspaceGlob(['packages/*', 'apps/**'])).toBe(true);
  });
});

describe('affectedWorkspaces', () => {
  it('dedupes and sorts the workspaces a change set touches', () => {
    expect(
      affectedWorkspaces(
        [
          'packages/cli/src/a.ts',
          'packages/cli/src/b.ts',
          'packages/core/src/c.ts',
          'README.md',
        ],
        GLOBS,
      ),
    ).toEqual(['packages/cli', 'packages/core']);
  });

  it('is empty for a docs-only diff — which is a complete answer, not a skip', () => {
    expect(affectedWorkspaces(['README.md', 'docs/a.md'], GLOBS)).toEqual([]);
  });
});

// core <- bridge <- leaf ; core <- other ; templates (an island, until something
// turns out to need it)
const PKGS: WorkspacePackage[] = [
  {
    dir: 'packages/core',
    name: '@x/core',
    scripts: ['build', 'test'],
    deps: [],
  },
  {
    dir: 'packages/bridge',
    name: '@x/bridge',
    scripts: ['build', 'test'],
    deps: ['@x/core'],
  },
  {
    dir: 'packages/leaf',
    name: '@x/leaf',
    scripts: ['build', 'test'],
    deps: ['@x/bridge'],
  },
  {
    dir: 'packages/other',
    name: '@x/other',
    scripts: ['build', 'test'],
    deps: ['@x/core'],
  },
  {
    dir: 'packages/templates',
    name: '@x/templates',
    scripts: ['build'],
    deps: [],
  },
];

describe('dependencyClosure', () => {
  it('takes what a package depends on, and none of its consumers', () => {
    expect(dependencyClosure(['packages/bridge'], PKGS)).toEqual([
      'packages/bridge',
      'packages/core',
    ]);
    // `buildSetFor` of the same package adds its consumer.
    expect(buildSetFor(['packages/bridge'], PKGS)).toContain('packages/leaf');
  });
});

describe('buildSetFor', () => {
  it('orders dependencies before the package that needs them', () => {
    const set = buildSetFor(['packages/leaf'], PKGS);
    expect(set.indexOf('packages/core')).toBeLessThan(
      set.indexOf('packages/bridge'),
    );
    expect(set.indexOf('packages/bridge')).toBeLessThan(
      set.indexOf('packages/leaf'),
    );
  });

  it('does not build the siblings of a leaf change', () => {
    // The whole point: `other` cannot have been broken by a change to `leaf`.
    expect(buildSetFor(['packages/leaf'], PKGS)).not.toContain(
      'packages/other',
    );
  });

  it('builds the DEPENDENTS of a changed package — a break surfaces at their compile', () => {
    const set = buildSetFor(['packages/core'], PKGS);
    expect(set).toContain('packages/bridge');
    expect(set).toContain('packages/leaf');
    expect(set).toContain('packages/other');
  });

  it('treats `alsoBuild` as a dependency, NOT as changed code', () => {
    // The bug this guards: feeding a compiler-requested package back in as
    // `affected` makes its consumers "dependents of a changed package". On PR
    // #6866, widening with web-templates that way took the build set from 6
    // packages to 15 and built the CLI, which the PR does not touch.
    const asDependency = buildSetFor(['packages/leaf'], PKGS, [
      'packages/core',
    ]);
    expect(asDependency).not.toContain('packages/other');

    const asChangedCode = buildSetFor(['packages/leaf', 'packages/core'], PKGS);
    expect(asChangedCode).toContain('packages/other');
  });

  it('puts `alsoBuild` FIRST — no declared edge can order it', () => {
    // The compiler asked for `templates` precisely because nothing declares an
    // edge to it. The topological sort therefore has nothing to order it by and
    // falls back on the alphabet, which on PR #6866 placed it AFTER the package
    // that needed it: the retry rebuilt the same failure, and a widening that had
    // correctly diagnosed the gap could not close it.
    const set = buildSetFor(['packages/leaf'], PKGS, ['packages/templates']);
    expect(set[0]).toBe('packages/templates');
    expect(set.indexOf('packages/templates')).toBeLessThan(
      set.indexOf('packages/leaf'),
    );
  });

  it('terminates on a dependency cycle without dropping a package', () => {
    const cyclic: WorkspacePackage[] = [
      { dir: 'packages/a', name: '@x/a', scripts: ['build'], deps: ['@x/b'] },
      { dir: 'packages/b', name: '@x/b', scripts: ['build'], deps: ['@x/a'] },
    ];
    const set = buildSetFor(['packages/a'], cyclic);
    expect(new Set(set)).toEqual(new Set(['packages/a', 'packages/b']));
  });

  it('ignores an affected dir that is not a workspace', () => {
    expect(buildSetFor(['docs'], PKGS)).toEqual([]);
  });

  it('reads a dependency on a name the root shares with a member as one on the member', () => {
    // This repo's shape: the root and packages/cli are both
    // `@qwen-code/qwen-code`, and the IDE companion depends on that name.
    const root: WorkspacePackage = {
      dir: '.',
      name: '@x/cli',
      scripts: ['build'],
      deps: [],
    };
    const cli: WorkspacePackage = {
      dir: 'packages/cli',
      name: '@x/cli',
      scripts: ['build'],
      deps: [],
    };
    const ide: WorkspacePackage = {
      dir: 'packages/ide',
      name: '@x/ide',
      scripts: ['build'],
      deps: ['@x/cli'],
    };
    for (const graph of [
      [root, cli, ide],
      [cli, ide, root],
    ]) {
      expect(reverseDependencyClosure(['.'], graph)).toEqual(['.']);
      expect(reverseDependencyClosure(['packages/cli'], graph)).toEqual([
        'packages/cli',
        'packages/ide',
      ]);
    }
  });
});
