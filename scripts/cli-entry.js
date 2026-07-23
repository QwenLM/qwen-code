#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production bin entry wrapper.
 *
 * For most commands: launches the bundled CLI with --expose-gc so that
 * global.gc() is available for the memory-pressure monitor's critical-tier
 * cleanup.
 *
 * For bootstrap fast paths: imports cli.js directly in-process, skipping the
 * spawnSync overhead. These paths do not need global.gc(); the normal
 * interactive path still relaunches with --expose-gc for the memory-pressure
 * monitor.
 */

const relaunchArgs = process.env['QWEN_CODE_RELAUNCH_ARGS'];
let cliArgs = process.argv.slice(2);
try {
  cliArgs = relaunchArgs ? JSON.parse(relaunchArgs) : cliArgs;
} catch {
  // Ignore stale or user-provided junk; normal argv is still usable.
}
delete process.env['QWEN_CODE_RELAUNCH_ARGS'];

function hasFlag(flag, alias) {
  for (const arg of cliArgs) {
    if (arg === '--') {
      return false;
    }
    if (arg === flag || arg === alias) {
      return true;
    }
  }
  return false;
}

function isInProcessFastPath() {
  const first = cliArgs[0];
  if (first === 'serve' || first === 'mcp') {
    return true;
  }
  if (first === undefined || first.startsWith('-')) {
    return hasFlag('--help', '-h') || hasFlag('--version', '-v');
  }
  return false;
}

const isTopLevelVersion =
  (cliArgs[0] === undefined || cliArgs[0].startsWith('-')) &&
  hasFlag('--version', '-v');

if (isTopLevelVersion && process.env['CLI_VERSION']) {
  process.stdout.write(`${process.env['CLI_VERSION']}\n`);
  process.exit(0);
}

const { existsSync, readFileSync, realpathSync, statSync } = await import(
  'node:fs'
);
const { createHash } = await import('node:crypto');
const { homedir, tmpdir } = await import('node:os');
const { parseEnv } = await import('node:util');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const { delimiter, dirname, join, parse, resolve, sep } = await import(
  'node:path'
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const currentEntryPath = realpathSync(fileURLToPath(import.meta.url));

function getHomeDir() {
  try {
    return homedir() || tmpdir();
  } catch {
    return tmpdir();
  }
}

function resolveQwenHome() {
  const configured = process.env['QWEN_HOME'];
  if (!configured) return join(getHomeDir(), '.qwen');
  if (configured === '~') return getHomeDir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return join(
      getHomeDir(),
      ...configured
        .slice(2)
        .split(/[/\\]+/)
        .filter(Boolean),
    );
  }
  return resolve(configured);
}

function preResolveQwenHome() {
  if (Object.hasOwn(process.env, 'QWEN_HOME')) return;
  const home = getHomeDir();
  for (const candidate of [join(home, '.qwen', '.env'), join(home, '.env')]) {
    try {
      const source = readFileSync(candidate, 'utf8')
        .replace(/^\uFEFF/, '')
        .replace(/^(\s*(?:export\s+)?QWEN_HOME):[^\S\r\n]+/gm, '$1=');
      const configured = parseEnv(source)['QWEN_HOME'];
      if (configured) {
        process.env['QWEN_HOME'] = configured;
        return;
      }
    } catch {
      // Match the CLI's quiet handling of missing or invalid home env files.
    }
  }
}

delete process.env['QWEN_CODE_MANAGED_NPM_UPDATE'];
preResolveQwenHome();

function getManagedNpmPin() {
  try {
    const pin = JSON.parse(process.env['QWEN_CODE_MANAGED_NPM_PIN'] ?? '');
    if (pin.bootstrap !== currentEntryPath) return undefined;
    if (
      typeof pin.updateRoot !== 'string' ||
      resolve(pin.updateRoot) !== pin.updateRoot
    ) {
      return undefined;
    }
    if (pin.version === null) {
      return { version: null, updateRoot: pin.updateRoot };
    }
    return typeof pin.version === 'string' &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        pin.version,
      )
      ? { version: pin.version, updateRoot: pin.updateRoot }
      : undefined;
  } catch {
    return undefined;
  }
}

const managedNpmPin = getManagedNpmPin();
const managedNpmUpdateRoot =
  managedNpmPin?.updateRoot ?? join(resolveQwenHome(), 'updates', 'npm');

function getManagedNpmInstallation() {
  try {
    if (managedNpmPin?.version === null) return undefined;
    const launcherRoot = join(
      managedNpmUpdateRoot,
      createHash('sha256').update(currentEntryPath).digest('hex').slice(0, 16),
    );
    let version = managedNpmPin?.version;
    if (version === undefined) {
      const active = JSON.parse(
        readFileSync(join(launcherRoot, 'active.json'), 'utf8'),
      );
      const basePackageJsonPath = [
        join(__dirname, 'package.json'),
        join(__dirname, '..', 'package.json'),
      ].find((candidate) => existsSync(candidate));
      if (!basePackageJsonPath) return undefined;
      const basePackage = JSON.parse(readFileSync(basePackageJsonPath, 'utf8'));
      if (
        typeof active.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
          active.version,
        ) ||
        typeof active.bootstrap !== 'string' ||
        realpathSync(active.bootstrap) !== currentEntryPath ||
        active.baseVersion !== basePackage.version ||
        active.bootstrapCtimeMs !== statSync(currentEntryPath).ctimeMs
      ) {
        return undefined;
      }
      version = active.version;
    }
    const packageRoot = join(
      launcherRoot,
      'versions',
      version,
      'node_modules',
      '@qwen-code',
      'qwen-code',
    );
    const packageJsonPath = join(packageRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const cliPath = join(packageRoot, 'cli.js');
    if (
      pkg.name !== '@qwen-code/qwen-code' ||
      pkg.version !== version ||
      !existsSync(cliPath)
    ) {
      return undefined;
    }
    process.env['QWEN_CODE_MANAGED_NPM_UPDATE'] = 'true';
    return { cliPath, packageJsonPath, version };
  } catch {
    return undefined;
  }
}

// The entry a subprocess should call to reach THIS build.
//
// A skill that shells out to `qwen …` gets whatever `qwen` PATH resolves to, which
// is not necessarily the code that launched it: with an older global install on the
// machine, a current-source daemon's `qwen review agent-prompt --role 0` landed in a
// v0.19.10 binary whose `agent-prompt` predates `--role`, and the run died on
// "Missing required argument: chunk". This file is the executable entry and the one
// thing that knows its own path, so it publishes it; `getShellContextEnvVars` passes
// it to every shell subprocess, and a caller prefers it over a bare `qwen`.
//
// Assignment, not `||=`: an inherited value is another session's CLI — an outer
// qwen shelling out to this one — and honouring it re-creates the exact skew above,
// one level up. Each entry stamps itself, so nested sessions each call their own
// build. The managed-version pin keeps nested calls on the running session's build
// even if a background update changes the active pointer. A post-update relaunch
// clears that pin so the launcher's wrapper selects the newly active build.
//
// One exception, and it points the SAME way: the standalone package launches this
// file through a shim (`bin/qwen`) that selects the BUNDLED Node — the host may
// have none — and announces itself via QWEN_CODE_LAUNCHER_PATH. There, "the entry
// that reaches this build" is the shim: stamping this file instead would hand
// subprocesses a `#!/usr/bin/env node` script on a machine where that resolves to
// nothing. Read before the spawn path deletes the variable below.
// Captured AND deleted here, not just read: the serve/mcp fast path below never
// reaches the spawn branch that used to delete it, so the hint leaked into every
// child of a standalone daemon — and a child qwen from a DIFFERENT checkout
// would read the outer shim and republish it as its own entry: the wrong build,
// wearing this one's stamp.
const standaloneShim = process.env['QWEN_CODE_LAUNCHER_PATH'];
delete process.env['QWEN_CODE_LAUNCHER_PATH'];

const managedNpmInstallation = getManagedNpmInstallation();
const validStandaloneShim =
  standaloneShim && existsSync(standaloneShim) ? standaloneShim : undefined;
process.env['QWEN_CODE_CLI'] =
  validStandaloneShim ?? fileURLToPath(import.meta.url);
if (validStandaloneShim) {
  delete process.env['QWEN_CODE_MANAGED_NPM_PIN'];
  delete process.env['QWEN_CODE_MANAGED_NPM_ROOT'];
} else {
  process.env['QWEN_CODE_MANAGED_NPM_ROOT'] = managedNpmUpdateRoot;
  process.env['QWEN_CODE_MANAGED_NPM_PIN'] = JSON.stringify({
    bootstrap: currentEntryPath,
    version: managedNpmInstallation?.version ?? null,
    updateRoot: managedNpmUpdateRoot,
  });
}
const cliPathCandidates = [
  managedNpmInstallation?.cliPath,
  join(__dirname, 'cli.js'),
  join(__dirname, '..', 'dist', 'cli.js'),
].filter(Boolean);
const packageJsonPathCandidates = [
  managedNpmInstallation?.packageJsonPath,
  join(__dirname, 'package.json'),
  join(__dirname, '..', 'package.json'),
].filter(Boolean);
const cliPath =
  cliPathCandidates.find((candidate) => existsSync(candidate)) ??
  cliPathCandidates[0];
const packageJsonPath =
  packageJsonPathCandidates.find((candidate) => existsSync(candidate)) ??
  packageJsonPathCandidates[0];

if (isTopLevelVersion) {
  try {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    process.stdout.write(`${pkg.version || 'unknown'}\n`);
    process.exit(0);
  } catch {
    // Fall through to cli.js, which has its own version fallback.
  }
}

if (isInProcessFastPath()) {
  const { default: module } = await import('node:module');
  const compileCache = module.enableCompileCache?.();
  if (
    cliArgs[0] === 'serve' &&
    !process.env['NODE_COMPILE_CACHE'] &&
    compileCache?.status === module.constants?.compileCacheStatus?.ENABLED &&
    compileCache?.directory
  ) {
    process.env['NODE_COMPILE_CACHE'] = compileCache.directory;
  }
  process.argv[1] = cliPath;
  await import(pathToFileURL(cliPath).href);
} else {
  const { spawnSync } = await import('node:child_process');
  const UPDATE_COMPLETE_EXIT_CODE = 44;
  const launcherNames =
    process.platform === 'win32' ? ['qwen.cmd', 'qwen.exe', 'qwen'] : ['qwen'];
  const entryPath = resolve(process.argv[1]);
  const entryRootLength = parse(entryPath).root.length;
  const launcherFromEnv = standaloneShim;
  delete process.env['QWEN_CODE_LAUNCHER_PID'];
  const launcherCandidates = process.env['PATH']
    ?.split(delimiter)
    .flatMap((dir) => launcherNames.map((name) => join(dir, name)))
    .filter((candidate) => existsSync(candidate));
  const launcher =
    launcherFromEnv && existsSync(launcherFromEnv)
      ? launcherFromEnv
      : launcherCandidates
          ?.map((candidate) => {
            if (resolve(candidate) === entryPath) {
              return { candidate, score: Number.MAX_SAFE_INTEGER };
            }
            try {
              if (realpathSync(candidate) === realpathSync(entryPath)) {
                return { candidate, score: Number.MAX_SAFE_INTEGER };
              }
            } catch {
              // Fall back to matching the installation prefix.
            }
            let parent = resolve(dirname(candidate));
            while (
              parent.length > entryRootLength &&
              entryPath !== parent &&
              !entryPath.startsWith(`${parent}${sep}`)
            ) {
              const next = dirname(parent);
              if (next === parent) break;
              parent = next;
            }
            return { candidate, score: parent.length };
          })
          .filter(({ score }) => score > entryRootLength)
          .sort((a, b) => b.score - a.score)[0]?.candidate;
  const env = {
    ...process.env,
    QWEN_CODE_LAUNCHER_PID: String(process.pid),
  };
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', cliPath, ...cliArgs],
    { stdio: 'inherit', env },
  );

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else if (result.status !== UPDATE_COMPLETE_EXIT_CODE) {
    process.exit(result.status ?? 1);
  } else {
    if (!launcher) {
      process.stderr.write(
        'Update successful! The new version will be used on your next run.\n',
      );
      process.exit(0);
    }
    const relaunchEnv = {
      ...process.env,
      QWEN_CODE_RELAUNCH_ARGS: JSON.stringify(cliArgs),
      QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
    };
    delete relaunchEnv['QWEN_CODE_MANAGED_NPM_PIN'];
    const relaunchResult =
      process.platform === 'win32' && launcher.endsWith('.cmd')
        ? spawnSync(
            process.env['ComSpec'] ?? 'cmd.exe',
            ['/d', '/s', '/c', `""${launcher}""`],
            { stdio: 'inherit', env: relaunchEnv },
          )
        : spawnSync(launcher, [], {
            stdio: 'inherit',
            env: relaunchEnv,
          });
    if (relaunchResult.signal) {
      process.kill(process.pid, relaunchResult.signal);
    } else {
      process.exit(relaunchResult.status ?? 1);
    }
  }
}
