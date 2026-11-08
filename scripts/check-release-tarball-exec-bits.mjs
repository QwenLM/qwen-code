#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Release gate for the exec bits of spawned vendored binaries in the
 * published CLI tarball (#12668).
 *
 * From 0.24.4 on the release published the generated CLI with `pnpm publish`,
 * whose packer writes 0755 for the entries named in the manifest's `bin` map
 * and 0644 for every other entry — so every vendored binary shipped without
 * an exec bit and a fresh install could not spawn it. `npm pack` keeps the
 * working-tree mode. This gate packs the prepared CLI with the same packer
 * the publish step uses and reads the modes recorded in the archive (no
 * extraction, so the umask cannot mask them), failing when any spawned
 * vendored binary lacks all three exec bits: a root-owned
 * `sudo npm install -g` is only executable by others with 0111 set, and the
 * runtime heals cannot chmod such an install.
 *
 * Usage: node scripts/check-release-tarball-exec-bits.mjs [package-dir]
 * Exit 0 = every spawned vendored binary keeps 0111; exit 1 = one does not,
 * or the gate could not measure (a Windows host, an unreadable directory, no
 * tarball, or no spawned vendored binaries). It never passes vacuously.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vendored binaries the CLI spawns directly, one expected entry per platform
// directory. Platform membership comes from the directory name alone: a
// platform directory whose binary is missing is itself a broken package and
// must fail the gate, never shrink the expected set. `rg.exe` is a 0644
// Windows binary by design, so `-win32` platforms are excluded;
// `landlock-run/src` is a source directory, not a platform, and is excluded
// by name. Any future vendored binary spawned the same way belongs here —
// its runtime heal shares the ripgrep heal's limit of being unable to chmod
// a root-owned or read-only install (#12668).
const SPAWNED_VENDORED_BINARIES = [
  {
    root: ['vendor', 'ripgrep'],
    leaf: 'rg',
    skip: (platform) => platform.endsWith('-win32'),
  },
  {
    root: ['vendor', 'landlock-run'],
    leaf: 'qwen-landlock-run',
    skip: (platform) => platform === 'src',
  },
];

// read/write/exec bit values for owner, group and other, in tar order.
const MODE_CLASSES = [
  [0o400, 0o200, 0o100],
  [0o40, 0o20, 0o10],
  [0o4, 0o2, 0o1],
];

/**
 * Converts a tar listing's symbolic mode (`-rwxr-xr-x`) to its permission
 * bits, so the assertion reads the record instead of the extracted file.
 */
function symbolicModeToOctal(mode) {
  if (!/^[-bcdlps][rwxstST-]{9}$/.test(mode)) {
    throw new Error(`unparsable tar entry mode: ${mode}`);
  }
  let bits = 0;
  for (let index = 0; index < MODE_CLASSES.length; index += 1) {
    const [read, write, exec] = MODE_CLASSES[index];
    const triplet = mode.slice(1 + index * 3, 4 + index * 3);
    if (triplet[0] === 'r') bits |= read;
    if (triplet[1] === 'w') bits |= write;
    // A lowercase `s`/`t` sets a special bit that also carries the class's
    // exec bit; the uppercase `S`/`T` forms leave it unset.
    if ('xst'.includes(triplet[2])) bits |= exec;
  }
  return bits;
}

/** Maps every regular-file entry in the archive to its recorded mode. */
function listTarEntryModes(tarball) {
  const listing = spawnSync('tar', ['-tvzf', tarball], { encoding: 'utf8' });
  if (listing.status !== 0) {
    throw new Error(
      `tar -tvzf ${tarball} failed: ${String(listing.stderr ?? '').trim()}`,
    );
  }
  const entries = new Map();
  for (const line of listing.stdout.split('\n')) {
    if (line[0] !== '-') continue;
    const name = line.trim().split(/\s+/).pop();
    if (name !== undefined) {
      entries.set(name, symbolicModeToOctal(line.slice(0, 10)));
    }
  }
  return entries;
}

/**
 * Packs `packageDir` the way the release publishes it and asserts every
 * spawned vendored binary entry keeps 0111. Throws with a per-entry report
 * otherwise.
 */
export function checkReleaseTarballExecBits(packageDir = 'dist') {
  if (process.platform === 'win32') {
    throw new Error(
      'the release tarball exec-bit gate cannot read POSIX tar entry modes on Windows',
    );
  }
  const expected = expectedSpawnedEntries(packageDir);
  const destination = mkdtempSync(join(tmpdir(), 'release-tarball-exec-bits-'));
  try {
    const tarball = pack(packageDir, destination);
    const actual = listTarEntryModes(tarball);
    const problems = [];
    for (const name of expected) {
      const mode = actual.get(name);
      if (mode === undefined) {
        problems.push(`${name}: missing from the packed tarball`);
      } else if ((mode & 0o111) !== 0o111) {
        problems.push(`${name}: ${octal(mode)} lacks an exec bit`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        [
          `the CLI tarball ships a spawned vendored binary without all exec bits (${packageDir})`,
          ...problems.map((problem) => `  ${problem}`),
        ].join('\n'),
      );
    }
    return {
      tarball,
      entries: expected.map((name) => [name, actual.get(name)]),
    };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function expectedSpawnedEntries(packageDir) {
  const expected = [];
  for (const spec of SPAWNED_VENDORED_BINARIES) {
    const root = join(packageDir, ...spec.root);
    let platforms;
    try {
      platforms = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const platform of platforms) {
      if (!platform.isDirectory() || spec.skip(platform.name)) continue;
      expected.push(
        `package/${spec.root.join('/')}/${platform.name}/${spec.leaf}`,
      );
    }
  }
  if (expected.length === 0) {
    throw new Error(
      `no spawned vendored executables under ${join(packageDir, 'vendor')}; the gate refuses to pass vacuously`,
    );
  }
  expected.sort();
  return expected;
}

function pack(packageDir, destination) {
  const packed = spawnSync('npm', ['pack', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  if (packed.status !== 0) {
    throw new Error(
      `npm pack failed in ${packageDir}: ${String(packed.stderr ?? '').trim()}`,
    );
  }
  const tarballs = readdirSync(destination).filter((name) =>
    name.endsWith('.tgz'),
  );
  if (tarballs.length !== 1) {
    throw new Error(
      `npm pack in ${packageDir} produced ${tarballs.length} tarballs; expected one`,
    );
  }
  return join(destination, tarballs[0]);
}

function octal(bits) {
  return `0${bits.toString(8).padStart(3, '0')}`;
}

function main(argv) {
  const packageDir = argv[2] ?? 'dist';
  try {
    const { tarball, entries } = checkReleaseTarballExecBits(packageDir);
    process.stdout.write(
      `ok: ${entries.length} spawned vendored binaries keep 0111 in ${tarball} (${packageDir})\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`::error::${message.split('\n')[0]}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv);
}
