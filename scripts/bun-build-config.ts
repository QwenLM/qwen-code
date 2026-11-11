#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bun.build configuration used by build_qwen_bun_binary.ts through
 * bun-binary-compiler.ts to produce a standalone binary with Bun.build's
 * `compile` option.
 *
 * Plugins, defines and externals belong to the same compile pass so that
 * `with { type: 'file' }` imports embed assets in the final binary. The previous
 * two-step flow emitted sidecar files that a later compile pass could not embed.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { qwenBrandDefines } from './brand-env.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

export const EXTERNAL = ['keytar', '@crosscopy/clipboard'];

// `--use-system-ca` makes Bun trust the OS certificate store in addition to
// its bundled Mozilla CA set, matching enterprise expectations for internal roots.
//
// `--no-deprecation` silences DEP0169: the HTTPDNS SDK (@alicloud-emas/httpdns)
// pins axios 0.27, whose http adapter still calls `url.parse()`, and the SDK
// client's constructor fires a service-IP request on every cold start — so the
// warning lands on stderr before the first `-p` answer. Bun started reporting
// that deprecation somewhere between 1.3.14 and 1.4.2. The npm bundle is quiet
// because the runtime skips the warning when the caller sits under
// node_modules; a compiled binary inlines vendor code at virtual paths, so that
// guard never matches here. Blunt on purpose — it hides every deprecation, the
// same trade the SEA launcher already makes via `process.noDeprecation`.
// Unrecognized flags are ignored by Bun, so this is safe on the OHOS canary too.
export function resolveBunCompileExecArgv(
  isOhosBuild = false,
): readonly string[] {
  return [...(isOhosBuild ? [] : ['--use-system-ca']), '--no-deprecation'];
}

export const BUN_COMPILE_EXEC_ARGV = resolveBunCompileExecArgv();

/**
 * Warn when the running Bun differs from the pin in .bun-version. Bun does
 * not read this file automatically, so a local build can embed a different
 * runtime than intended. Advisory by design: the build continues either way.
 */
function warnOnBunVersionDrift(): void {
  if (typeof Bun === 'undefined') return;

  let pinned: string;
  try {
    pinned = readFileSync(path.join(root, '.bun-version'), 'utf8').trim();
  } catch {
    return;
  }
  if (!pinned || pinned.replace(/^v/, '') === Bun.version) return;

  console.warn(
    `⚠️  Bun 版本与 .bun-version 不一致: 当前 ${Bun.version}, 仓库锁定 ${pinned}。\n` +
      '   构建继续，但产物内嵌的运行时与 CI 产物不同。',
  );
}

warnOnBunVersionDrift();

/**
 * Bytecode requires this Bun version or newer.
 *
 * `--bytecode` itself works further back, but the compact encoding (shared
 * string table across chunks, 32-bit offsets, payload aliased from the mmap
 * instead of copied into the heap) plus `--bytecode-depth` and cross-target
 * support all landed in the 1.4.1 release. On an older toolchain the same JS
 * payload emits several times as much bytecode and cross-compiled targets are
 * not covered at all, so a build there would be silently much worse rather
 * than merely different.
 */
export const BYTECODE_MIN_BUN_VERSION = '1.4.1';

export interface BytecodeOptions {
  bytecode?: true;
  bytecodeDepth?: number;
}

/** `1.4.2` / `1.4.0-canary.1` → `[1, 4, 2]` / `[1, 4, 0]`. */
function versionTuple(version: string): [number, number, number] {
  const [core] = version.split('-');
  const parts = (core ?? '').split('.').map((piece) => Number(piece) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compares release versions only. A prerelease sorts as its base release, so
 * `1.4.0-canary.1` reads as `1.4.0` and is correctly rejected against a `1.4.1`
 * floor — which is the case that matters, since the HarmonyOS bundler is a
 * 1.4.0 canary.
 */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const have = versionTuple(actual);
  const want = versionTuple(minimum);
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
}

function bunVersionAtLeast(minimum: string): boolean {
  return versionAtLeast(Bun.version, minimum);
}

/**
 * Resolves the `bytecode` / `bytecodeDepth` options for a `--compile` build.
 *
 * Bytecode is ON by default: Bun compiles the JS payload to JSC bytecode at
 * build time, so startup loads it instead of parsing ~30 MB of minified source
 * on every launch. It trades binary size for startup latency.
 *
 * Three constraints are enforced here rather than at the call sites:
 *
 *  1. The caller MUST also pass `format: 'esm'`. Bun flips the module format to
 *     CJS whenever bytecode is on ("Defaults to esm, or cjs with --bytecode"),
 *     and this bundle does not survive that switch: top-level await fails the
 *     build outright, and `import.meta.url` has ~50 call sites. This function
 *     cannot set the format itself, so `assertBytecodeFormat` below is the
 *     backstop.
 *  2. HarmonyOS is excluded unconditionally. That build swaps in a bundler and
 *     a base runtime supplied as a matched pair (see ohos/scripts/build.sh),
 *     and that pair predates cross-target bytecode support. Bytecode is bound
 *     to the JSC build that produced it, so emitting it there would range from
 *     wasted bytes to a runtime crash.
 *  3. Bun must be >= BYTECODE_MIN_BUN_VERSION. Below that the build fails loudly
 *     instead of quietly shipping the old, much larger encoding.
 *
 * Env overrides:
 *   QWEN_CODE_BYTECODE_ENABLE=0   turn bytecode off (escape hatch / A-B testing)
 *   QWEN_CODE_BYTECODE_DEPTH=<n>  compile only n levels of nested functions
 *                                ahead of time; unset means all of them
 */
export function resolveBytecodeOptions(
  envPrefix = 'QWEN_CODE_',
  isOhosBuild = false,
): BytecodeOptions {
  const enableEnv = `${envPrefix}BYTECODE_ENABLE`;
  const depthEnv = `${envPrefix}BYTECODE_DEPTH`;
  const flag = process.env[enableEnv]?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') {
    console.log(`Bytecode: disabled (${enableEnv}=${flag}).`);
    return {};
  }

  if (isOhosBuild) {
    console.log(
      'Bytecode: disabled (HarmonyOS build supplies its own base runtime).',
    );
    return {};
  }

  if (!bunVersionAtLeast(BYTECODE_MIN_BUN_VERSION)) {
    throw new Error(
      `Bytecode needs Bun >= ${BYTECODE_MIN_BUN_VERSION}, but this is ${Bun.version}. ` +
        'Older toolchains emit the pre-compaction encoding and do not cover ' +
        'cross-compiled targets, so the artifact would be several times larger ' +
        `than intended. Upgrade Bun, or set ${enableEnv}=0 to build ` +
        'without bytecode.',
    );
  }

  const rawDepth = process.env[depthEnv]?.trim();
  if (!rawDepth) {
    console.log(`Bytecode: enabled, all depths (Bun ${Bun.version}).`);
    return { bytecode: true };
  }

  const depth = Number(rawDepth);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(
      `${depthEnv} must be a non-negative integer, got "${rawDepth}".`,
    );
  }
  console.log(`Bytecode: enabled, depth=${depth} (Bun ${Bun.version}).`);
  return { bytecode: true, bytecodeDepth: depth };
}

/**
 * Guards constraint 1 above. Bun resolves `format` after `bytecode`, so an
 * explicit `format: 'esm'` wins — but only if someone actually passes it, and
 * dropping it degrades silently on a bundle without top-level await. Call this
 * with the options that are about to go to Bun.build.
 */
export function assertBytecodeFormat(options: {
  format?: string;
  bytecode?: boolean;
}): void {
  if (options.bytecode && options.format !== 'esm') {
    throw new Error(
      "Bytecode builds must pass format: 'esm' explicitly; Bun defaults the " +
        `format to CJS when bytecode is on (got ${JSON.stringify(options.format)}).`,
    );
  }
}

export interface SplittingOptions {
  splitting?: true;
  naming?: { chunk: string };
}

/**
 * Resolves the `splitting` options for a `--compile` build.
 *
 * Splitting is ON by default: Bun emits the payload as one entry plus ~250
 * `chunk-<hash>.js` modules instead of a single 20 MB module. Measured on
 * darwin-arm64 (see docs/design/2026-09-09-bun-splitting.md): the binary drops
 * 171.0 -> 153.7 MB and `--version` drops 141.7 -> 126.3 ms.
 *
 * Two things those numbers do NOT say, both easy to assume wrongly:
 *
 *  - The size win is a storage-encoding effect, not less code: the single-module
 *    artifact stores the payload as UTF-16 and the split one as latin1, and this
 *    bundle is all ASCII. Observed (the same string is UTF-16 in one and latin1
 *    in the other, and the same ~18 MB gap shows up with bytecode off), but Bun
 *    documents no rule for it — don't go looking for one.
 *  - Peak RSS does not improve (201-203 -> 203-206 MB). The "-32% RAM" figure
 *    going around belongs to the 1.4.1 bytecode encoding, which this repo
 *    already has.
 *
 * Two constraints are enforced here rather than at the call sites:
 *
 *  1. Chunk names are pinned to `chunk-[hash].[ext]`. Bun's default
 *     `[name]-[hash].[ext]` writes source module names into the artifact, and a
 *     repo that obfuscates its npm bundle should not ship a module listing in
 *     the binary instead.
 *  2. HarmonyOS is excluded unconditionally, for the same reason bytecode is:
 *     that build swaps in a bundler/runtime pair supplied by Gaea (currently a
 *     1.4.0 canary) which has never been verified here for compile + splitting,
 *     and no CI step ever executes a HarmonyOS artifact.
 *
 * Unlike bytecode this needs no version floor — `splitting` predates every Bun
 * this repo has ever pinned.
 *
 * Env override:
 *   QWEN_CODE_SPLITTING_ENABLE=0  turn splitting off (escape hatch / A-B testing)
 */
export function resolveSplittingOptions(
  envPrefix = 'QWEN_CODE_',
  isOhosBuild = false,
): SplittingOptions {
  const enableEnv = `${envPrefix}SPLITTING_ENABLE`;
  const flag = process.env[enableEnv]?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') {
    console.log(`Splitting: disabled (${enableEnv}=${flag}).`);
    return {};
  }

  if (isOhosBuild) {
    console.log(
      'Splitting: disabled (HarmonyOS build supplies its own bundler).',
    );
    return {};
  }

  console.log('Splitting: enabled, chunks named chunk-[hash].[ext].');
  return { splitting: true, naming: { chunk: 'chunk-[hash].[ext]' } };
}

export function resolveImportPath(specifier: string, resolveDir = ''): string {
  const isBareSpecifier =
    !path.isAbsolute(specifier) &&
    !specifier.startsWith('./') &&
    !specifier.startsWith('../');
  if (isBareSpecifier) {
    return require.resolve(specifier, {
      paths: resolveDir ? [resolveDir, root] : [root],
    });
  }
  return path.isAbsolute(specifier)
    ? specifier
    : path.resolve(resolveDir || root, specifier);
}

function toEmbeddedUint8ArrayModule(bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString('base64');
  return [
    `const bytes = Buffer.from("${base64}", "base64");`,
    'export default new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);',
  ].join('\n');
}

/** Keep native assets distinct from executable imports of the same file. */
export function createEmbeddedNativeAssetsPlugin(): Bun.BunPlugin {
  const suffix = '?embedded-native';
  const assetSuffix = '.cli-native';
  return {
    name: 'embedded-native-assets',
    setup(build) {
      build.onResolve({ filter: /\?embedded-native$/ }, (args) => ({
        // Bun 1.4.2 deduplicates by path even across loaders/namespaces. A
        // distinct path is necessary: namespace alone still aliases JSON/JS
        // imports to their parsed exports instead of an embedded file path.
        path:
          path.resolve(args.resolveDir, args.path.slice(0, -suffix.length)) +
          assetSuffix,
        namespace: 'embedded-native',
      }));
      build.onLoad({ filter: /.*/, namespace: 'embedded-native' }, (args) => ({
        contents: readFileSync(args.path.slice(0, -assetSuffix.length)),
        loader: 'file',
      }));
    },
  };
}

export function createWasmPlugins(): Bun.BunPlugin[] {
  return [
    {
      name: 'wasm-binary',
      setup(build) {
        build.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
          const specifier = args.path.replace(/\?binary$/, '');
          const resolvedPath = resolveImportPath(specifier, args.resolveDir);
          return { path: resolvedPath, namespace: 'wasm-binary' };
        });
        build.onLoad(
          { filter: /.*/, namespace: 'wasm-binary' },
          async (args) => {
            const bytes = new Uint8Array(
              await Bun.file(args.path).arrayBuffer(),
            );
            return {
              contents: toEmbeddedUint8ArrayModule(bytes),
              loader: 'js',
            };
          },
        );
      },
    },
  ];
}

/**
 * vendor-types/*.d.ts are TS-only path aliases; Bun.build's tsconfig
 * paths resolver redirects imports to them before plugin onResolve fires, so
 * we have to intercept at onLoad and synthesize a proxy re-exporting from the
 * real node_modules implementation via an absolute path (absolute path avoids
 * re-triggering the alias resolver).
 */
export function createVendorTypeBypassPlugin(): Bun.BunPlugin {
  const nodeModulesRoot = path.join(root, 'node_modules');
  const dtsPattern = /vendor-types\/([^/]+)(?:\/(.+?))?(?:\.d)?\.ts$/;
  return {
    name: 'bypass-vendor-type-aliases',
    setup(build) {
      build.onLoad({ filter: /vendor-types\/[^/]+\/.*\.d\.ts$/ }, (args) => {
        const m = args.path.match(dtsPattern);
        if (!m) return null;
        const pkgName = m[1];
        const rawSub = m[2];
        let subPath = rawSub
          ? rawSub.replace(/\.d$/, '').replace(/\.ts$/, '')
          : undefined;
        if (subPath === 'index') subPath = undefined;
        const target = subPath ? `${pkgName}/${subPath}` : pkgName;
        let realPath: string;
        try {
          realPath = require.resolve(target, { paths: [nodeModulesRoot] });
        } catch (err) {
          throw new Error(
            `bypass-vendor-type-aliases: could not resolve ${target} from ${nodeModulesRoot}. ${err instanceof Error ? err.message : ''}`,
          );
        }
        const spec = JSON.stringify(realPath);
        const contents = `
            import __vendorDefault from ${spec};
            export * from ${spec};
            export default __vendorDefault;
          `;
        return { contents, loader: 'ts' };
      });
    },
  };
}

const bundledWorkspaceEntrypoints = new Map<string, string>([
  ['ink', path.join(root, 'packages/cli/src/ink/index.ts')],
  [
    '@qwen-code/core/plugin-management',
    path.join(root, 'packages/core/plugin-management.ts'),
  ],
  ['@qwen-code/core/sessions', path.join(root, 'packages/core/sessions.ts')],
  ['@qwen-code/core', path.join(root, 'packages/core/index.ts')],
  ['@qwen-code/qwen-code', path.join(root, 'packages/cli/index.ts')],
  ['@qwen-code/qwen-code/ui', path.join(root, 'packages/cli/ui.ts')],
  [
    '@qwen-code/qwen-code/framework',
    path.join(root, 'packages/cli/framework.ts'),
  ],
  [
    '@qwen-code/qwen-code/thread-manager',
    path.join(root, 'packages/cli/thread-manager.ts'),
  ],
  ['@qwen-code/qwen-code/acp', path.join(root, 'packages/cli/acp.ts')],
  [
    '@qwen-code/qwen-code/daemon-host',
    path.join(root, 'packages/cli/daemon-host.ts'),
  ],
  [
    '@qwen-code/qwen-code/headless',
    path.join(root, 'packages/cli/headless.ts'),
  ],
  [
    '@qwen-code/qwen-code/installation',
    path.join(root, 'packages/cli/installation.ts'),
  ],
  [
    '@qwen-code/qwen-code/installation-host',
    path.join(root, 'packages/cli/installation-host.ts'),
  ],
  [
    '@qwen-code/qwen-code/plugin-commands',
    path.join(root, 'packages/cli/plugin-commands.ts'),
  ],
  [
    '@qwen-code/qwen-code/plugin-management',
    path.join(root, 'packages/cli/plugin-management.ts'),
  ],
  [
    '@qwen-code/qwen-code/command-runtime',
    path.join(root, 'packages/cli/command-runtime.ts'),
  ],
  [
    '@qwen-code/qwen-code/release-notes',
    path.join(root, 'packages/cli/release-notes.ts'),
  ],
  [
    '@qwen-code/qwen-code/session-startup',
    path.join(root, 'packages/cli/session-startup.ts'),
  ],
  ['@qwen-code/resource', path.join(root, 'packages/resource/index.ts')],
]);

/**
 * Resolve state-sharing workspace packages to source for every Bun importer.
 *
 * the package composes the CLI and Core from package imports. Resolve CLI, Core and
 * Resources to source so no compiled dist copy can duplicate process singletons
 * such as the plugin registry, auth manager, cleanup handlers, event buses or
 * the resource load-error and checked-dir state.
 *
 * This is deliberately a bundle-build concern. It does not change the emitted
 * workspace packages or ordinary Node module resolution.
 */
export function resolveBundledWorkspaceImport(
  specifier: string,
): string | undefined {
  return bundledWorkspaceEntrypoints.get(specifier);
}

export function createWorkspaceModuleIdentityPlugin(): Bun.BunPlugin {
  return {
    name: 'canonicalize-workspace-module-identity',
    setup(build) {
      build.onResolve(
        {
          filter:
            /^(?:@qwen-code\/core(?:\/(?:config-home|plugin-management|sessions))?|@qwen-code\/qwen-code(?:\/(?:ui|framework|thread-manager|acp|daemon-host|headless|plugin-commands|plugin-management|command-runtime|release-notes|session-startup|installation|installation-host))?|@qwen-code\/resource|ink)$/,
        },
        (args) => {
          const resolved = resolveBundledWorkspaceImport(args.path);
          if (!resolved) {
            throw new Error(
              `No source entrypoint registered for workspace module: ${args.path}`,
            );
          }
          return { path: resolved };
        },
      );

      // Fail loudly if a relative import or a future resolver change bypasses
      // the canonical bare-package resolution above. Shipping two Core copies
      // produces silent singleton divergence that is much harder to diagnose
      // than a build failure.
      build.onLoad(
        {
          filter:
            /packages[\\/](?:core|cli|resource)[\\/]dist[\\/](?:index\.js|ui\.js|config-home\.js|src[\\/])/,
        },
        (args) => {
          throw new Error(
            `Bun build resolved a compiled workspace module from ${args.path}. ` +
              'Core, CLI and Resource must all be bundled from their source entrypoints.',
          );
        },
      );
    },
  };
}

export type CommonBuildOptions = {
  pkgVersion: string;
};

export function commonBuildDefine(
  opts: CommonBuildOptions,
): Record<string, string> {
  return {
    ...qwenBrandDefines(),
    'process.env.CLI_VERSION': JSON.stringify(opts.pkgVersion),
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.DEV': JSON.stringify(process.env['DEV'] || 'false'),
    'process.env.CLI_OHOS_BUILD': JSON.stringify(''),
  };
}

export function repoRoot(): string {
  return root;
}

/**
 * Runs the asset generators in populate mode, then returns a
 * restore-stubs function. Callers should invoke the returned function in
 * a `finally` block so Node/Vitest don't trip over Bun-only `with { type:
 * 'file' }` imports when tests run after a bundle.
 */
export function populateEmbeds(
  target?: string,
  runtimeAssetIds?: readonly string[],
): () => void {
  runGenerator(
    'generate-embedded-assets.ts',
    runtimeAssetIds ? [`--assets=${runtimeAssetIds.join(',')}`] : [],
  );
  runGenerator(
    'generate-embedded-natives.ts',
    target ? ['--target', target] : [],
  );
  return () => {
    runGenerator('generate-embedded-assets.ts', ['--stub'], true);
    runGenerator('generate-embedded-natives.ts', ['--stub'], true);
  };
}

function runGenerator(
  script: string,
  extra: string[] = [],
  soft = false,
): void {
  const proc = Bun.spawnSync(
    ['bun', 'run', path.join(root, 'scripts', script), ...extra],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if (proc.exitCode !== 0) {
    if (soft) {
      console.warn(
        `Warning: ${script} (${extra.join(' ')}) failed with exit ${proc.exitCode}.`,
      );
    } else {
      throw new Error(
        `${script} (${extra.join(' ')}) failed with exit ${proc.exitCode}`,
      );
    }
  }
}

export function runGitCommitGenerator(): void {
  const proc = Bun.spawnSync(
    ['node', path.join(root, 'scripts/generate-git-commit-info.js')],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `generate-git-commit-info.js failed with exit ${proc.exitCode}`,
    );
  }
}
