#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fail,
  isMainModule,
  parseArgs,
  parseSha256Sums,
  sha256File,
} from './release-script-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const HOSTED_INSTALLATION_ASSETS = [
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-standalone.sh'],
    output: 'install-qwen-standalone.sh',
    mode: 0o755,
  },
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-standalone.bat'],
    output: 'install-qwen-standalone.bat',
    lineEndings: 'crlf',
  },
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-standalone.ps1'],
    output: 'install-qwen-standalone.ps1',
  },
  {
    sourcePath: ['scripts', 'installation', 'uninstall-qwen-standalone.sh'],
    output: 'uninstall-qwen-standalone.sh',
    mode: 0o755,
  },
  {
    sourcePath: ['scripts', 'installation', 'uninstall-qwen-standalone.ps1'],
    output: 'uninstall-qwen-standalone.ps1',
  },
];
const HOSTED_INSTALLATION_ASSET_NAMES = HOSTED_INSTALLATION_ASSETS.map(
  ({ output }) => output,
);
/** Regex guards that verify each installer script contains required behaviors.
 *  Build fails if a pattern is missing, preventing broken entrypoints from shipping. */
const HOSTED_INSTALLER_BEHAVIOR_PATTERNS = {
  'install-qwen-standalone.sh': [
    {
      name: 'QWEN_INSTALL_VERSION',
      pattern: /QWEN_INSTALL_VERSION/,
    },
    {
      name: '--version parser',
      pattern: /--version\)|--version=\*\)/,
    },
  ],
  'install-qwen-standalone.bat': [
    {
      name: 'QWEN_INSTALL_VERSION',
      pattern: /QWEN_INSTALL_VERSION/,
    },
    {
      name: '--version parser',
      pattern: /ARG_KEY!"=="--version"|"%~1"=="--version"/,
    },
  ],
  'install-qwen-standalone.ps1': [
    {
      name: 'argument forwarding',
      pattern: /& \$qwenInstallerPath @args/,
    },
    {
      name: 'SHA256SUMS verification',
      pattern: /SHA256SUMS/,
    },
    {
      name: 'bat checksum verification',
      pattern: /Get-FileHash/,
    },
    {
      name: 'QWEN_INSTALL_VERSION documentation',
      pattern: /QWEN_INSTALL_VERSION/,
    },
  ],
  'uninstall-qwen-standalone.sh': [
    {
      name: 'standalone directory guard',
      pattern: /is_qwen_standalone_install_dir/,
    },
    {
      name: 'PATH cleanup',
      pattern: /remove_shell_path_entry/,
    },
    {
      name: 'config preservation',
      pattern: /QWEN_UNINSTALL_PURGE/,
    },
  ],
  'uninstall-qwen-standalone.ps1': [
    {
      name: 'standalone directory guard',
      pattern: /Test-QwenStandaloneInstallDir/,
    },
    {
      name: 'PATH cleanup',
      pattern: /Remove-UserPathEntry/,
    },
    {
      name: 'current cmd shim cleanup',
      pattern: /Remove-CurrentCmdPathShim/,
    },
    {
      name: 'config preservation',
      pattern: /QWEN_UNINSTALL_PURGE/,
    },
  ],
};
// Narrow regexes that pin the default-version assignment to `latest`.
// Substring matching alone would let the word "latest" leak in via comments
// or help text even when the actual default has been changed. The patterns
// allow whitespace flexibility but require the literal default value.
const HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS = {
  'install-qwen-standalone.sh':
    /VERSION\s*=\s*"\$\{QWEN_INSTALL_VERSION:-latest\}"/,
  'install-qwen-standalone.bat': /set\s+"VERSION=latest"/,
};
// install-qwen-standalone.ps1 is a shim that downloads the .bat and forwards
// `@args` unchanged, so it has no VERSION variable to default-pin. Guard the
// shim instead with forbidden-content patterns: any attempt to hardcode a
// specific version (either by assigning $env:QWEN_INSTALL_VERSION or by
// prepending --version to the forwarded argument list) fails the build.
// Patterns are matched per non-comment line (PowerShell line comments start
// with `#`) so the usage examples in the header docstring keep working.
const HOSTED_INSTALLER_FORBIDDEN_PATTERNS = {
  'install-qwen-standalone.ps1': [
    {
      name: 'no hardcoded QWEN_INSTALL_VERSION assignment',
      pattern: /^\s*\$env:QWEN_INSTALL_VERSION\s*=/m,
    },
    {
      name: 'no hardcoded --version prepended to forwarded args',
      pattern:
        /^\s*&\s+\$qwenInstallerPath\s+(?:'--version'|"--version"|--version)/m,
    },
  ],
};
// SHA256SUMS is allowed in an existing output directory because every staging
// run rewrites it from scratch after copying the hosted installer assets.
const HOSTED_INSTALLATION_OUTPUT_NAMES = new Set([
  ...HOSTED_INSTALLATION_ASSET_NAMES,
  'SHA256SUMS',
]);

const ARG_DEFS = {
  '--out-dir': { key: 'outDir', type: 'value' },
  '--version': { key: 'version', type: 'value' },
};

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ARG_DEFS);
  if (args.help) {
    printUsage();
    return;
  }

  const outDir = path.resolve(
    args.outDir || path.join(rootDir, 'dist', 'installation'),
  );
  await buildHostedInstallationAssets(outDir, { version: args.version });
}

function printUsage() {
  console.log(`Usage: npm run package:hosted-installation -- [options]

Stages hosted installer entrypoint assets for CDN/OSS upload.

Options:
  --out-dir PATH        Output directory. Defaults to dist/installation.
  --version VERSION     Stamp the release version into copied installers so
                        they default to installing that version instead of
                        'latest'. Should match the release tag (e.g. v1.2.3).
  -h, --help            Show this help message.
`);
}

async function buildHostedInstallationAssets(outDir, options = {}) {
  const root = options.root || rootDir;
  const version = options.version || undefined;
  fs.mkdirSync(outDir, { recursive: true });
  assertNoUnexpectedHostedFiles(outDir);

  for (const asset of HOSTED_INSTALLATION_ASSETS) {
    const source = path.join(root, ...asset.sourcePath);
    if (!fs.existsSync(source)) {
      fail(`Hosted installer source asset not found: ${source}`);
    }
    assertHostedInstallerSource(source, asset.output);

    const destination = path.join(outDir, asset.output);
    copyHostedInstallationAsset(source, destination, asset);
    if (version) {
      stampVersionInAsset(destination, asset.output, version);
    }
    if (asset.mode !== undefined) {
      fs.chmodSync(destination, asset.mode);
    }
  }

  await writeHostedSha256Sums(outDir);
  await assertHostedInstallationAssetChecksums(outDir);
}

function assertNoUnexpectedHostedFiles(outDir) {
  const unexpected = fs
    .readdirSync(outDir)
    .filter((entryName) => !HOSTED_INSTALLATION_OUTPUT_NAMES.has(entryName))
    .sort();

  if (unexpected.length > 0) {
    fail(`Unexpected hosted installer asset: ${unexpected.join(', ')}`);
  }
}

function copyHostedInstallationAsset(source, destination, asset) {
  if (asset.lineEndings === 'crlf') {
    const contents = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(destination, contents.replace(/\r?\n/g, '\r\n'));
    return;
  }

  fs.copyFileSync(source, destination);
}

/**
 * Replaces the default 'latest' version in a copied installer asset with the
 * given release version so the hosted installer installs the tagged version.
 *
 * @param {string} filePath - Path to the copied asset on disk.
 * @param {string} assetName - Logical asset name (e.g. 'install-qwen-standalone.sh').
 * @param {string} version - Release version to stamp (e.g. 'v1.2.3' or '1.2.3').
 */
function stampVersionInAsset(filePath, assetName, version) {
  const replacements = {
    'install-qwen-standalone.sh': {
      from: 'VERSION="${QWEN_INSTALL_VERSION:-latest}"',
      to: `VERSION="\${QWEN_INSTALL_VERSION:-${version}}"`,
    },
    'install-qwen-standalone.bat': {
      from: 'set "VERSION=latest"',
      to: `set "VERSION=${version}"`,
    },
  };

  const replacement = replacements[assetName];
  if (!replacement) {
    return;
  }

  let contents = fs.readFileSync(filePath, 'utf8');
  if (!contents.includes(replacement.from)) {
    fail(
      `Cannot stamp version in ${assetName}: expected default version pattern not found`,
    );
  }
  contents = contents.replace(replacement.from, replacement.to);
  fs.writeFileSync(filePath, contents);
}

function assertHostedInstallerSource(source, output) {
  const contents = fs.readFileSync(source, 'utf8');
  const missing = (HOSTED_INSTALLER_BEHAVIOR_PATTERNS[output] || [])
    .filter(({ pattern }) => !pattern.test(contents))
    .map(({ name }) => name);
  if (missing.length > 0) {
    fail(
      `${output} is missing hosted installer behavior: ${missing.join(', ')}`,
    );
  }

  const defaultPattern = HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS[output];
  if (defaultPattern && !defaultPattern.test(contents)) {
    fail(
      `${output} default install version must be 'latest' for the hosted entrypoint`,
    );
  }

  const forbidden = (HOSTED_INSTALLER_FORBIDDEN_PATTERNS[output] || []).filter(
    ({ pattern }) => pattern.test(contents),
  );
  if (forbidden.length > 0) {
    fail(
      `${output} must not contain: ${forbidden.map(({ name }) => name).join(', ')}`,
    );
  }
}

async function writeHostedSha256Sums(outDir) {
  const lines = [];
  const assets = [...HOSTED_INSTALLATION_ASSETS].sort((left, right) =>
    left.output.localeCompare(right.output),
  );
  for (const { output } of assets) {
    const hash = await sha256File(path.join(outDir, output));
    lines.push(`${hash}  ${output}`);
  }
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

async function assertHostedInstallationAssetChecksums(outDir) {
  const checksumsPath = path.join(outDir, 'SHA256SUMS');
  const checksums = parseSha256Sums(fs.readFileSync(checksumsPath, 'utf8'));

  for (const { output } of HOSTED_INSTALLATION_ASSETS) {
    const expected = checksums.get(output);
    if (!expected) {
      fail(`Missing checksum entry for ${output}`);
    }

    const actual = await sha256File(path.join(outDir, output));
    if (actual !== expected) {
      fail(
        `Checksum mismatch for ${output}: expected ${expected}, got ${actual}`,
      );
    }
  }
}

export {
  HOSTED_INSTALLATION_ASSETS,
  HOSTED_INSTALLATION_ASSET_NAMES,
  assertHostedInstallationAssetChecksums,
  buildHostedInstallationAssets,
};
