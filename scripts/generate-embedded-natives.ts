#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rewrites packages/core/src/generated/embedded-natives-bun.ts so that
 * `bun build --compile` embeds the platform-specific native module tree
 * (@lydell/node-pty-*, @img/sharp-*, the portable Photon WebAssembly runtime,
 * any @img/sharp-libvips-* package declared by sharp, the macOS native
 * clipboard package, and the macOS modifier-key binding) into the binary.
 * The extractor at packages/core/src/bootstrap/bunNativesBootstrap.ts mirrors
 * the embedded tree back out to a tmp dir at startup so that dlopen can load
 * the .node / .dylib / .so files via a real filesystem path.
 *
 * Usage:
 *   bun run scripts/generate-embedded-natives.ts --target bun-darwin-arm64
 *   bun run scripts/generate-embedded-natives.ts --stub
 *
 * When `--target` is omitted the host platform is used. The stub form is
 * what gets seeded into fresh checkouts by scripts/generate-git-commit-info.js
 * (the `generated/` directory is gitignored).
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const target = path.join(
  root,
  'packages/core/src/generated/embedded-natives-bun.ts',
);
const targetDir = path.dirname(target);

const HEADER = `/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This file is rewritten in-place by scripts/generate-embedded-natives.ts
// during the Bun bundle step, which adds \`import ... with { type: 'file' }\`
// statements so that \`bun build --compile\` embeds each native module file
// into the final binary. After the build completes, bun-binary-compiler.ts
// restores this stub so dev/Vitest runs on Node don't choke on Bun-only syntax.
//
// Consumers: packages/core/src/bootstrap/bunNativesBootstrap.ts walks this map
// and mirrors it back out to $TMPDIR/<binary>-natives-<version>-<user>/node_modules/
// at startup, then sets NODE_PATH so sharp / node-pty's runtime require() calls
// resolve to the extracted files.
//
// Keys are paths under node_modules/ (e.g. "@lydell/node-pty-darwin-arm64/pty.node").
// Values hold the /$bunfs/... path plus the permission mode bits we need to
// restore when writing the file out (exec bit for spawn-helper, etc).
`;

const TYPE_DECL = `export interface EmbeddedNativeFile {
  /** /$bunfs/... path injected by the Bun compile step. */
  path: string;
  /** Unix permission mode bits (low 9 bits: rwxrwxrwx). */
  mode: number;
}
`;

const STUB_BODY = `${TYPE_DECL}
export const EMBEDDED_NATIVES: Readonly<Record<string, EmbeddedNativeFile>> = {};
`;

type NodeTriple = {
  nodePlatform: 'darwin' | 'linux' | 'win32';
  nodeArch: 'x64' | 'arm64';
  /** Set only for linux targets — distinguishes glibc (default) from musl (Alpine, distroless). */
  libc: 'glibc' | 'musl';
};

function parseTarget(t: string | undefined): NodeTriple {
  if (!t) {
    return {
      nodePlatform: process.platform as NodeTriple['nodePlatform'],
      nodeArch: process.arch as NodeTriple['nodeArch'],
      libc: 'glibc',
    };
  }
  const m = t.match(/^bun-(darwin|linux|windows)-(x64|arm64|aarch64)(-musl)?/);
  if (!m) throw new Error(`Unsupported --target: ${t}`);
  const os = m[1] === 'windows' ? 'win32' : (m[1] as 'darwin' | 'linux');
  const arch = m[2] === 'aarch64' ? 'arm64' : (m[2] as 'x64' | 'arm64');
  const libc = m[3] ? 'musl' : 'glibc';
  if (libc === 'musl' && os !== 'linux') {
    throw new Error(`-musl suffix only valid for linux targets; got ${t}`);
  }
  return { nodePlatform: os, nodeArch: arch, libc };
}

/**
 * Files we deliberately leave out of the binary. Mostly docs + TypeScript
 * type definitions that neither dlopen nor sharp/pty's runtime require() path
 * ever reach for. Keeps the binary ~1MB leaner.
 */
const SKIP_BASENAMES = new Set([
  'README',
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
]);
const SKIP_EXTENSIONS = new Set(['.md', '.txt', '.d.ts', '.map']);

function shouldSkip(relPath: string): boolean {
  const base = path.basename(relPath);
  if (SKIP_BASENAMES.has(base)) return true;
  const ext = path.extname(base).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  // C headers shipped alongside libvips (glib-2.0/include/...) — runtime
  // dlopen never touches them; skip to save ~30KB.
  if (relPath.split(path.sep).includes('include')) return true;
  return false;
}

function walkPackage(
  pkgRoot: string,
  pkgRelKeyPrefix: string,
): Array<{ relKey: string; abs: string; mode: number }> {
  const out: Array<{ relKey: string; abs: string; mode: number }> = [];
  function visit(dirAbs: string, relFromPkg: string) {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const abs = path.join(dirAbs, entry.name);
      const relFromPkgNext = relFromPkg
        ? `${relFromPkg}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkip(relFromPkgNext)) continue;
        visit(abs, relFromPkgNext);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (shouldSkip(relFromPkgNext)) continue;
      const st = statSync(abs);
      out.push({
        relKey: `${pkgRelKeyPrefix}/${relFromPkgNext}`,
        abs,
        mode: st.mode & 0o777,
      });
    }
  }
  visit(pkgRoot, '');
  return out;
}

function importPathFor(absFile: string): string {
  const rel = path.relative(targetDir, absFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function hasOptionalDependency(
  ownerPackage: string,
  dependency: string,
): boolean {
  const manifestPath = path.join(
    root,
    'node_modules',
    ownerPackage,
    'package.json',
  );
  if (!existsSync(manifestPath)) return false;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    optionalDependencies?: Record<string, string>;
  };
  return !!manifest.optionalDependencies?.[dependency];
}

function populate(triple: NodeTriple) {
  const platPrefix = `${triple.nodePlatform}-${triple.nodeArch}`;
  // @img publishes musl builds under the "linuxmusl" platform tag, distinct
  // from plain "linux" (glibc). @lydell/node-pty does NOT ship a separate
  // musl variant as of 1.2.0-beta.12 — the linux-* prebuild is what Alpine
  // callers get. Empirically it loads on recent Alpine/distroless images,
  // but that's ABI luck, not a contract; check_prebuilds.ts warns on this.
  const sharpPrefix =
    triple.nodePlatform === 'linux' && triple.libc === 'musl'
      ? `linuxmusl-${triple.nodeArch}`
      : platPrefix;
  const nmSrc = path.join(root, 'node_modules');

  // Each entry points at a platform-specific npm package the target needs.
  // We only embed what's actually installed on the build host — cross-compile
  // callers are expected to have run `pnpm install --config.supportedArchitectures`
  // or similar before invoking us. Missing packages are logged but not fatal
  // (the bundle still builds; the feature just won't work on that platform).
  // Keys are runtime-root-relative paths; the extractor writes them verbatim
  // under $TMPDIR/<binary>-natives-<ver>-<user>/. Grouping under node_modules/
  // keeps sharp/pty's runtime require() tree valid; vendor/ mirrors the SEA
  // layout so ripgrep.ts's builtin-mode resolver picks it up unchanged.
  const packages: Array<{ pkgDir: string; keyPrefix: string }> = [
    {
      pkgDir: path.join(nmSrc, '@lydell', 'node-pty'),
      keyPrefix: 'node_modules/@lydell/node-pty',
    },
    {
      pkgDir: path.join(nmSrc, '@lydell', `node-pty-${platPrefix}`),
      keyPrefix: `node_modules/@lydell/node-pty-${platPrefix}`,
    },
    {
      pkgDir: path.join(nmSrc, '@img', `sharp-${sharpPrefix}`),
      keyPrefix: `node_modules/@img/sharp-${sharpPrefix}`,
    },
    {
      pkgDir: path.join(nmSrc, '@silvia-odwyer', 'photon-node'),
      keyPrefix: 'node_modules/@silvia-odwyer/photon-node',
    },
  ];
  const sharpLibvipsPkg = `@img/sharp-libvips-${sharpPrefix}`;
  if (hasOptionalDependency('sharp', sharpLibvipsPkg)) {
    packages.push({
      pkgDir: path.join(nmSrc, '@img', `sharp-libvips-${sharpPrefix}`),
      keyPrefix: `node_modules/@img/sharp-libvips-${sharpPrefix}`,
    });
  }
  if (triple.nodePlatform === 'darwin') {
    packages.push(
      {
        pkgDir: path.join(nmSrc, '@crosscopy', 'clipboard'),
        keyPrefix: 'node_modules/@crosscopy/clipboard',
      },
      {
        pkgDir: path.join(
          nmSrc,
          '@crosscopy',
          `clipboard-darwin-${triple.nodeArch}`,
        ),
        keyPrefix: `node_modules/@crosscopy/clipboard-darwin-${triple.nodeArch}`,
      },
      {
        pkgDir: path.join(
          root,
          'packages/cli/src/native-modifiers/prebuilds',
          `darwin-${triple.nodeArch}`,
        ),
        keyPrefix: `node_modules/@qwen-code/native-modifiers/prebuilds/darwin-${triple.nodeArch}`,
      },
    );
  }

  const collected: Array<{ relKey: string; abs: string; mode: number }> = [];
  for (const { pkgDir, keyPrefix } of packages) {
    if (!existsSync(pkgDir)) {
      const libcHint =
        triple.nodePlatform === 'linux' && triple.libc === 'musl'
          ? ' --config.supportedArchitectures.libc[]=musl'
          : '';
      console.warn(
        `embedded-natives: ${keyPrefix} not installed at ${pkgDir}; skipping. ` +
          `Run \`pnpm install --config.supportedArchitectures.os[]=${triple.nodePlatform} --config.supportedArchitectures.cpu[]=${triple.nodeArch}${libcHint}\` to enable.`,
      );
      continue;
    }
    collected.push(...walkPackage(pkgDir, keyPrefix));
  }

  // ripgrep binary: vendor/ripgrep/<arch>-<os>/rg — layout matches SEA's
  // build_binary.js so ripgrep.ts's existing `mode: 'builtin'` resolver
  // handles it without special-casing bundled mode.
  const archOsDir = `${triple.nodeArch}-${triple.nodePlatform}`;
  const rgName = triple.nodePlatform === 'win32' ? 'rg.exe' : 'rg';
  const rgSrc = path.join(
    root,
    'packages/core/dist/vendor/ripgrep',
    archOsDir,
    rgName,
  );
  if (existsSync(rgSrc)) {
    const st = statSync(rgSrc);
    collected.push({
      relKey: `vendor/ripgrep/${archOsDir}/${rgName}`,
      abs: rgSrc,
      // Force exec bit: vendor rg is 755 on disk but some NPM layouts strip it.
      mode: (st.mode & 0o777) | 0o111,
    });
  } else {
    console.warn(
      `embedded-natives: ripgrep not found at ${rgSrc}; run \`npm run build\` first to download it.`,
    );
  }
  // Stable ordering: path-sorted, so regenerated files produce clean diffs.
  collected.sort((a, b) => (a.relKey < b.relKey ? -1 : 1));

  if (collected.length === 0) {
    writeFileSync(target, HEADER + '\n' + STUB_BODY);
    console.log(
      `embedded-natives-bun.ts: no native packages found for ${platPrefix}; wrote empty map.`,
    );
    return;
  }

  const imports: string[] = [];
  const entries: string[] = [];
  collected.forEach((item, idx) => {
    const binding = `n${idx}`;
    imports.push(
      `import ${binding} from '${importPathFor(item.abs)}?embedded-native' with { type: 'file' };`,
    );
    entries.push(
      `  ${JSON.stringify(item.relKey)}: { path: ${binding}, mode: 0o${item.mode.toString(8).padStart(3, '0')} },`,
    );
  });

  const body = `${imports.join('\n')}\n\n${TYPE_DECL}
export const EMBEDDED_NATIVES: Readonly<Record<string, EmbeddedNativeFile>> = {
${entries.join('\n')}
};
`;

  writeFileSync(target, HEADER + '\n' + body);
  console.log(
    `embedded-natives-bun.ts: populated with ${collected.length} file(s) for ${platPrefix}.`,
  );
}

function stub() {
  writeFileSync(target, HEADER + '\n' + STUB_BODY);
  console.log('embedded-natives-bun.ts: restored stub.');
}

const args = process.argv.slice(2);
const wantStub = args.includes('--stub');
const tIdx = args.indexOf('--target');
const targetArg = tIdx >= 0 ? args[tIdx + 1] : undefined;

if (wantStub) {
  stub();
} else {
  populate(parseTarget(targetArg));
}
