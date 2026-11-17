/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Incremental `prepare` build for CI.
//
//   key [--at <commit>]  print a hash of every workspace's build inputs, in
//                 the worktree or, with --at, in a commit's tree (the cache key
//                 a pull request's base saved under)
//   build <dir>   build the tree, reusing what <dir> holds from an earlier
//                 run: only workspaces whose inputs changed rebuild
//   pack <dir>    store the built tree and its input hashes in <dir>
//   paths         print the built paths, NUL-separated, for `tar -T -`
//   host-assets   after unpacking a tree built on another host, recopy the
//                 bundle's platform-specific assets for this host
//
// A workspace's hash covers its tracked files (tests excluded: no build
// reads them), the global inputs every build shares, and the hashes of the
// workspaces it depends on, so a change rebuilds its dependents too.

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The archive step in ci.yml shares `builtPaths()` with `pack` through the
// `paths` mode, so the tree the shards unpack is defined once. The override
// exists so the mode tests can point the script at a fixture repository.
const root = resolve(
  process.env.CI_BUILD_CACHE_ROOT ?? join(import.meta.dirname, '..'),
);
const TREE = 'tree.tgz';
const HASHES = 'hashes.json';

// Not built by the root build, as in scripts/build.js.
const UNBUILT = new Set(['@qwen-code/mobile-mcp']);

export const isTestFile = (file) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /(^|\/)(__tests__|__snapshots__)\//.test(file);

// Root-level files and the shared build scripts every workspace build reads.
export const isGlobalInput = (file) =>
  !file.includes('/') ||
  file.startsWith('patches/') ||
  (file.startsWith('scripts/') && !file.startsWith('scripts/tests/'));

/**
 * @param {{name: string, dir: string, deps: string[]}[]} workspaces
 * @param {{path: string, blob: string}[]} files tracked files and blob ids
 * @returns {Record<string, string>} workspace name -> input hash
 */
export function hashWorkspaces(workspaces, files) {
  const global = createHash('sha256');
  const own = new Map(workspaces.map((w) => [w.name, createHash('sha256')]));
  // Longest directory first, so a nested workspace claims its own files.
  const byDir = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);
  for (const { path, blob } of files) {
    if (isTestFile(path)) continue;
    const owner = byDir.find((w) => path.startsWith(`${w.dir}/`));
    if (owner) own.get(owner.name).update(`${path}\0${blob}\n`);
    else if (isGlobalInput(path)) global.update(`${path}\0${blob}\n`);
  }
  const globalHash = global.digest('hex');
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const hashes = {};
  const visit = (name) => {
    if (hashes[name]) return hashes[name];
    const hash = createHash('sha256')
      .update(globalHash)
      .update(own.get(name).copy().digest('hex'));
    for (const dep of [...byName.get(name).deps].sort()) {
      if (byName.has(dep)) hash.update(`${dep}\0${visit(dep)}\n`);
    }
    return (hashes[name] = hash.digest('hex'));
  };
  for (const { name } of workspaces) visit(name);
  return hashes;
}

/** Workspaces whose hash differs from the stored one, or has none. */
export const changedWorkspaces = (current, stored) =>
  Object.keys(current).filter((name) => current[name] !== stored?.[name]);

function listWorkspaces() {
  const listed = JSON.parse(
    execSync('corepack pnpm ls -r --depth -1 --json', {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  return listed
    .filter((w) => resolve(w.path) !== root && !UNBUILT.has(w.name))
    .map((w) => {
      const manifest = JSON.parse(
        readFileSync(join(w.path, 'package.json'), 'utf8'),
      );
      const deps = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      });
      const dir = w.path
        .slice(root.length + 1)
        .split('\\')
        .join('/');
      return { name: w.name, dir, deps };
    });
}

// `ls-files -s` prints `<mode> <blob> <stage>`, `ls-tree -r` prints
// `<mode> <type> <blob>`: the same blob ids, so a commit's tree hashes exactly
// as the worktree did when that commit was checked out.
function trackedFiles(commit) {
  const [args, blobField] = commit
    ? [['ls-tree', '-r', '-z', '--full-tree', commit], 2]
    : [['ls-files', '-s', '-z'], 1];
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      return { path, blob: meta.split(' ')[blobField] };
    });
}

// The build's outputs: ignored, untracked paths outside node_modules.
function builtPaths(dirs = []) {
  return execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--',
      ...dirs,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter((path) => path && !/(^|\/)node_modules\/$/.test(path));
}

const run = (command) => execSync(command, { cwd: root, stdio: 'inherit' });

/** One key for the whole tree, from the per-workspace hashes. */
export function combinedKey(hashes) {
  const combined = createHash('sha256');
  for (const name of Object.keys(hashes).sort()) {
    combined.update(`${name}\0${hashes[name]}\n`);
  }
  return combined.digest('hex');
}

export async function main(argv) {
  const [mode, dir] = argv;
  if (mode === 'key') {
    if (argv[1] !== undefined && (argv[1] !== '--at' || !argv[2])) {
      throw new Error('usage: ci-build-cache.mjs key [--at <commit>]');
    }
    // The workspace graph comes from the worktree either way; a commit whose
    // graph differed changed a package.json, which its own hash covers.
    console.log(
      combinedKey(hashWorkspaces(listWorkspaces(), trackedFiles(argv[2]))),
    );
    return;
  }
  if (mode === 'host-assets') {
    // Every built path is JavaScript except the renderer's native library,
    // which the bundle copies for the platform it was installed on.
    if (existsSync(join(root, 'dist', 'cli.js'))) {
      const { copyOpenTuiAssets } = await import('./copy_bundle_assets.js');
      copyOpenTuiAssets({ root, distDir: join(root, 'dist') });
    }
    return;
  }
  if (mode === 'paths') {
    process.stdout.write(
      builtPaths()
        .map((path) => `${path}\0`)
        .join(''),
    );
    return;
  }
  if (!dir || (mode !== 'build' && mode !== 'pack')) {
    throw new Error(
      'usage: ci-build-cache.mjs key [--at <commit>] | build <dir> | pack <dir> | paths | host-assets',
    );
  }
  const cacheDir = resolve(dir);
  const workspaces = listWorkspaces();
  const hashes = hashWorkspaces(workspaces, trackedFiles());

  if (mode === 'pack') {
    mkdirSync(cacheDir, { recursive: true });
    const paths = builtPaths();
    execFileSync('tar', ['-czf', join(cacheDir, TREE), '--null', '-T', '-'], {
      cwd: root,
      input: paths.join('\0'),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    writeFileSync(join(cacheDir, HASHES), JSON.stringify(hashes, null, 2));
    return;
  }

  // `scripts/build.js` guards the ink patch its typecheck depends on, but the
  // cached branch below deliberately does not run that file — it rebuilds only
  // the changed workspaces. Without this, the same missing
  // `frame-controller.d.ts` self-heals or explains itself on a cache miss and
  // surfaces as ~50 tsc errors inside ink's declarations on a hit.
  run('node scripts/build.js --preflight');

  const hashFile = join(cacheDir, HASHES);
  if (!existsSync(hashFile) || !existsSync(join(cacheDir, TREE))) {
    console.log('No cached build; building every workspace.');
    run('npm run build');
    run('npm run bundle');
    return;
  }
  run(`tar -xzf "${join(cacheDir, TREE)}"`);
  const changed = changedWorkspaces(
    hashes,
    JSON.parse(readFileSync(hashFile, 'utf8')),
  );
  console.log(
    `Cached build restored; ${changed.length} of ${workspaces.length} workspaces changed${changed.length ? `: ${changed.join(', ')}` : ''}.`,
  );
  // Remove a changed workspace's stale outputs, then rebuild it in
  // dependency order; the rest keep the restored outputs.
  const dirs = workspaces
    .filter((w) => changed.includes(w.name))
    .map((w) => w.dir);
  const stale = dirs.length ? builtPaths(dirs) : [];
  if (stale.length) {
    execFileSync('rm', ['-rf', '--', ...stale], { cwd: root });
  }
  run('npm run generate');
  if (changed.length) {
    // By directory: the repository root shares the CLI's package name, and
    // selecting the root runs scripts/build.js, every workspace again.
    const filters = dirs.map((dir) => `--filter "{./${dir}}"`).join(' ');
    // The heap `npm run build` gives the same pnpm run.
    execSync(`corepack pnpm -r ${filters} run build`, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' },
    });
  }
  run('node --import tsx/esm scripts/generate-settings-schema.ts');
  run('npm run bundle');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}
