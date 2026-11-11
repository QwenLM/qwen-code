#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single-step Bun compile → standalone binary.
 *
 * Replaces the previous two-step flow (Bun.build → `bun build --compile`).
 * That flow lost `with { type: 'file' }` embeddings because:
 *   1. Bun.build saw the import, wrote a sidecar file with a hashed name,
 *      and rewrote the value to `./<hash>.ext` in the bundle;
 *   2. `bun build --compile <bundle.js>` then had no idea those sidecar
 *      files existed — it embedded only the bundle JS, leaving the runtime
 *      with dangling relative-path references.
 *
 * The fix is to call Bun.build directly with its `compile` option so that
 * plugins, defines, externals, AND `with { type: 'file' }` imports all go
 * through a single compile pass. Embedded files show up as /$bunfs/... at
 * runtime, which is what bunNativesBootstrap.ts expects.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUN_NATIVE_EXTRACTION_FAILURE_MARKER } from '../packages/core/src/bootstrap/bunNativesConstants.js';

import {
  EXTERNAL,
  assertBytecodeFormat,
  createEmbeddedNativeAssetsPlugin,
  createWorkspaceModuleIdentityPlugin,
  createVendorTypeBypassPlugin,
  createWasmPlugins,
  populateEmbeds,
  repoRoot,
  resolveBytecodeOptions,
  resolveSplittingOptions,
  runGitCommitGenerator,
  BUN_COMPILE_EXEC_ARGV,
  type BytecodeOptions,
  type SplittingOptions,
} from './bun-build-config.ts';

const root = repoRoot();
const outDir = path.join(root, 'dist-bun');

/** Product entries provide resolved metadata and defines; the compiler has no product selector. */
export interface BunBinaryBuildOptions {
  entrypoint: string;
  binaryName: string;
  version: string;
  define: Record<string, string>;
  runtimeAssetIds: readonly string[];
  buildPlugins?: Bun.BunPlugin[];
  /** Optional compile overrides; defaults use the Qwen build environment. */
  compileOptions?: () => {
    bytecode: BytecodeOptions;
    splitting: SplittingOptions;
    execArgv: readonly string[];
    executablePath?: string;
  };
  target?: string;
  windowsIconPath?: string;
  windowsVersionInfoArgs: (binaryPath: string) => string[];
}

const codesignIdentity = process.env['CODESIGN_IDENTITY']?.trim() || '';
const entitlementsPath = path.join(root, 'scripts/entitlements.plist');

function shouldSignDarwinBinary(target?: string): boolean {
  return (
    process.platform === 'darwin' && (!target || target.includes('darwin'))
  );
}

function signDarwinBinary(binaryPath: string): void {
  // Bun compile embeds a stale signature copied from the host bun binary.
  // Strip first so the re-sign call actually produces the signature we want.
  const remove = Bun.spawnSync(
    ['xcrun', 'codesign', '--remove-signature', binaryPath],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (remove.exitCode !== 0) {
    const removeErr = remove.stderr.toString().trim();
    if (removeErr) {
      console.warn(
        `Warning: could not remove previous signature: ${removeErr}`,
      );
    }
  }

  const signArgs = codesignIdentity
    ? [
        'xcrun',
        'codesign',
        '--force',
        '--sign',
        codesignIdentity,
        '-o',
        'runtime',
        '--timestamp',
        '--deep',
        ...(existsSync(entitlementsPath)
          ? ['--entitlements', entitlementsPath]
          : []),
        binaryPath,
      ]
    : [
        'xcrun',
        'codesign',
        '-s',
        '-',
        '--force',
        '--timestamp=none',
        binaryPath,
      ];

  const sign = Bun.spawnSync(signArgs, { stdout: 'pipe', stderr: 'pipe' });
  if (sign.exitCode !== 0) {
    throw new Error(
      `codesign failed: ${sign.stderr.toString().trim() || 'unknown error'}`,
    );
  }
}

function signWindowsBinary(binaryPath: string): void {
  const pfxFile = process.env['WINDOWS_PFX_FILE']?.trim();
  const pfxPassword = process.env['WINDOWS_PFX_PASSWORD']?.trim();
  const signArgs = ['sign'];
  if (pfxFile && pfxPassword) {
    signArgs.push('/f', pfxFile, '/p', pfxPassword);
  } else {
    signArgs.push('/a');
  }
  signArgs.push(
    '/fd',
    'SHA256',
    '/td',
    'SHA256',
    '/tr',
    'http://timestamp.digicert.com',
    binaryPath,
  );

  console.log(`Signing ${binaryPath} with signtool...`);
  const sign = Bun.spawnSync(['signtool', ...signArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (sign.exitCode !== 0) {
    let errMsg = sign.stderr.toString().trim() || 'unknown error';
    if (pfxPassword) errMsg = errMsg.replaceAll(pfxPassword, '******');
    throw new Error(`signtool failed: ${errMsg}`);
  }
}

function signBinary(binaryPath: string, target?: string): void {
  if (shouldSignDarwinBinary(target)) {
    signDarwinBinary(binaryPath);
  } else if (
    process.platform === 'win32' &&
    (!target || target.includes('win32') || target.includes('windows'))
  ) {
    signWindowsBinary(binaryPath);
  } else if (process.platform === 'linux') {
    console.log('Skipping signing on Linux.');
  }
}

/**
 * The command that can actually execute `binaryPath` on this host, or null if
 * nothing here can run it.
 *
 * Executing the artifact matters more since bytecode landed: bytecode is bound
 * to the JSC build that emitted it and is laid out for in-place mmap, so a
 * cross-target binary that Bun happily produced can still fail to start. The
 * only cross-target case a darwin-arm64 host can cover is darwin-x64, via
 * Rosetta 2. `arch -x86_64` states that intent explicitly rather than relying
 * on the implicit translation a bare exec would get. Linux and Windows targets
 * run on matching hosts; Linux additionally needs the target libc loader.
 */
function smokeLauncherFor(
  binaryPath: string,
  target?: string,
  executablePath?: string,
): string[] | null {
  if (!target) return [binaryPath];

  const native = /^bun-(darwin|linux|windows)-(x64|arm64)(?:-|$)/.exec(target);
  const hostOS = process.platform === 'win32' ? 'windows' : process.platform;
  if (native?.[1] === hostOS && native[2] === process.arch && !executablePath) {
    if (hostOS === 'linux') {
      const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const loader = target.includes('-musl')
        ? `/lib/ld-musl-${cpu}.so.1`
        : process.arch === 'arm64'
          ? '/lib/ld-linux-aarch64.so.1'
          : '/lib64/ld-linux-x86-64.so.2';
      if (!existsSync(loader)) return null;
    }
    return [binaryPath];
  }

  const isDarwinTarget = target.includes('darwin');
  const isArm64Target = target.includes('arm64') || target.includes('aarch64');
  const isX64Target = target.includes('x64') || target.includes('x86_64');

  if (process.platform !== 'darwin' || !isDarwinTarget) return null;
  if (process.arch === 'arm64' && isArm64Target) return [binaryPath];
  if (process.arch === 'arm64' && isX64Target) {
    return hasRosetta() ? ['arch', '-x86_64', binaryPath] : null;
  }
  if (process.arch === 'x64' && isX64Target) return [binaryPath];
  return null;
}

/**
 * What the smoke test runs, in order.
 *
 * `--help` proves the binary starts at all. `--list-sessions` exists for
 * splitting: it is the cheapest offline, deterministic command that crosses a
 * lazy chunk boundary (packages/cli/src/utils/sessions.ts lands in an
 * `import()`-only chunk), and a cross-chunk cycle/TDZ failure — the classic
 * splitting regression — only surfaces when a lazy chunk actually loads.
 * Live model or MCP calls are unsuitable here.
 * CodeMode 离线验收暂时跳过，不为构建 smoke 注入生产回放逻辑。
 */
const SMOKE_ARGV: ReadonlyArray<readonly string[]> = [
  ['--help'],
  ['--list-sessions'],
];

/**
 * Ceiling per smoke command. `--help` returns instantly, but `--list-sessions`
 * touches the filesystem and initializes enough of the runtime to reach the
 * network, and child processes wait forever by default — so a stalled call on
 * a CI runner would hang the build instead of failing it. Both commands finish
 * in under 2s locally; a minute is slack, not a target.
 */
const SMOKE_TIMEOUT_MS = 60_000;

/**
 * Rosetta is an optional macOS component, so probe it with a binary known to
 * work before blaming ours. Without this check a runner that simply lacks
 * Rosetta would fail the build instead of skipping the smoke test.
 */
function hasRosetta(): boolean {
  const probe = Bun.spawnSync(['arch', '-x86_64', '/usr/bin/true'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (probe.exitCode === 0) return true;
  console.log('Rosetta 2 unavailable; darwin-x64 binary will not be executed.');
  return false;
}

async function runSmokeTest(
  binaryPath: string,
  target?: string,
  executablePath?: string,
): Promise<void> {
  const launcher = smokeLauncherFor(binaryPath, target, executablePath);
  if (!launcher) {
    console.log(
      `Skipping runtime smoke test: no way to execute ${target} on ${process.platform}-${process.arch}.`,
    );
    return;
  }

  // A throwaway config root keeps the result independent of the builder's own
  // personal configuration state — `--list-sessions` would otherwise read
  // whatever sessions happen to sit on this machine.
  const configDir = mkdtempSync(path.join(tmpdir(), 'cli-smoke-'));
  try {
    for (const argv of SMOKE_ARGV) {
      const command = [...launcher, '--config-dir', configDir, ...argv];
      // Bun.spawnSync can stall when launching compiled Bun binaries on macOS.
      // child_process keeps the same commands, output capture and timeout.
      const smoke = spawnSync(command[0]!, command.slice(1), {
        cwd: root,
        stdio: 'pipe',
        env: process.env,
        timeout: SMOKE_TIMEOUT_MS,
      });
      const stderr = smoke.stderr?.toString() ?? '';
      // A timeout kills the child and leaves status null with signal set,
      // so say so explicitly rather than reporting "exit code null".
      if (smoke.signal) {
        throw new Error(
          `binary smoke test (${command.join(' ')}) was killed by ${smoke.signal} ` +
            `(timeout is ${SMOKE_TIMEOUT_MS} ms)\n${stderr}`,
        );
      }
      if (smoke.status !== 0) {
        throw new Error(
          `binary smoke test (${command.join(' ')}) failed with exit code ${smoke.status}\n${stderr}`,
        );
      }
      if (stderr.includes(BUN_NATIVE_EXTRACTION_FAILURE_MARKER)) {
        throw new Error(
          `binary smoke test (${command.join(' ')}) failed native extraction\n${stderr}`,
        );
      }
      console.log(`Smoke test passed: ${command.join(' ')}`);
    }
    // 暂停依赖 fake 回放的 CodeMode 验收；保留真实产物启动和跨 chunk 检查。
    console.log(
      'CodeMode artifact smoke skipped: offline replay is not wired into production.',
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function patchWindowsIcon(binaryPath: string, windowsIconPath: string): void {
  const patch = Bun.spawnSync(
    [
      'bun',
      'run',
      path.join(root, 'scripts/patch_windows_icon.ts'),
      binaryPath,
      windowsIconPath,
    ],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if (patch.exitCode !== 0) {
    throw new Error(
      `patch_windows_icon.ts failed (exit ${patch.exitCode}); aborting build.`,
    );
  }
}

function patchWindowsVersionInfo(versionInfoArgs: string[]): void {
  const patch = Bun.spawnSync(
    [
      'bun',
      'run',
      path.join(root, 'scripts/patch_windows_version_info.ts'),
      ...versionInfoArgs,
    ],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if (patch.exitCode !== 0) {
    throw new Error(
      `patch_windows_version_info.ts failed (exit ${patch.exitCode}); aborting build.`,
    );
  }
}

export async function buildBunBinary(
  options: BunBinaryBuildOptions,
): Promise<void> {
  const {
    entrypoint,
    binaryName,
    version,
    define,
    target,
    windowsIconPath,
    windowsVersionInfoArgs,
  } = options;
  const isWindowsBuild = target
    ? target.includes('windows')
    : process.platform === 'win32';
  const outfile = path.join(
    outDir,
    isWindowsBuild ? `${binaryName}.exe` : binaryName,
  );
  rmSync(outfile, { force: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`Compiling Bun binary for ${binaryName} v${version}...`);

  // Fail fast if any required native prebuild is missing for the requested
  // target. generate-embedded-natives.ts only warns, so without this pre-flight
  // a cross-compile with a stale pnpm store would silently produce a binary
  // that crashes at runtime on the first sharp / node-pty / ripgrep call.
  const precheck = Bun.spawnSync(
    [
      'bun',
      'run',
      path.join(root, 'scripts/check_prebuilds.ts'),
      ...(target ? ['--target', target] : []),
    ],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if (precheck.exitCode !== 0) {
    throw new Error(
      `check_prebuilds failed (exit ${precheck.exitCode}); aborting build.`,
    );
  }

  runGitCommitGenerator();

  // Resolved before populateEmbeds so that a rejected bytecode configuration
  // (unsupported Bun, malformed depth) aborts while the generated embed modules
  // are still stubs — populateEmbeds returns a restore closure that only runs
  // from the `finally` further down, which a throw up here would never reach.
  const compileOptions = options.compileOptions?.() ?? {
    bytecode: resolveBytecodeOptions(),
    splitting: resolveSplittingOptions(),
    execArgv: BUN_COMPILE_EXEC_ARGV,
  };

  const restoreStubs = populateEmbeds(target, options.runtimeAssetIds);

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    // Built as a named object so assertBytecodeFormat below inspects the very
    // options Bun.build receives. Asserting a separately written literal would
    // be tautological: it would carry its own `format` and pass even after the
    // real one was dropped, which is the regression the assert exists to catch.
    const buildOptions = {
      // Keep the embedded Worker name stable with and without splitting.
      root: path.join(root, 'packages'),
      entrypoints: [
        entrypoint,
        path.join(root, 'packages/core/src/codemode/worker.ts'),
      ],
      target: 'bun',
      // `format: 'esm'` is load-bearing whenever bytecode is on: Bun switches
      // the default format to CJS for bytecode builds, and this bundle does not
      // survive that (top-level await stops compiling, and ~50 `import.meta.url`
      // call sites change meaning). Bun parses `format` after `bytecode`, so
      // stating it here wins. It is a no-op for non-bytecode builds — 'esm' is
      // already the default for target 'bun' — so it stays unconditional rather
      // than coupled to the flag.
      format: 'esm',
      ...compileOptions.bytecode,
      // Splitting emits one entry plus ~250 hash-named chunks instead of a
      // single module. Sits at the top level next to bytecode for the same
      // reason: it describes the payload, not the executable wrapper, so it does
      // not belong in the `compile` block.
      ...compileOptions.splitting,
      external: EXTERNAL,
      plugins: [
        createEmbeddedNativeAssetsPlugin(),
        createWorkspaceModuleIdentityPlugin(),
        createVendorTypeBypassPlugin(),
        ...createWasmPlugins(),
        ...(options.buildPlugins ?? []),
      ],
      minify: true,
      define: {
        ...define,
        __CODE_MODE_WORKER__: JSON.stringify('embedded'),
      },
      // Bun.build in 1.3+ accepts a `compile` block that produces a standalone
      // executable directly — see bun.com/docs/bundler/executables. This is the
      // path that keeps `with { type: 'file' }` imports embedded as /$bunfs/
      // paths at runtime (the CLI-only `bun build --compile` from a bundled JS
      // file does NOT).
      // @ts-expect-error compile is not yet in the Bun.build types we have.
      compile: {
        outfile,
        execArgv: compileOptions.execArgv,
        // Ignore .env and bunfig.toml from the launch directory.
        autoloadDotenv: false,
        autoloadBunfig: false,
        ...(target ? { target } : {}),
        // HarmonyOS is not an official Bun target, so its build supplies its own
        // base runtime rather than letting Bun fetch one for the target triple.
        // Unset for every other platform, where this contributes nothing.
        // Both key spellings are passed on purpose: an ignored override would
        // silently fall back to the official runtime for `target` and yield a
        // plain Linux binary instead of a HarmonyOS one.
        ...(() => {
          const basePath = compileOptions.executablePath;
          if (!basePath) return {};
          return { executablePath: basePath, execPath: basePath };
        })(),
        ...(isWindowsBuild && windowsIconPath
          ? {
              windows: {
                icon: windowsIconPath,
              },
            }
          : {}),
      },
    };

    assertBytecodeFormat(buildOptions);
    result = await Bun.build(buildOptions);
  } finally {
    restoreStubs();
  }

  if (!result.success) {
    console.error('Bun compile failed.');
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  if (!existsSync(outfile)) {
    throw new Error(`Expected binary was not created: ${outfile}`);
  }

  if (isWindowsBuild) {
    if (windowsIconPath) patchWindowsIcon(outfile, windowsIconPath);
    patchWindowsVersionInfo(windowsVersionInfoArgs(outfile));
  }
  signBinary(outfile, target);
  await runSmokeTest(outfile, target, compileOptions.executablePath);

  const sizeMb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`Built Bun binary: ${outfile} (${sizeMb} MB)`);
  if (shouldSignDarwinBinary(target)) {
    console.log(
      codesignIdentity
        ? `Signed binary with Developer ID: ${codesignIdentity}`
        : 'Signed binary with ad-hoc identity for local execution.',
    );
  } else if (process.platform === 'win32') {
    console.log('Signed binary with signtool.');
  }
}
