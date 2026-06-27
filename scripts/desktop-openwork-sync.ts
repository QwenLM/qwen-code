#!/usr/bin/env bun

import { spawn } from 'bun';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type SyncMode = 'auto' | 'export' | 'import';
type MigrationMode = Exclude<SyncMode, 'auto'>;

type RunOptions = {
  allowFailure?: boolean;
  capture?: boolean;
};

type Options = {
  mode: SyncMode;
  openworkDir: string;
  openworkRef: string;
  qwenBase: string;
  branch?: string;
  overlayPaths: string[];
  sourceBase?: string;
  allowDirtySource: boolean;
};

const desktopPrefix = 'packages/desktop';
const repoRoot = resolve(import.meta.dir, '..');

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '');
}

function normalizeGitPath(value: string): string {
  const path = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
  if (!path || path === '.') {
    throw new Error('Overlay path cannot be empty.');
  }
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`Overlay path must be repository-relative: ${value}`);
  }
  return path.replace(/\/+$/, '');
}

function parsePathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map(normalizeGitPath);
}

function parseMode(value: string): SyncMode {
  if (value === 'auto' || value === 'export' || value === 'import') {
    return value;
  }
  throw new Error(`Invalid mode: ${value}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultBranch(mode: Exclude<SyncMode, 'auto'>): string {
  const verb = mode === 'export' ? 'sync' : 'import';
  return `chore/${verb}-openwork-desktop-${timestamp()}`;
}

function printHelp(): void {
  console.log(`Usage: bun run desktop-openwork-sync --openwork-dir /path/to/openwork [options]

Commit-migrate changes between qwen-code packages/desktop and OpenWork.

Modes:
  --mode auto      Refuse if direction is ambiguous
  --mode export    Apply qwen-code packages/desktop commits to OpenWork
  --mode import    Apply OpenWork commits to qwen-code packages/desktop

Options:
  --openwork-dir <path>      Path to a clean OpenWork checkout
  --openwork-ref <ref>       OpenWork ref to read or branch from (default: main)
  --base <ref>               Alias for --openwork-ref
  --qwen-base <ref>          qwen-code base for import branches (default: HEAD)
  --source-base <ref>        Source-side base ref for the commit range
  --branch <name>            Target branch name in the repo being changed
  --overlay <path[,path]>    Do not migrate these source paths (repeatable)
  --allow-dirty-source       Allow uncommitted packages/desktop changes to be omitted during export
  --no-abort-on-conflict     Accepted for compatibility; conflicts are left for resolution
  -h, --help                 Show this help

Environment:
  OPENWORK_DIR
  OPENWORK_REF
  OPENWORK_BASE_REF          Alias for OPENWORK_REF
  QWEN_BASE_REF
  OPENWORK_SYNC_BRANCH
  OPENWORK_SYNC_SOURCE_BASE
  OPENWORK_OVERLAY_PATHS     Comma-separated overlays (default: README.md)
`);
}

function parseArgs(argv: string[]): Options {
  const overlayPaths = new Set(
    parsePathList(process.env.OPENWORK_OVERLAY_PATHS || 'README.md'),
  );
  let mode: SyncMode = 'auto';
  let openworkDir = process.env.OPENWORK_DIR?.trim();
  let openworkRef =
    process.env.OPENWORK_REF?.trim() ||
    process.env.OPENWORK_BASE_REF?.trim() ||
    'main';
  let qwenBase = process.env.QWEN_BASE_REF?.trim() || 'HEAD';
  let branch = process.env.OPENWORK_SYNC_BRANCH?.trim();
  let sourceBase = process.env.OPENWORK_SYNC_SOURCE_BASE?.trim();
  let allowDirtySource = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    switch (arg) {
      case '--mode':
        mode = parseMode(next());
        break;
      case '--openwork-dir':
        openworkDir = next();
        break;
      case '--openwork-ref':
      case '--base':
        openworkRef = next();
        break;
      case '--qwen-base':
        qwenBase = next();
        break;
      case '--source-base':
        sourceBase = next();
        break;
      case '--branch':
        branch = next();
        break;
      case '--overlay':
        for (const path of parsePathList(next())) {
          overlayPaths.add(path);
        }
        break;
      case '--allow-dirty-source':
        allowDirtySource = true;
        break;
      case '--no-abort-on-conflict':
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!openworkDir) {
    throw new Error(
      'Missing OpenWork checkout. Pass --openwork-dir or set OPENWORK_DIR.',
    );
  }

  return {
    mode,
    openworkDir: resolve(openworkDir),
    openworkRef,
    qwenBase,
    branch,
    overlayPaths: [...overlayPaths],
    sourceBase,
    allowDirtySource,
  };
}

async function run(
  cmd: string[],
  cwd: string,
  options: RunOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = spawn({
    cmd,
    cwd,
    stdin: 'inherit',
    stdout: options.capture ? 'pipe' : 'inherit',
    stderr: options.capture ? 'pipe' : 'inherit',
  });

  const stdoutPromise =
    options.capture && proc.stdout
      ? new Response(proc.stdout).text()
      : Promise.resolve('');
  const stderrPromise =
    options.capture && proc.stderr
      ? new Response(proc.stderr).text()
      : Promise.resolve('');
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited,
  ]);

  if (exitCode !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `${cmd.join(' ')} failed with exit code ${exitCode}${
        detail ? `\n${detail}` : ''
      }`,
    );
  }

  return { exitCode, stdout, stderr };
}

async function git(
  cwd: string,
  args: string[],
  options: RunOptions = {},
): ReturnType<typeof run> {
  return run(['git', ...args], cwd, options);
}

async function getRepoRoot(path: string): Promise<string> {
  const result = await git(path, ['rev-parse', '--show-toplevel'], {
    capture: true,
  });
  return result.stdout.trim();
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const result = await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], {
    capture: true,
  });
  return result.stdout.trim();
}

async function objectExists(cwd: string, ref: string): Promise<boolean> {
  const result = await git(cwd, ['cat-file', '-e', `${ref}^{commit}`], {
    allowFailure: true,
    capture: true,
  });
  return result.exitCode === 0;
}

async function localBranchExists(
  cwd: string,
  branch: string,
): Promise<boolean> {
  const result = await git(
    cwd,
    ['show-ref', '--verify', `refs/heads/${branch}`],
    { allowFailure: true, capture: true },
  );
  return result.exitCode === 0;
}

async function switchTargetBranch(
  cwd: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  if (await localBranchExists(cwd, branch)) {
    await git(cwd, ['switch', branch]);
    return;
  }

  await git(cwd, ['switch', '-c', branch, baseRef]);
}

async function ensureCleanWorktree(
  cwd: string,
  label: string,
  paths: string[] = [],
): Promise<void> {
  const args = ['status', '--porcelain'];
  if (paths.length > 0) {
    args.push('--', ...paths);
  }

  const status = await git(cwd, args, { capture: true });
  if (status.stdout.trim()) {
    throw new Error(
      `${label} must be clean before syncing:\n${status.stdout.trim()}`,
    );
  }
}

async function ensureCommittedDesktopSource(
  allowDirtySource: boolean,
): Promise<void> {
  if (allowDirtySource) return;
  await ensureCleanWorktree(repoRoot, desktopPrefix, [desktopPrefix]);
}

async function findLatestTrailer(
  cwd: string,
  ref: string,
  trailer: string,
): Promise<string | undefined> {
  const result = await git(cwd, ['log', '--format=%B%x00', ref], {
    capture: true,
  });
  const pattern = new RegExp(
    `^${escapeRegExp(trailer)}:\\s*([^\\s]+)\\s*$`,
    'im',
  );
  return result.stdout.match(pattern)?.[1];
}

async function getCommitBody(cwd: string, commit: string): Promise<string> {
  const result = await git(cwd, ['log', '-n', '1', '--format=%B', commit], {
    capture: true,
  });
  return result.stdout;
}

function findTrailer(body: string, trailer: string): string | undefined {
  const pattern = new RegExp(
    `^${escapeRegExp(trailer)}:\\s*([^\\s]+)\\s*$`,
    'im',
  );
  return body.match(pattern)?.[1];
}

async function findTrailerValues(
  cwd: string,
  ref: string,
  trailer: string,
): Promise<Set<string>> {
  const result = await git(cwd, ['log', '--format=%B%x00', ref], {
    capture: true,
  });
  const pattern = new RegExp(
    `^${escapeRegExp(trailer)}:\\s*([^\\s]+)\\s*$`,
    'gim',
  );
  const values = new Set<string>();
  for (const match of result.stdout.matchAll(pattern)) {
    values.add(match[1]);
  }
  return values;
}

async function resolveSourceBase(
  sourceRepo: string,
  explicitBase: string | undefined,
  targetRepo: string,
  targetRef: string,
  trailer: string,
): Promise<string> {
  const base =
    explicitBase ?? (await findLatestTrailer(targetRepo, targetRef, trailer));
  if (!base) {
    throw new Error(
      `Missing source base. Pass --source-base or create a prior sync commit ` +
        `with a ${trailer} trailer.`,
    );
  }
  if (!(await objectExists(sourceRepo, base))) {
    throw new Error(`Source base does not exist in source repo: ${base}`);
  }
  return revParse(sourceRepo, base);
}

function exportPathspecs(overlayPaths: string[]): string[] {
  return [
    desktopPrefix,
    ...overlayPaths.map((path) => `:!${desktopPrefix}/${path}`),
  ];
}

function importPathspecs(overlayPaths: string[]): string[] {
  return ['.', ...overlayPaths.map((path) => `:!${path}`)];
}

async function createExportPatch(
  base: string,
  source: string,
  overlayPaths: string[],
): Promise<string> {
  const result = await git(
    repoRoot,
    [
      'diff',
      '--binary',
      '--full-index',
      `--relative=${desktopPrefix}`,
      base,
      source,
      '--',
      ...exportPathspecs(overlayPaths),
    ],
    { capture: true },
  );
  return result.stdout;
}

async function createImportPatch(
  openworkRoot: string,
  base: string,
  source: string,
  overlayPaths: string[],
): Promise<string> {
  const result = await git(
    openworkRoot,
    [
      'diff',
      '--binary',
      '--full-index',
      `--src-prefix=a/${desktopPrefix}/`,
      `--dst-prefix=b/${desktopPrefix}/`,
      base,
      source,
      '--',
      ...importPathspecs(overlayPaths),
    ],
    { capture: true },
  );
  return result.stdout;
}

async function getSourceCommits(
  cwd: string,
  base: string,
  source: string,
  pathspecs: string[],
): Promise<string[]> {
  const result = await git(
    cwd,
    [
      'log',
      '--reverse',
      '--topo-order',
      '--format=%H',
      `${base}..${source}`,
      '--',
      ...pathspecs,
    ],
    { capture: true },
  );
  return result.stdout.split('\n').filter(Boolean);
}

async function getMergeIntroducedCommits(
  cwd: string,
  firstParent: string,
  mergeCommit: string,
  pathspecs: string[],
): Promise<string[]> {
  const result = await git(
    cwd,
    [
      'log',
      '--reverse',
      '--topo-order',
      '--no-merges',
      '--format=%H',
      `${firstParent}..${mergeCommit}`,
      '--',
      ...pathspecs,
    ],
    { capture: true },
  );
  return result.stdout.split('\n').filter(Boolean);
}

async function getParents(cwd: string, commit: string): Promise<string[]> {
  const result = await git(cwd, ['rev-list', '--parents', '-n', '1', commit], {
    capture: true,
  });
  const [, ...parents] = result.stdout.trim().split(/\s+/);
  return parents;
}

async function shouldSkipSyncedCommit(
  cwd: string,
  commit: string,
  mode: MigrationMode,
): Promise<string | undefined> {
  const body = await getCommitBody(cwd, commit);
  const syncMode = findTrailer(body, 'OpenWork-Sync-Mode');

  if (
    mode === 'import' &&
    (syncMode === 'export' || findTrailer(body, 'Qwen-Code-Commit'))
  ) {
    return 'already came from qwen-code';
  }

  if (
    mode === 'export' &&
    (syncMode === 'import' || findTrailer(body, 'OpenWork-Commit'))
  ) {
    return 'already came from OpenWork';
  }

  return undefined;
}

function targetAlreadySyncedCommit(
  commit: string,
  targetTrailer: string,
  targetSyncedCommits: Set<string>,
): string | undefined {
  if (targetSyncedCommits.has(commit)) {
    return `target already has ${targetTrailer}: ${commit}`;
  }

  return undefined;
}

async function ensureSimpleMergeCommit(params: {
  mode: MigrationMode;
  sourceRepo: string;
  commit: string;
  parents: string[];
  pathspecs: string[];
  handledCommits: Set<string>;
  targetSyncedCommits: Set<string>;
}): Promise<void> {
  const [firstParent, secondParent] = params.parents;
  if (!firstParent || !secondParent || params.parents.length !== 2) {
    throw new Error(`Cannot inspect octopus merge commit: ${params.commit}`);
  }

  const introducedCommits = await getMergeIntroducedCommits(
    params.sourceRepo,
    firstParent,
    params.commit,
    params.pathspecs,
  );
  const missingCommits: string[] = [];
  for (const commit of introducedCommits) {
    if (
      params.handledCommits.has(commit) ||
      params.targetSyncedCommits.has(commit) ||
      (await shouldSkipSyncedCommit(params.sourceRepo, commit, params.mode))
    ) {
      continue;
    }
    missingCommits.push(commit);
  }
  if (missingCommits.length > 0) {
    throw new Error(
      `Merge commit introduced unhandled commits: ${params.commit}\n` +
        missingCommits.map((commit) => `  ${commit}`).join('\n'),
    );
  }

  const mergeTree = await git(
    params.sourceRepo,
    ['merge-tree', '--write-tree', firstParent, secondParent],
    { allowFailure: true, capture: true },
  );
  if (mergeTree.exitCode !== 0) {
    throw new Error(
      `Merge commit requires manual resolution: ${params.commit}`,
    );
  }

  const tree = mergeTree.stdout.trim().split(/\s+/)[0];
  const diff = await git(
    params.sourceRepo,
    ['diff', '--quiet', tree, params.commit, '--', ...params.pathspecs],
    { allowFailure: true },
  );
  if (diff.exitCode === 0) return;
  if (diff.exitCode === 1) {
    throw new Error(
      `Merge commit has manual resolution changes: ${params.commit}`,
    );
  }

  throw new Error(`Unable to inspect merge commit: ${params.commit}`);
}

async function getCommitSubject(cwd: string, commit: string): Promise<string> {
  const result = await git(cwd, ['log', '-n', '1', '--format=%s', commit], {
    capture: true,
  });
  return result.stdout.trim();
}

async function applyPatch(cwd: string, patch: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'openwork-sync-'));
  const patchPath = join(dir, 'sync.patch');
  try {
    await writeFile(patchPath, patch);
    await git(cwd, ['apply', '-3', '--binary', patchPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function commitChanges(
  cwd: string,
  subject: string,
  trailers: string[],
): Promise<boolean> {
  await git(cwd, ['add', '-A']);
  const diff = await git(cwd, ['diff', '--cached', '--quiet'], {
    allowFailure: true,
  });

  if (diff.exitCode === 0) {
    console.log('Source patch produced no target changes; no commit created.');
    return false;
  }
  if (diff.exitCode !== 1) {
    throw new Error('Unable to inspect staged sync diff.');
  }

  await git(cwd, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    [subject, '', ...trailers].join('\n'),
  ]);
  return true;
}

async function migrateCommits(params: {
  mode: MigrationMode;
  sourceRepo: string;
  targetRepo: string;
  commits: string[];
  pathspecs: string[];
  createPatch: (parent: string, commit: string) => Promise<string>;
  trailers: (parent: string, commit: string) => string[];
}): Promise<number> {
  let count = 0;
  const handledCommits = new Set<string>();
  const targetTrailer =
    params.mode === 'import' ? 'OpenWork-Commit' : 'Qwen-Code-Commit';
  const targetSyncedCommits = await findTrailerValues(
    params.targetRepo,
    'HEAD',
    targetTrailer,
  );

  for (const commit of params.commits) {
    const parents = await getParents(params.sourceRepo, commit);
    const parent = parents[0];
    if (!parent) {
      throw new Error(`Cannot migrate root commit as a patch: ${commit}`);
    }

    const targetReason = targetAlreadySyncedCommit(
      commit,
      targetTrailer,
      targetSyncedCommits,
    );
    if (targetReason) {
      console.log(`Skipping ${commit.slice(0, 12)}; ${targetReason}.`);
      handledCommits.add(commit);
      continue;
    }

    const skipReason = await shouldSkipSyncedCommit(
      params.sourceRepo,
      commit,
      params.mode,
    );
    if (skipReason) {
      console.log(`Skipping ${commit.slice(0, 12)}; ${skipReason}.`);
      handledCommits.add(commit);
      continue;
    }

    if (parents.length > 1) {
      await ensureSimpleMergeCommit({
        mode: params.mode,
        sourceRepo: params.sourceRepo,
        commit,
        parents,
        pathspecs: params.pathspecs,
        handledCommits,
        targetSyncedCommits,
      });
      console.log(
        `Skipping merge ${commit.slice(0, 12)}; regular commits handled.`,
      );
      handledCommits.add(commit);
      continue;
    }

    const patch = await params.createPatch(parent, commit);
    if (!patch.trim()) {
      handledCommits.add(commit);
      continue;
    }

    console.log(`Applying ${commit.slice(0, 12)}...`);
    await applyPatch(params.targetRepo, patch);
    const subject = await getCommitSubject(params.sourceRepo, commit);
    if (
      await commitChanges(params.targetRepo, subject, [
        ...params.trailers(parent, commit),
      ])
    ) {
      count += 1;
    }
    handledCommits.add(commit);
  }

  return count;
}

async function runExport(options: Options): Promise<void> {
  const openworkRoot = await getRepoRoot(options.openworkDir);
  const branch = options.branch || defaultBranch('export');

  await ensureCleanWorktree(openworkRoot, 'OpenWork checkout');
  await ensureCommittedDesktopSource(options.allowDirtySource);

  const source = await revParse(repoRoot, 'HEAD');
  const base = await resolveSourceBase(
    repoRoot,
    options.sourceBase,
    openworkRoot,
    options.openworkRef,
    'Qwen-Code-Commit',
  );
  const pathspecs = exportPathspecs(options.overlayPaths);
  const commits = await getSourceCommits(repoRoot, base, source, pathspecs);
  if (commits.length === 0) {
    console.log('No qwen-code source changes to export.');
    return;
  }

  console.log(`Preparing ${branch} in ${openworkRoot}...`);
  await switchTargetBranch(openworkRoot, branch, options.openworkRef);
  const openworkBase = await revParse(openworkRoot, options.openworkRef);
  const count = await migrateCommits({
    mode: 'export',
    sourceRepo: repoRoot,
    targetRepo: openworkRoot,
    commits,
    pathspecs,
    createPatch: (parent, commit) =>
      createExportPatch(parent, commit, options.overlayPaths),
    trailers: (parent, commit) => [
      'OpenWork-Sync-Mode: export',
      `Qwen-Code-Base: ${parent}`,
      `Qwen-Code-Commit: ${commit}`,
      `OpenWork-Base: ${openworkBase}`,
    ],
  });
  if (count === 0) return;

  console.log(`Created ${branch} in ${openworkRoot} with ${count} commits.`);
  console.log(`Next: git -C ${openworkRoot} push -u origin ${branch}`);
}

async function runImport(options: Options): Promise<void> {
  const openworkRoot = await getRepoRoot(options.openworkDir);
  const branch = options.branch || defaultBranch('import');

  await ensureCleanWorktree(openworkRoot, 'OpenWork checkout');
  await ensureCleanWorktree(repoRoot, 'qwen-code checkout');

  const source = await revParse(openworkRoot, options.openworkRef);
  const base = await resolveSourceBase(
    openworkRoot,
    options.sourceBase,
    repoRoot,
    options.qwenBase,
    'OpenWork-Commit',
  );
  const pathspecs = importPathspecs(options.overlayPaths);
  const commits = await getSourceCommits(openworkRoot, base, source, pathspecs);
  if (commits.length === 0) {
    console.log('No OpenWork source changes to import.');
    return;
  }

  console.log(`Preparing ${branch} in ${repoRoot}...`);
  await switchTargetBranch(repoRoot, branch, options.qwenBase);
  const qwenBase = await revParse(repoRoot, options.qwenBase);
  const count = await migrateCommits({
    mode: 'import',
    sourceRepo: openworkRoot,
    targetRepo: repoRoot,
    commits,
    pathspecs,
    createPatch: (parent, commit) =>
      createImportPatch(openworkRoot, parent, commit, options.overlayPaths),
    trailers: (parent, commit) => [
      'OpenWork-Sync-Mode: import',
      `OpenWork-Base: ${parent}`,
      `OpenWork-Commit: ${commit}`,
      `Qwen-Code-Base: ${qwenBase}`,
    ],
  });
  if (count === 0) return;

  console.log(`Created ${branch} in ${repoRoot} with ${count} commits.`);
}

async function runAuto(): Promise<void> {
  throw new Error(
    'Auto mode is intentionally conservative. Use --mode export or --mode ' +
      'import so the receiving repository is explicit.',
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  switch (options.mode) {
    case 'auto':
      await runAuto();
      break;
    case 'export':
      await runExport(options);
      break;
    case 'import':
      await runImport(options);
      break;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
