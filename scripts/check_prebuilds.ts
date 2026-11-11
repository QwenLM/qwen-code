#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pre-flight check: verifies that all native prebuilds and portable runtime
 * assets required by a given `bun --compile --target=...` are present under
 * node_modules, and that the ripgrep vendor binary for the target's (arch, os)
 * is on disk.
 *
 * Why a dedicated check: generate-embedded-natives.ts only WARNs on missing
 * packages and still produces a (partial) binary. That's fine during local
 * iteration but dangerous in CI — a release artifact missing sharp or Photon
 * would fail at runtime on the first image tool call, not at build time. This
 * script fails loud and early with an install hint.
 *
 * Usage:
 *   bun run scripts/check_prebuilds.ts --target bun-linux-x64-musl
 *   bun run scripts/check_prebuilds.ts          # checks host platform
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

type Target = {
  nodePlatform: 'darwin' | 'linux' | 'win32';
  nodeArch: 'x64' | 'arm64';
  libc: 'glibc' | 'musl';
  raw: string;
};

function parseTarget(t: string | undefined): Target {
  if (!t) {
    return {
      nodePlatform: process.platform as Target['nodePlatform'],
      nodeArch: process.arch as Target['nodeArch'],
      libc: 'glibc',
      raw: `host(${process.platform}-${process.arch})`,
    };
  }
  const m = t.match(
    /^bun-(darwin|linux|windows)-(x64|arm64|aarch64)(?:-(musl|baseline))?/,
  );
  if (!m) throw new Error(`Unsupported --target: ${t}`);
  const os = m[1] === 'windows' ? 'win32' : (m[1] as 'darwin' | 'linux');
  const arch = m[2] === 'aarch64' ? 'arm64' : (m[2] as 'x64' | 'arm64');
  const libc = m[3] === 'musl' ? 'musl' : 'glibc';
  if (libc === 'musl' && os !== 'linux') {
    throw new Error(`-musl suffix only valid for linux targets; got ${t}`);
  }
  return { nodePlatform: os, nodeArch: arch, libc, raw: t };
}

type RequirementStatus = 'ok' | 'missing' | 'warn';

type Requirement = {
  /** Display name for log output. */
  label: string;
  /** Absolute path expected on disk. */
  path: string;
  /** Severity — warn keeps the overall status as "passed with warnings". */
  severity: 'required' | 'warn';
  /** Extra context shown when the check fails or warns. */
  note?: string;
  status?: RequirementStatus;
};

// Matches native binaries including Linux versioned sonames:
//   sharp-darwin-arm64.node       → .node$
//   libvips-cpp.8.17.3.dylib      → .dylib$
//   libvips-cpp.so.8.17.3         → .so followed by .N.N.N (Linux soname)
//   msvcp.dll                     → .dll$
const NATIVE_BINARY_RE = /\.(node|so|dylib|dll)(\.\d+)*$/i;

function dirHasBinary(dir: string): boolean {
  // Good-enough heuristic: recursively scan for a non-empty file whose name
  // looks like a native binary. Catches half-published packages (manifest
  // only, no actual prebuild) without having to hard-code every filename.
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (NATIVE_BINARY_RE.test(entry.name)) {
        if (statSync(abs).size > 0) return true;
      }
      // spawn-helper has no extension but is an executable binary.
      if (entry.name === 'spawn-helper' && statSync(abs).size > 0) return true;
    }
  }
  return false;
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

function buildRequirements(t: Target): Requirement[] {
  const nm = path.join(root, 'node_modules');
  const platPrefix = `${t.nodePlatform}-${t.nodeArch}`;
  const sharpPrefix =
    t.nodePlatform === 'linux' && t.libc === 'musl'
      ? `linuxmusl-${t.nodeArch}`
      : platPrefix;

  const reqs: Requirement[] = [
    {
      label: `@lydell/node-pty-${platPrefix}`,
      path: path.join(nm, '@lydell', `node-pty-${platPrefix}`),
      severity: 'required',
      // Upstream doesn't publish a separate musl variant. Empirically the
      // linux-* prebuild loads on recent Alpine/distroless, but it's an ABI
      // gamble — flag it so CI runs catch any regression.
      note:
        t.libc === 'musl'
          ? '@lydell/node-pty has no musl-specific variant; the linux-* prebuild is used on Alpine. Smoke-test on a musl image before shipping.'
          : undefined,
    },
    {
      label: `@img/sharp-${sharpPrefix}`,
      path: path.join(nm, '@img', `sharp-${sharpPrefix}`),
      severity: 'required',
    },
    {
      label: '@silvia-odwyer/photon-node/photon_rs.js',
      path: path.join(nm, '@silvia-odwyer', 'photon-node', 'photon_rs.js'),
      severity: 'required',
      note: 'Run `npm install` if the portable image fallback is missing.',
    },
    {
      label: '@silvia-odwyer/photon-node/photon_rs_bg.wasm',
      path: path.join(nm, '@silvia-odwyer', 'photon-node', 'photon_rs_bg.wasm'),
      severity: 'required',
      note: 'Run `npm install` if the portable image fallback is missing.',
    },
  ];

  const sharpLibvipsPkg = `@img/sharp-libvips-${sharpPrefix}`;
  if (hasOptionalDependency('sharp', sharpLibvipsPkg)) {
    reqs.push({
      label: sharpLibvipsPkg,
      path: path.join(nm, '@img', `sharp-libvips-${sharpPrefix}`),
      severity: 'required',
    });
  }

  if (t.nodePlatform === 'darwin') {
    reqs.push(
      {
        label: `@crosscopy/clipboard-darwin-${t.nodeArch}`,
        path: path.join(nm, '@crosscopy', `clipboard-darwin-${t.nodeArch}`),
        severity: 'required',
      },
      {
        label: `@qwen-code/native-modifiers-darwin-${t.nodeArch}`,
        path: path.join(
          root,
          'packages/cli/src/native-modifiers/prebuilds',
          `darwin-${t.nodeArch}`,
          'modifiers.node',
        ),
        severity: 'required',
        note: 'Run `npm run build:native-modifiers -w @qwen-code/qwen-code` on macOS if missing.',
      },
    );
  }

  const archOsDir = `${t.nodeArch}-${t.nodePlatform}`;
  const rgName = t.nodePlatform === 'win32' ? 'rg.exe' : 'rg';
  reqs.push({
    label: `vendor/ripgrep/${archOsDir}/${rgName}`,
    path: path.join(
      root,
      'packages/core/dist/vendor/ripgrep',
      archOsDir,
      rgName,
    ),
    severity: 'required',
    note: 'Run `npm run build` (triggers the ripgrep postinstall vendor step) if missing.',
  });

  return reqs;
}

function installHint(t: Target): string {
  const base = `pnpm install --config.supportedArchitectures.os[]=${t.nodePlatform} --config.supportedArchitectures.cpu[]=${t.nodeArch}`;
  return t.libc === 'musl'
    ? `${base} --config.supportedArchitectures.libc[]=musl`
    : base;
}

function check(req: Requirement): RequirementStatus {
  if (!existsSync(req.path)) return 'missing';
  try {
    const st = statSync(req.path);
    if (st.isFile()) return st.size > 0 ? 'ok' : 'missing';
    if (!st.isDirectory()) return 'missing';
    return dirHasBinary(req.path) ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
}

const args = process.argv.slice(2);
const tIdx = args.indexOf('--target');
const target = parseTarget(tIdx >= 0 ? args[tIdx + 1] : undefined);

console.log(`check_prebuilds: target = ${target.raw}`);
const reqs = buildRequirements(target);

let missing = 0;
let warned = 0;
for (const req of reqs) {
  const status = check(req);
  req.status = status;
  if (status === 'ok') {
    console.log(`  ✓ ${req.label}`);
    if (req.note && req.severity === 'warn') {
      console.log(`    (note: ${req.note})`);
    }
    // Surface warn-level notes even on ok so operators see them.
    if (
      req.note &&
      req.severity === 'required' &&
      target.libc === 'musl' &&
      req.label.startsWith('@lydell/node-pty')
    ) {
      console.log(`    ⚠ ${req.note}`);
      warned++;
    }
    continue;
  }
  if (req.severity === 'warn') {
    console.log(`  ⚠ ${req.label} — missing (non-fatal)`);
    if (req.note) console.log(`    ${req.note}`);
    warned++;
    continue;
  }
  console.log(`  ✗ ${req.label} — missing`);
  console.log(`    at ${req.path}`);
  if (req.note) console.log(`    ${req.note}`);
  missing++;
}

if (missing > 0) {
  console.error(
    `\ncheck_prebuilds: ${missing} required prebuild(s) missing for ${target.raw}.`,
  );
  console.error(`Install hint: ${installHint(target)}`);
  process.exit(1);
}
console.log(
  `\ncheck_prebuilds: all required prebuilds present for ${target.raw}${
    warned ? ` (${warned} warning${warned === 1 ? '' : 's'})` : ''
  }.`,
);
