/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const STANDALONE_ARCHIVE_PREFIX = 'qwen-code-';
const STANDALONE_ARCHIVE_EXTENSIONS = ['.tar.gz', '.zip'];

const INSTALLATION_ASSETS = [
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-with-source.sh'],
    output: 'install-qwen.sh',
    mode: 0o755,
  },
  // Hosted endpoint alias for install-qwen.sh; keep byte-for-byte identical.
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-with-source.sh'],
    output: 'install',
    mode: 0o755,
  },
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-with-source.bat'],
    output: 'install-qwen.bat',
  },
];

const INSTALLATION_ASSET_NAMES = INSTALLATION_ASSETS.map(
  ({ output }) => output,
);
const INSTALLATION_ASSET_NAME_SET = new Set(INSTALLATION_ASSET_NAMES);

function isStandaloneArchiveName(fileName) {
  return (
    fileName.startsWith(STANDALONE_ARCHIVE_PREFIX) &&
    STANDALONE_ARCHIVE_EXTENSIONS.some((extension) =>
      fileName.endsWith(extension),
    )
  );
}

function isInstallationAssetName(fileName) {
  return INSTALLATION_ASSET_NAME_SET.has(fileName);
}

function isReleaseChecksumAsset(fileName) {
  return isStandaloneArchiveName(fileName) || isInstallationAssetName(fileName);
}

export {
  INSTALLATION_ASSET_NAMES,
  INSTALLATION_ASSETS,
  isInstallationAssetName,
  isReleaseChecksumAsset,
  isStandaloneArchiveName,
};
