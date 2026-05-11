/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = await vi.importActual('node:fs');
const { execFileSync } = await vi.importActual('node:child_process');
const crypto = await vi.importActual('node:crypto');
const { tmpdir } = await vi.importActual('node:os');
const path = await vi.importActual('node:path');
const { pathToFileURL } = await vi.importActual('node:url');
const readScript = (path) => readFileSync(path, 'utf8');
const standaloneReleaseScriptUrl = pathToFileURL(
  path.resolve('scripts/build-standalone-release.js'),
).href;
const standalonePackageScriptUrl = pathToFileURL(
  path.resolve('scripts/create-standalone-package.js'),
).href;
const hostedInstallationScriptUrl = pathToFileURL(
  path.resolve('scripts/build-hosted-installation-assets.js'),
).href;
const installationReleaseVerificationScriptUrl = pathToFileURL(
  path.resolve('scripts/verify-installation-release.js'),
).href;
const releaseAssetConfigUrl = pathToFileURL(
  path.resolve('scripts/release-asset-config.js'),
).href;
const releaseScriptUtilsUrl = pathToFileURL(
  path.resolve('scripts/release-script-utils.js'),
).href;
// These E2E cases execute the Unix shell installer and POSIX symlink behavior.
// Windows batch behavior has separate Windows-only E2E coverage below.
const itOnUnix = process.platform === 'win32' ? it.skip : it;
const itOnWindows = process.platform === 'win32' ? it : it.skip;
const WINDOWS_INSTALLER_TEST_TIMEOUT = 15_000;

describe('installation scripts', () => {
  it('keeps the Linux/macOS installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.sh',
    );

    expect(script).not.toContain('install_nvm');
    expect(script).not.toContain('install_nvm.sh');
    expect(script).not.toContain('nvm install');
    expect(script).not.toContain('NVM_NODEJS_ORG_MIRROR');
    expect(script).not.toContain('npm config set prefix');
    expect(script).not.toContain('clean_npmrc_conflict');
    expect(script).not.toContain('.npmrc');
    expect(script).not.toContain('.npm-global');
    expect(script).not.toMatch(/^\s*exec\s+qwen\s*$/m);
    expect(script).not.toContain('--print-env');
    expect(script).not.toContain('brew install node@20');
    expect(script).toContain('brew install node');
    expect(script).toContain(
      '--source may only contain letters, numbers, dot, underscore, or dash',
    );
    expect(script).toContain('Node.js 22 or newer is required');
    expect(script).toContain(
      'npm install -g @qwen-code/qwen-code@latest --registry',
    );
    expect(script).toContain('You can now run: qwen');
  });

  it('supports code-server-style standalone install on Linux/macOS', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.sh',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--mirror MIRROR');
    expect(script).toContain('--base-url URL');
    expect(script).toContain('--archive PATH');
    expect(script).toContain('install_standalone()');
    expect(script).toContain('install_npm()');
    expect(script).toContain('detect_target()');
    expect(script).toContain('verify_checksum()');
    expect(script).toContain('SHA256SUMS not found; cannot verify archive');
    expect(script).toContain('awk -v archive_name');
    expect(script).not.toContain(
      'grep -E "(^|[[:space:]])[*]?${archive_name}$"',
    );
    expect(script).toContain('validate_archive_contents()');
    expect(script).toContain('Archive contains unsafe path');
    expect(script).toContain(
      'Archive contains unsafe path with control character',
    );
    expect(script).toContain('qwen-code-${target}');
    expect(script).toContain('*.tar.xz)');
    expect(script).toContain('METHOD="${METHOD:-detect}"');
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('standalone_status=$?');
    expect(script).toContain('[[ "${standalone_status}" -eq 2 ]]');
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).not.toContain('ln -sf "${INSTALL_LIB_DIR}/bin/qwen"');
    expect(script).toContain('shell_quote()');
    expect(script).toContain('exec ${quoted_qwen_bin} "\\$@"');
    expect(script).toContain('validate_version()');
    expect(script).toContain('validate_install_path');
    expect(script).toContain('validate_https_url "${NPM_REGISTRY}"');
    expect(script).toContain('qwen-code/node/bin/node');
    expect(script).toContain('Archive contains symlinks; refusing to install');
    expect(script).toContain('not a Qwen Code standalone install');
    expect(script).toContain('is_qwen_standalone_install_dir()');
    expect(script).toContain(
      '"name"[[:space:]]*:[[:space:]]*"@qwen-code/qwen-code"',
    );
    expect(script).toContain(
      '"target"[[:space:]]*:[[:space:]]*"(darwin|linux)-(arm64|x64)"',
    );
    expect(script).toContain(
      'Return 2 only when a standalone archive is unavailable',
    );
    expect(script).toContain('npm fallback also failed');
    expect(script).toContain(
      'unzip -q "${archive_path}" -d "${destination}" || return 1',
    );
    expect(script).toContain(
      'tar -xzf "${archive_path}" -C "${destination}" || return 1',
    );
    expect(script).toContain('wget -q --tries=3 "${url}" -O "${destination}"');
    expect(script).toContain('TEMP_DIRS+=');
    expect(script).not.toContain('-print -quit');
  });

  it('keeps the Windows installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.bat',
    );

    expect(script).not.toContain('InstallNodeJSDirectly');
    expect(script).not.toContain('node-v!NODE_VERSION!');
    expect(script).not.toContain('msiexec');
    expect(script).not.toContain('Invoke-WebRequest');
    expect(script).not.toContain('PowerShell (Administrator)');
    expect(script).not.toContain('echo INFO: Installation source: %SOURCE%');
    expect(script).not.toMatch(/^\s*call\s+qwen\s*$/m);
    expect(script).toContain(':ValidateSource');
    expect(script).toContain(':PrintUsage');
    expect(script).toContain('findstr /R');
    expect(script).toContain(
      '--source may only contain letters, numbers, dot, underscore, or dash',
    );
    expect(script).toContain('Node.js 22 or newer is required');
    expect(script).toContain('Please install Node.js');
    expect(script).toContain(
      'npm install -g @qwen-code/qwen-code@latest --registry',
    );
    expect(script).toContain('You can now run: qwen');
  });

  it('supports code-server-style standalone install on Windows', () => {
    const script = readScript(
      'scripts/installation/install-qwen-with-source.bat',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--mirror MIRROR');
    expect(script).toContain('--base-url URL');
    expect(script).toContain('--archive PATH');
    expect(script).toContain(':InstallStandalone');
    expect(script).toContain(':InstallNpm');
    expect(script).toContain(':VerifyChecksum');
    expect(script).toContain('SHA256SUMS not found; cannot verify archive');
    expect(script).toContain('Get-FileHash -Algorithm SHA256');
    expect(script).toContain('tokens=1,2');
    expect(script).toContain('CHECKSUM_NAME');
    expect(script).toContain('if "!CHECKSUM_NAME!"=="!ARCHIVE_NAME!"');
    expect(script).not.toContain('findstr /C:"!ARCHIVE_NAME!"');
    expect(script).not.toContain('certutil -hashfile');
    expect(script).toContain('qwen-code-win-x64.zip');
    expect(script).toContain(':ValidateArchiveContents');
    expect(script).toContain('Archive contains unsafe path entries');
    expect(script).toContain('System.IO.Compression.FileSystem');
    expect(script).toContain('[IO.Compression.ZipFile]::OpenRead');
    expect(script).toContain('[IO.Path]::GetRandomFileName()');
    expect(script).not.toContain('qwen-code-install-%RANDOM%%RANDOM%');
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('$env:QWEN_DOWNLOAD_URL');
    expect(script).toContain('$env:QWEN_ARCHIVE_FILE');
    expect(script).toContain(
      'if defined QWEN_INSTALL_ROOT set "INSTALL_BASE=!QWEN_INSTALL_ROOT!"',
    );
    expect(script).not.toContain('%QWEN_INSTALL_ROOT%');
    expect(script).toContain('set "QWEN_VALIDATE_INSTALL_BASE=!INSTALL_BASE!"');
    expect(script).toContain(
      'installer options contain unsafe command characters',
    );
    expect(script).toContain('[char[]](10,13,33,34');
    expect(script).toContain('if "!INSTALL_BASE:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_DIR:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_BIN_DIR:~1,2!"==":/"');
    expect(script).toContain(':ValidateVersion');
    expect(script).not.toContain('^v*');
    expect(script).toContain('/C:"^v[0-9]');
    expect(script).toContain(':EnsureDir');
    expect(script).toContain('Failed to create directory');
    expect(script).toContain('ConvertFrom-Json');
    expect(script).toContain("$data.name -ne '@qwen-code/qwen-code'");
    expect(script).toContain("$data.target -notmatch '^win-(x64|arm64)$'");
    expect(script).toContain(
      'call :ValidateHttpsUrlVar "NPM_REGISTRY" "--registry"',
    );
    expect(script).toContain("$ErrorActionPreference = 'Stop'; try");
    expect(script).toContain(
      '[Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13',
    );
    expect(script).toContain(
      '$request = [Net.WebRequest]::Create($env:QWEN_CHECK_URL)',
    );
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('set "STANDALONE_STATUS=!ERRORLEVEL!"');
    expect(script).toContain('if !STANDALONE_STATUS! EQU 2');
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).toContain('ERROR: Unknown option.');
    expect(script).not.toContain('ERROR: Unknown option: %~1');
    expect(script).toContain('qwen-code\\node\\node.exe');
    expect(script).toContain('Archive contains symlinks or reparse points');
    expect(script).toContain('WARNING: Failed to restore previous install');
    expect(script).toContain('WARNING: Failed to remove failed install');
    expect(script).toContain('QWEN_INSTALL_ROOT');
    expect(script).toContain('npm fallback also failed');
  });
});

describe('standalone release packaging', () => {
  it('defines a standalone packaging script', () => {
    const packageJson = JSON.parse(readScript('package.json'));

    expect(packageJson.scripts['package:standalone']).toBe(
      'node scripts/create-standalone-package.js',
    );
    expect(packageJson.scripts['package:standalone:release']).toBe(
      'node scripts/build-standalone-release.js',
    );
    expect(packageJson.scripts['package:hosted-installation']).toBe(
      'node scripts/build-hosted-installation-assets.js',
    );
    expect(packageJson.scripts['verify:installation-release']).toBe(
      'node scripts/verify-installation-release.js',
    );
    // Per-release installer publishing was removed in favor of a stable hosted
    // entrypoint with --version pinning, so no package:installation-assets
    // script should exist.
    expect(packageJson.scripts['package:installation-assets']).toBeUndefined();
    expect(existsSync('scripts/create-standalone-package.js')).toBe(true);
    expect(existsSync('scripts/build-standalone-release.js')).toBe(true);
    expect(existsSync('scripts/build-hosted-installation-assets.js')).toBe(
      true,
    );
    expect(existsSync('scripts/verify-installation-release.js')).toBe(true);
    expect(existsSync('scripts/build-installation-assets.js')).toBe(false);
    expect(existsSync('scripts/release-asset-config.js')).toBe(true);
    expect(existsSync('scripts/release-script-utils.js')).toBe(true);

    const packageScript = readScript('scripts/create-standalone-package.js');
    expect(packageScript).toContain('Copyright 2025 Qwen Team');
    expect(packageScript).toContain("'bundled/qc-helper/docs'");
    expect(packageScript).toContain('DIST_ALLOWED_ENTRIES');
    expect(packageScript).toContain('Unexpected dist asset');
    expect(packageScript).toContain('topLevelDistEntryForPath(outDir)');
    expect(packageScript).toContain("path.join(distDir, 'package.json')");
    expect(packageScript).toContain(
      "fs.copyFileSync(packageJsonPath, path.join(packageRoot, 'package.json'))",
    );
    expect(packageScript).toContain('validateNodeRuntime');
    expect(packageScript).toContain('copyNodeRuntimeEntry');
    expect(packageScript).toContain('symlink cycle');
    expect(packageScript).toContain('refusing to write empty SHA256SUMS');
    expect(packageScript).toContain('--skip-checksums');
    expect(packageScript).toContain('dereference: true');
    expect(packageScript).toContain('Expand-Archive');
    expect(packageScript).toContain('Compress-Archive');
    expect(packageScript).toContain('Rebuild SHA256SUMS from scratch');
    expect(packageScript).toContain('Promise.all(');
    expect(packageScript).toContain(
      "import { isStandaloneArchiveName } from './release-asset-config.js';",
    );
    expect(packageScript).toContain(
      "import {\n  fail,\n  isMainModule,\n  parseCliArgs,\n  sha256File,\n} from './release-script-utils.js';",
    );
    expect(packageScript).toContain(
      'parseCliArgs(process.argv.slice(2), CLI_OPTIONS',
    );
    expect(packageScript).not.toContain('function parseArgs');

    const releaseScript = readScript('scripts/build-standalone-release.js');
    expect(releaseScript).toContain('Copyright 2025 Qwen Team');
    expect(releaseScript).toContain('normalizeNodeVersion(');
    expect(releaseScript).toContain("version.replace(/^v/i, '')");
    expect(releaseScript).toContain('https://nodejs.org/dist/v${nodeVersion}');
    expect(releaseScript).toContain('SHASUMS256.txt');
    expect(releaseScript).toContain('verifyNodeArchive');
    expect(releaseScript).toContain(
      'EXPECTED_ARCHIVE_COUNT = RELEASE_TARGETS.length',
    );
    expect(releaseScript).toContain('nodeArchiveExtension');
    expect(releaseScript).toContain('expectedArchiveNames');
    expect(releaseScript).toContain('standaloneArchiveName(qwenTarget)');
    expect(releaseScript).toContain('TARGETS.get(qwenTarget)');
    expect(releaseScript).toContain('scripts/create-standalone-package.js');
    expect(releaseScript).toContain('--skip-checksums');
    expect(releaseScript).toContain('writeSha256Sums(outDir)');
    expect(releaseScript).toContain('Promise.allSettled(');
    expect(releaseScript).toContain(
      "import { isStandaloneArchiveName } from './release-asset-config.js';",
    );
    expect(releaseScript).toContain(
      'parseCliArgs(process.argv.slice(2), CLI_OPTIONS',
    );
    expect(releaseScript).not.toContain('function parseArgs');

    const hostedInstallScript = readScript(
      'scripts/build-hosted-installation-assets.js',
    );
    expect(hostedInstallScript).toContain('Copyright 2025 Qwen Team');
    expect(hostedInstallScript).toContain('buildHostedInstallationAssets');
    expect(hostedInstallScript).toContain('HOSTED_INSTALLATION_ASSETS');
    expect(hostedInstallScript).not.toContain("output: 'install'");

    const releaseVerifyScript = readScript(
      'scripts/verify-installation-release.js',
    );
    expect(releaseVerifyScript).toContain('Copyright 2025 Qwen Team');
    expect(releaseVerifyScript).toContain('verifyReleaseDirectory');
    expect(releaseVerifyScript).toContain('verifyReleaseBaseUrl');
    expect(releaseVerifyScript).toContain('EXPECTED_RELEASE_ASSET_NAMES');
    expect(releaseVerifyScript).toContain('EXPECTED_STANDALONE_ARCHIVE_NAMES');
    // The verifier targets only standalone archives + SHA256SUMS; hosted
    // installer scripts have their own staging path and are intentionally
    // not part of the GitHub release surface. Asserting absence of the
    // alias / installer-asset *helper functions* is enough — comments may
    // legitimately reference the hosted filenames as context.
    expect(releaseVerifyScript).not.toContain('INSTALLATION_ASSET_NAMES');
    expect(releaseVerifyScript).not.toContain('isReleaseChecksumAsset');
    expect(releaseVerifyScript).not.toContain('assertInstallAliasMatches');
    expect(releaseVerifyScript).not.toContain('assertInstallAliasBuffersMatch');
    expect(releaseVerifyScript).not.toContain('assertUnixInstallersExecutable');

    const releaseAssetConfig = readScript('scripts/release-asset-config.js');
    expect(releaseAssetConfig).toContain('Copyright 2025 Qwen Team');
    expect(releaseAssetConfig).toContain('isStandaloneArchiveName');
    // Per-release installer publishing was removed; the config no longer
    // exports installer-asset helpers.
    expect(releaseAssetConfig).not.toContain('INSTALLATION_ASSETS');
    expect(releaseAssetConfig).not.toContain('isInstallationAssetName');
    expect(releaseAssetConfig).not.toContain('isReleaseChecksumAsset');

    const releaseScriptUtils = readScript('scripts/release-script-utils.js');
    expect(releaseScriptUtils).toContain('Copyright 2025 Qwen Team');
    expect(releaseScriptUtils).toContain('function parseCliArgs');
    expect(releaseScriptUtils).toContain('function parseSha256Sums');
    expect(releaseScriptUtils).toContain('async function sha256File');
    expect(releaseScriptUtils).toContain('function readOptionValue');
    expect(releaseScriptUtils).toContain('function isMainModule');
  });

  it('parses release script CLI options through the shared helper', async () => {
    const { parseCliArgs } = await import(releaseScriptUtilsUrl);

    const args = parseCliArgs(
      ['--name', 'qwen', '--flag', '-h'],
      {
        '--name': { name: 'name' },
        '--flag': { name: 'flag', type: 'boolean' },
        '-h': { name: 'help', type: 'boolean' },
      },
      { flag: false, help: false, name: undefined },
    );

    expect(args).toEqual({
      flag: true,
      help: true,
      name: 'qwen',
    });
    expect(() => parseCliArgs(['--unknown'], {}, {})).toThrow(
      /Unknown option: --unknown/,
    );
    expect(() =>
      parseCliArgs(['--name'], { '--name': { name: 'name' } }, {}),
    ).toThrow(/--name requires a value/);

    const equalsArgs = parseCliArgs(
      ['--name=qwen', '--flag'],
      {
        '--name': { name: 'name' },
        '--flag': { name: 'flag', type: 'boolean' },
      },
      { flag: false, name: undefined },
    );
    expect(equalsArgs).toEqual({ flag: true, name: 'qwen' });

    expect(() =>
      parseCliArgs(
        ['--flag=true'],
        { '--flag': { name: 'flag', type: 'boolean' } },
        {},
      ),
    ).toThrow(/--flag does not accept a value/);

    expect(() =>
      parseCliArgs(['--name='], { '--name': { name: 'name' } }, {}),
    ).toThrow(/--name requires a value/);
  });

  it('loads the standalone release packaging helper', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/build-standalone-release.js', '--help'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('package:standalone:release');
    expect(output).toContain('--node-version VERSION');
  });

  it('normalizes Node.js versions passed to the release helper', async () => {
    const { normalizeNodeVersion } = await import(standaloneReleaseScriptUrl);

    expect(normalizeNodeVersion('v20.19.0')).toBe('20.19.0');
    expect(normalizeNodeVersion('20.19.0')).toBe('20.19.0');
  });

  it('loads the hosted installation asset staging helper', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/build-hosted-installation-assets.js', '--help'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('package:hosted-installation');
    expect(output).toContain('--out-dir PATH');
  });

  it('loads the installation release verification helper', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/verify-installation-release.js', '--help'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('verify:installation-release');
    expect(output).toContain('--dir PATH');
    expect(output).toContain('--base-url URL');
  });

  it('rejects invalid installation release verification CLI arguments', () => {
    const expectFail = (args, expectedOutput) => {
      let caughtError;
      try {
        execFileSync(process.execPath, args, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeTruthy();
      expect(
        [
          caughtError?.message,
          caughtError?.stdout?.toString(),
          caughtError?.stderr?.toString(),
        ].join('\n'),
      ).toMatch(expectedOutput);
    };

    expectFail(
      ['scripts/verify-installation-release.js', '--unknown'],
      /Unknown option: --unknown/,
    );
    expectFail(
      ['scripts/verify-installation-release.js', '--dir'],
      /--dir requires a value/,
    );
    expectFail(
      [
        'scripts/verify-installation-release.js',
        '--dir',
        '/tmp',
        '--base-url',
        'https://example.com/r/',
      ],
      /Pass --dir or --base-url, not both/,
    );
  });

  it('exposes only standalone archive classification', async () => {
    const config = await import(releaseAssetConfigUrl);

    expect(config.isStandaloneArchiveName('qwen-code-linux-x64.tar.gz')).toBe(
      true,
    );
    expect(config.isStandaloneArchiveName('qwen-code-win-x64.zip')).toBe(true);
    expect(config.isStandaloneArchiveName('install-qwen.sh')).toBe(false);
    // Per-release installer publishing helpers must no longer be exported.
    expect(config.INSTALLATION_ASSET_NAMES).toBeUndefined();
    expect(config.isInstallationAssetName).toBeUndefined();
    expect(config.isReleaseChecksumAsset).toBeUndefined();
  });

  it('parses Node.js SHASUMS entries', async () => {
    const { parseChecksums } = await import(standaloneReleaseScriptUrl);

    const checksums = parseChecksums(
      [
        'a'.repeat(64) + '  node-v20.19.0-linux-x64.tar.xz',
        'b'.repeat(64) + ' *node-v20.19.0-win-x64.zip',
        '',
      ].join('\n'),
    );

    expect(checksums.get('node-v20.19.0-linux-x64.tar.xz')).toBe(
      'a'.repeat(64),
    );
    expect(checksums.get('node-v20.19.0-win-x64.zip')).toBe('b'.repeat(64));
  });

  it('validates standalone release checksum output', async () => {
    const { assertStandaloneOutput, RELEASE_TARGETS } = await import(
      standaloneReleaseScriptUrl
    );
    const { TARGETS } = await import(standalonePackageScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-test-'));

    try {
      const lines = RELEASE_TARGETS.map(({ qwenTarget }) => {
        const extension = TARGETS.get(qwenTarget).outputExtension;
        return `${'a'.repeat(64)}  qwen-code-${qwenTarget}.${extension}`;
      });
      writeFileSync(path.join(tmpDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);

      expect(() => assertStandaloneOutput(tmpDir)).not.toThrow();

      writeFileSync(
        path.join(tmpDir, 'SHA256SUMS'),
        `${lines.join('\n')}\n${'b'.repeat(64)}  qwen-code-extra.tar.gz\n`,
      );
      expect(() => assertStandaloneOutput(tmpDir)).toThrow(/Extra/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installer scripts honor --version for hosted entrypoints', () => {
    // The hosted entrypoint flow relies on the installer scripts accepting a
    // --version flag (and QWEN_INSTALL_VERSION env var) so that
    //   curl URL | bash -s -- --version vX.Y.Z
    // and the equivalent Windows incantation can pin a specific standalone
    // release without per-release installer assets.
    const installShellSource = readScript(
      'scripts/installation/install-qwen-with-source.sh',
    );
    expect(installShellSource).toContain(
      'VERSION="${QWEN_INSTALL_VERSION:-latest}"',
    );
    expect(installShellSource).toContain('--version)');
    expect(installShellSource).toContain('--version requires a value');

    const installBatchSource = readScript(
      'scripts/installation/install-qwen-with-source.bat',
    );
    expect(installBatchSource).toContain('set "VERSION=latest"');
    expect(installBatchSource).toContain(
      'if defined QWEN_INSTALL_VERSION set "VERSION=!QWEN_INSTALL_VERSION!"',
    );
    expect(installBatchSource).toContain('"%~1"=="--version"');
    expect(installBatchSource).toContain('--version requires a value');
  });

  it('stages hosted installation assets with checksums', async () => {
    const {
      HOSTED_INSTALLATION_ASSET_NAMES,
      HOSTED_INSTALLATION_ASSETS,
      HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS,
      HOSTED_INSTALLER_REQUIRED_FRAGMENTS,
      assertHostedInstallationAssetChecksums,
      buildHostedInstallationAssets,
    } = await import(hostedInstallationScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));

    try {
      await buildHostedInstallationAssets(tmpDir);

      const installSh = path.join(tmpDir, 'install-qwen.sh');
      const installBat = path.join(tmpDir, 'install-qwen.bat');
      const checksums = readScript(path.join(tmpDir, 'SHA256SUMS'));
      const checksumLines = checksums.trim().split('\n');

      expect(HOSTED_INSTALLATION_ASSET_NAMES).toEqual([
        'install-qwen.sh',
        'install-qwen.bat',
      ]);
      expect(HOSTED_INSTALLATION_ASSETS.map(({ output }) => output)).toEqual(
        HOSTED_INSTALLATION_ASSET_NAMES,
      );
      expect(HOSTED_INSTALLER_REQUIRED_FRAGMENTS).toEqual([
        '--version',
        'QWEN_INSTALL_VERSION',
      ]);
      // The default-version regex pins `latest` semantically rather than as a
      // loose substring, so a stray `latest` in a comment cannot satisfy it.
      expect(
        HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS['install-qwen.sh'].test(
          'VERSION="${QWEN_INSTALL_VERSION:-latest}"',
        ),
      ).toBe(true);
      expect(
        HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS['install-qwen.sh'].test(
          '# defaults to latest',
        ),
      ).toBe(false);
      expect(
        HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS['install-qwen.bat'].test(
          'set "VERSION=latest"',
        ),
      ).toBe(true);
      expect(
        HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS['install-qwen.bat'].test(
          'rem defaults to latest',
        ),
      ).toBe(false);
      expect(readScript(installSh)).toBe(
        readScript('scripts/installation/install-qwen-with-source.sh'),
      );
      expect(readScript(installBat)).toBe(
        readScript('scripts/installation/install-qwen-with-source.bat'),
      );
      expect(existsSync(path.join(tmpDir, 'install'))).toBe(false);
      const checksumNames = checksumLines.map((line) => line.split('  ')[1]);
      expect(checksumNames).toEqual([...checksumNames].sort());
      expect(checksums).toMatch(/^[0-9a-f]{64} {2}install-qwen\.sh$/m);
      expect(checksums).toMatch(/^[0-9a-f]{64} {2}install-qwen\.bat$/m);
      expect(checksums).not.toMatch(/ {2}install$/m);
      if (process.platform !== 'win32') {
        expect(lstatSync(installSh).mode & 0o111).not.toBe(0);
      }

      writeFileSync(installSh, 'tampered');
      await expect(
        assertHostedInstallationAssetChecksums(tmpDir),
      ).rejects.toThrow(/Checksum verification failed for install-qwen\.sh/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects hosted installer sources missing pinned install behavior', async () => {
    const { buildHostedInstallationAssets } = await import(
      hostedInstallationScriptUrl
    );
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-root-'));
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));
    const sourceDir = path.join(tmpRoot, 'scripts', 'installation');

    try {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        path.join(sourceDir, 'install-qwen-with-source.sh'),
        '#!/usr/bin/env bash\nVERSION="${QWEN_INSTALL_VERSION:-latest}"\n',
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-with-source.bat'),
        '@echo off\r\nset "VERSION=latest"\r\n',
      );

      await expect(
        buildHostedInstallationAssets(tmpDir, { root: tmpRoot }),
      ).rejects.toThrow(
        /install-qwen\.sh is missing hosted installer behavior: --version/,
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects hosted installer sources whose default version is not latest', async () => {
    const { buildHostedInstallationAssets } = await import(
      hostedInstallationScriptUrl
    );
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-root-'));
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));
    const sourceDir = path.join(tmpRoot, 'scripts', 'installation');

    try {
      mkdirSync(sourceDir, { recursive: true });
      // Both fragments are present, but the default version was changed to
      // something other than `latest`. The default-version pattern guard
      // catches this, even though loose substring matching would not.
      writeFileSync(
        path.join(sourceDir, 'install-qwen-with-source.sh'),
        '#!/usr/bin/env bash\n' +
          '# Defaults to latest unless --version is passed.\n' +
          'VERSION="${QWEN_INSTALL_VERSION:-stable}"\n' +
          'case "$1" in --version) shift; VERSION="$1" ;; esac\n',
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-with-source.bat'),
        '@echo off\r\nset "VERSION=stable"\r\n',
      );

      await expect(
        buildHostedInstallationAssets(tmpDir, { root: tmpRoot }),
      ).rejects.toThrow(
        /install-qwen\.sh default install version must be 'latest'/,
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects stale hosted installation assets in the output directory', async () => {
    const { buildHostedInstallationAssets } = await import(
      hostedInstallationScriptUrl
    );
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));

    try {
      writeFileSync(path.join(tmpDir, 'install'), 'stale alias');

      await expect(buildHostedInstallationAssets(tmpDir)).rejects.toThrow(
        /Unexpected hosted installer asset: install/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies release asset directory contents and checksums', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseDirectory } =
      await import(installationReleaseVerificationScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-verify-'));

    try {
      writeStandaloneReleaseAssets(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES);
      await expect(verifyReleaseDirectory(tmpDir)).resolves.not.toThrow();

      // Tampering an archive must be caught by the per-asset hash check.
      appendFileSync(
        path.join(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES[0]),
        'tamper',
      );
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        new RegExp(
          `Checksum verification failed for ${escapeRegExp(EXPECTED_STANDALONE_ARCHIVE_NAMES[0])}`,
        ),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects missing release archives and unexpected checksum entries', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseDirectory } =
      await import(installationReleaseVerificationScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-verify-'));

    try {
      writeStandaloneReleaseAssets(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES);
      rmSync(path.join(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES[0]));
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /Missing release asset: qwen-code-/,
      );

      writeStandaloneReleaseAssets(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES);
      writeStandaloneReleaseChecksums(tmpDir, [
        ...EXPECTED_STANDALONE_ARCHIVE_NAMES,
        'qwen-code-extra.tar.gz',
      ]);
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /Unexpected release asset checksum: qwen-code-extra\.tar\.gz/,
      );

      writeStandaloneReleaseAssets(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES);
      writeFileSync(path.join(tmpDir, 'qwen-code-stale.tar.gz'), 'stale');
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /Unexpected release asset: qwen-code-stale\.tar\.gz/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a release directory without SHA256SUMS', async () => {
    const { verifyReleaseDirectory } = await import(
      installationReleaseVerificationScriptUrl
    );
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-verify-'));

    try {
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /SHA256SUMS was not found at /,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies release asset URLs from SHA256SUMS', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );
    const fetchedUrls = [];

    await expect(
      verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
        fetchImpl: async (url, options = {}) => {
          fetchedUrls.push([url, options.method || 'GET']);
          if (url.endsWith('/SHA256SUMS')) {
            return new Response(checksumContent);
          }
          return new Response(null, { status: 200 });
        },
      }),
    ).resolves.not.toThrow();

    expect(fetchedUrls).toContainEqual([
      'https://example.com/qwen-code/v0.0.0/SHA256SUMS',
      'GET',
    ]);
    for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
      expect(fetchedUrls).toContainEqual([
        `https://example.com/qwen-code/v0.0.0/${assetName}`,
        'HEAD',
      ]);
    }
    // Hosted installer scripts must not be fetched: the verifier targets
    // GitHub release assets only.
    for (const [url] of fetchedUrls) {
      expect(url).not.toMatch(/install-qwen\.(sh|bat)$/);
      expect(url).not.toMatch(/\/install$/);
    }
  });

  it('falls back to ranged GET when remote HEAD is unavailable', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );
    const observedMethods = [];

    await expect(
      verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
        fetchImpl: async (url, options = {}) => {
          if (url.endsWith('/SHA256SUMS')) {
            return new Response(checksumContent);
          }
          const method = options.method || 'GET';
          observedMethods.push(method);
          if (method === 'HEAD') {
            return new Response(null, { status: 405 });
          }
          // Ranged GET fallback succeeds.
          return new Response(null, { status: 206 });
        },
      }),
    ).resolves.not.toThrow();

    expect(observedMethods).toContain('HEAD');
    expect(observedMethods).toContain('GET');
  });

  it('rejects a release base URL with no archives reachable', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );

    await expect(
      verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
        fetchImpl: async (url) => {
          if (url.endsWith('/SHA256SUMS')) {
            return new Response(checksumContent);
          }
          return new Response(null, { status: 404 });
        },
      }),
    ).rejects.toThrow(/Release asset URL is not available/);
  });

  it('rejects a release base URL that is not https', async () => {
    const { verifyReleaseBaseUrl } = await import(
      installationReleaseVerificationScriptUrl
    );

    // file:// must be rejected as a URL the verifier cannot reach safely.
    await expect(verifyReleaseBaseUrl('file:///tmp/release/')).rejects.toThrow(
      /--base-url must use https/,
    );

    // Plain http must also be rejected even though it is technically a valid
    // URL — release URLs are always HTTPS, and accepting http would let an
    // operator silently target a stale or attacker-controlled mirror.
    await expect(
      verifyReleaseBaseUrl('http://example.com/release/'),
    ).rejects.toThrow(/--base-url must use https/);
  });

  it('rejects a runtime archive without a Node executable', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const target = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
      const fakeRuntimeArchive =
        process.platform === 'win32'
          ? createBadWindowsNodeArchive(tmpDir)
          : createBadUnixNodeArchive(tmpDir);

      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            target,
            '--node-archive',
            fakeRuntimeArchive,
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/Node\.js runtime for .* must contain/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  it('packages a win-x64 standalone archive', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const outDir = path.join(tmpDir, 'out');
      execFileSync(
        'node',
        [
          'scripts/create-standalone-package.js',
          '--target',
          'win-x64',
          '--node-archive',
          createFakeWindowsNodeArchive(tmpDir),
          '--out-dir',
          outDir,
          '--version',
          '0.0.0-test',
        ],
        { stdio: 'pipe' },
      );

      const archive = path.join(outDir, 'qwen-code-win-x64.zip');
      const extractDir = path.join(tmpDir, 'extract');
      mkdirSync(extractDir, { recursive: true });
      extractZipForTest(archive, extractDir);

      expect(existsSync(path.join(extractDir, 'qwen-code'))).toBe(true);
      expect(
        existsSync(path.join(extractDir, 'qwen-code', 'bin', 'qwen.cmd')),
      ).toBe(true);
      expect(
        existsSync(path.join(extractDir, 'qwen-code', 'node', 'node.exe')),
      ).toBe(true);
      const packagedPackageJson = JSON.parse(
        readScript(path.join(extractDir, 'qwen-code', 'package.json')),
      );
      expect(packagedPackageJson).toEqual({
        name: '@qwen-code/qwen-code',
        version: '0.0.0',
      });
      expect(readScript(path.join(outDir, 'SHA256SUMS'))).toContain(
        'qwen-code-win-x64.zip',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  }, 30_000);

  itOnUnix('dereferences safe Node.js runtime symlinks', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir, {
        withSafeNodeSymlink: true,
      });
      const installRoot = path.join(tmpDir, 'install');
      runUnixInstaller(archive, installRoot, path.join(tmpDir, 'home'));

      const npmShim = path.join(
        installRoot,
        'lib',
        'qwen-code',
        'node',
        'bin',
        'npm',
      );
      expect(existsSync(npmShim)).toBe(true);
      expect(lstatSync(npmShim).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  itOnUnix('rejects Node.js runtime symlinks that escape the archive', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'linux-x64',
            '--node-archive',
            createFakeNodeArchive(tmpDir, {
              withEscapingNodeSymlink: true,
            }),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/symlink escapes the archive/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  itOnUnix('rejects Node.js runtime symlink cycles', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'linux-x64',
            '--node-archive',
            createFakeNodeArchive(tmpDir, {
              withNodeSymlinkCycle: true,
            }),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/symlink cycle/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  it('rejects unexpected dist assets', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      writeFileSync('dist/debug-cache.tmp', 'debug\n');

      expect(() =>
        execFileSync(
          'node',
          [
            'scripts/create-standalone-package.js',
            '--target',
            'win-x64',
            '--node-archive',
            createFakeWindowsNodeArchive(tmpDir),
            '--out-dir',
            path.join(tmpDir, 'out'),
            '--version',
            '0.0.0-test',
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow(/Unexpected dist asset/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  it('ignores non-runtime esbuild metadata in dist', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));

    try {
      const outDir = path.join(tmpDir, 'out');
      writeFileSync('dist/esbuild.json', '{}\n');

      execFileSync(
        'node',
        [
          'scripts/create-standalone-package.js',
          '--target',
          'win-x64',
          '--node-archive',
          createFakeWindowsNodeArchive(tmpDir),
          '--out-dir',
          outDir,
          '--version',
          '0.0.0-test',
        ],
        { stdio: 'pipe' },
      );

      const archive = path.join(outDir, 'qwen-code-win-x64.zip');
      const extractDir = path.join(tmpDir, 'extract');
      mkdirSync(extractDir, { recursive: true });
      extractZipForTest(archive, extractDir);

      expect(
        existsSync(path.join(extractDir, 'qwen-code', 'lib', 'esbuild.json')),
      ).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  }, 30_000);

  it('uploads standalone archives during release', () => {
    const workflow = readScript('.github/workflows/release.yml');

    expect(workflow).toContain('npm run package:standalone:release --');
    // Per-release installer publishing was removed in favor of a stable hosted
    // entrypoint, so the release workflow no longer builds or uploads installer
    // scripts as release assets.
    expect(workflow).not.toContain('package:installation-assets');
    expect(workflow).not.toContain('install-qwen.sh');
    expect(workflow).not.toContain('install-qwen.bat');
    expect(workflow).not.toContain('verify_node_checksum()');
    expect(workflow).not.toContain('download_node()');
    expect(workflow).toContain('dist/standalone/qwen-code-*.tar.gz');
    expect(workflow).toContain('dist/standalone/qwen-code-*.zip');
    expect(workflow).toContain('dist/standalone/SHA256SUMS');
    // The verify step must run after the build step so a broken release
    // directory is caught before publishing.
    expect(workflow).toContain(
      'npm run verify:installation-release -- --dir dist/standalone',
    );
    const buildIndex = workflow.indexOf('npm run package:standalone:release');
    const verifyIndex = workflow.indexOf('npm run verify:installation-release');
    expect(buildIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
  });

  it('does not whitelist internal planning documents in gitignore', () => {
    const gitignore = readScript('.gitignore');

    expect(gitignore).not.toContain('!.qwen/design/');
    expect(gitignore).not.toContain('!.qwen/e2e-tests/');
  });

  it('documents optional native module parity for standalone installs', () => {
    const guide = readScript('scripts/installation/INSTALLATION_GUIDE.md');

    expect(guide).toContain('Optional Native Modules');
    expect(guide).toContain('package:hosted-installation');
    expect(guide).toContain('installation/install-qwen.sh');
    expect(guide).toContain('installation/install-qwen.bat');
    expect(guide).toContain('release operators must sync these staged files');
    // The hosted-endpoint status callout must keep flagging the transition
    // window so users do not assume the documented --version flow works
    // before the next OSS sync.
    expect(guide).toContain('Hosted endpoint status');
    expect(guide).toContain('legacy NVM-based installer');
    expect(guide).toContain('node-pty');
    expect(guide).toContain('clipboard');
  });
});

describe('Linux/macOS installer end-to-end', () => {
  itOnUnix(
    'installs a local standalone archive with checksum verification',
    () => {
      const restoreDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runUnixInstaller(archive, installRoot, home);

        expect(existsSync(path.join(installRoot, 'bin', 'qwen'))).toBe(true);
        expect(
          existsSync(
            path.join(installRoot, 'lib', 'qwen-code', 'node', 'bin', 'node'),
          ),
        ).toBe(true);
        expect(readScript(path.join(home, '.qwen', 'source.json'))).toContain(
          '"source": "smoke"',
        );

        const version = execFileSync(path.join(installRoot, 'bin', 'qwen'), [
          '--version',
        ])
          .toString()
          .trim();
        expect(version).toBe('0.0.0-smoke');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreDist();
      }
    },
  );

  itOnUnix('shell-quotes custom install paths in the generated wrapper', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const home = path.join(tmpDir, 'home');
      const installLibDir = path.join(
        installRoot,
        'lib',
        'qwen-code$(touch qwen-pwned)',
      );

      runUnixInstaller(archive, installRoot, home, 'standalone', {
        QWEN_INSTALL_LIB_DIR: installLibDir,
      });

      const version = execFileSync(
        path.join(installRoot, 'bin', 'qwen'),
        ['--version'],
        {
          cwd: tmpDir,
        },
      )
        .toString()
        .trim();
      expect(version).toBe('0.0.0-smoke');
      expect(existsSync(path.join(tmpDir, 'qwen-pwned'))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  itOnUnix('rejects a tampered local archive', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      appendFileSync(archive, 'tamper');

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Checksum verification failed/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  itOnUnix('rejects a local archive when SHA256SUMS is missing', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      rmSync(path.join(path.dirname(archive), 'SHA256SUMS'), { force: true });

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/SHA256SUMS not found/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  itOnUnix('rejects standalone archives containing symlinks', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = createSymlinkStandaloneArchive(tmpDir);

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Archive contains symlinks/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnUnix(
    'rejects standalone archives containing path traversal entries',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createTraversalStandaloneArchive(tmpDir);

        expect(() =>
          runUnixInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
          ),
        ).toThrow(/Archive contains unsafe path/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnUnix('refuses to overwrite a non-managed install directory', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const installDir = path.join(installRoot, 'lib', 'qwen-code');
      mkdirSync(installDir, { recursive: true });
      writeFileSync(path.join(installDir, 'important.txt'), 'keep me\n');

      expect(() =>
        runUnixInstaller(archive, installRoot, path.join(tmpDir, 'home')),
      ).toThrow(/not a Qwen Code standalone install/);
      expect(readScript(path.join(installDir, 'important.txt'))).toBe(
        'keep me\n',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  itOnUnix(
    'refuses to overwrite a directory with an unrelated manifest',
    () => {
      const restoreDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const installDir = path.join(installRoot, 'lib', 'qwen-code');
        mkdirSync(installDir, { recursive: true });
        writeFileSync(
          path.join(installDir, 'manifest.json'),
          JSON.stringify({ name: 'other-app', target: 'linux-x64' }),
        );
        writeFileSync(path.join(installDir, 'important.txt'), 'keep me\n');

        expect(() =>
          runUnixInstaller(archive, installRoot, path.join(tmpDir, 'home')),
        ).toThrow(/not a Qwen Code standalone install/);
        expect(readScript(path.join(installDir, 'important.txt'))).toBe(
          'keep me\n',
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreDist();
      }
    },
  );

  itOnUnix('does not fall back to npm when detect finds a bad archive', () => {
    const restoreDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      appendFileSync(archive, 'tamper');

      let failureMessage = '';
      try {
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
          'detect',
        );
      } catch (error) {
        failureMessage = error.message;
      }

      expect(failureMessage).toContain('Checksum verification failed');
      expect(failureMessage).toContain('Standalone install failed');
      expect(failureMessage).not.toContain('Falling back to npm installation');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreDist();
    }
  });

  itOnUnix(
    'falls back to npm in detect mode when archive is unavailable',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const fakeBin = path.join(tmpDir, 'bin');
        const home = path.join(tmpDir, 'home');
        const npmLog = path.join(tmpDir, 'npm-args.txt');
        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(home, { recursive: true });

        writeFileSync(
          path.join(fakeBin, 'curl'),
          '#!/usr/bin/env sh\nexit 22\n',
        );
        writeFileSync(
          path.join(fakeBin, 'node'),
          [
            '#!/usr/bin/env sh',
            'if [ "$1" = "-p" ]; then',
            '  case "$2" in',
            '    *split*) echo 22 ;;',
            '    *) echo 22.0.0 ;;',
            '  esac',
            '  exit 0',
            'fi',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'npm'),
          [
            '#!/usr/bin/env sh',
            'case "$1" in',
            '  -v) echo 10.0.0 ;;',
            '  prefix) echo "$QWEN_FAKE_NPM_PREFIX" ;;',
            '  install) printf "%s\\n" "$*" > "$QWEN_FAKE_NPM_LOG" ;;',
            'esac',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'qwen'),
          '#!/usr/bin/env sh\necho 0.0.0-npm\n',
        );
        for (const command of ['curl', 'node', 'npm', 'qwen']) {
          chmodSync(path.join(fakeBin, command), 0o755);
        }

        const output = execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-with-source.sh',
            '--method',
            'detect',
            '--base-url',
            'https://example.invalid/qwen-code',
            '--source',
            'smoke',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH}`,
              QWEN_FAKE_NPM_LOG: npmLog,
              QWEN_FAKE_NPM_PREFIX: path.join(tmpDir, 'npm-prefix'),
            },
            stdio: 'pipe',
          },
        ).toString();

        expect(output).toContain('Falling back to npm installation');
        expect(readScript(npmLog)).toContain(
          'install -g @qwen-code/qwen-code@latest --registry',
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnUnix('preserves context when npm fallback also fails', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const fakeBin = path.join(tmpDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(path.join(fakeBin, 'curl'), '#!/usr/bin/env sh\nexit 22\n');
      chmodSync(path.join(fakeBin, 'curl'), 0o755);

      let failureMessage = '';
      try {
        execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-with-source.sh',
            '--method',
            'detect',
            '--base-url',
            'https://example.invalid/qwen-code',
            '--source',
            'smoke',
          ],
          {
            env: {
              HOME: path.join(tmpDir, 'home'),
              PATH: `${fakeBin}:/usr/bin:/bin`,
            },
            stdio: 'pipe',
          },
        );
      } catch (error) {
        failureMessage = [
          error.message,
          error.stdout?.toString() || '',
          error.stderr?.toString() || '',
        ].join('\n');
      }

      expect(failureMessage).toContain('Falling back to npm installation');
      expect(failureMessage).toMatch(
        /Node\.js was not found|Unable to determine Node\.js version/,
      );
      expect(failureMessage).toContain('npm fallback also failed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Windows installer end-to-end', () => {
  itOnWindows(
    'installs a local standalone archive with checksum verification',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runWindowsInstaller(archive, installRoot, home);

        expect(existsSync(path.join(installRoot, 'bin', 'qwen.cmd'))).toBe(
          true,
        );
        expect(
          existsSync(path.join(installRoot, 'qwen-code', 'node', 'node.exe')),
        ).toBe(true);
        expect(readScript(path.join(home, '.qwen', 'source.json'))).toContain(
          '"source": "smoke"',
        );

        const version = runWindowsCommand(
          `call "${path.join(installRoot, 'bin', 'qwen.cmd')}" --version`,
          { USERPROFILE: home },
        )
          .toString()
          .trim();
        expect(version).toBe('0.0.0-smoke');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    WINDOWS_INSTALLER_TEST_TIMEOUT,
  );

  itOnWindows(
    'rejects a tampered local archive',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        appendFileSync(archive, 'tamper');

        expect(() =>
          runWindowsInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
          ),
        ).toThrow(/Checksum verification failed/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    WINDOWS_INSTALLER_TEST_TIMEOUT,
  );

  itOnWindows(
    'rejects a local archive when SHA256SUMS is missing',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        rmSync(path.join(path.dirname(archive), 'SHA256SUMS'), { force: true });

        expect(() =>
          runWindowsInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
          ),
        ).toThrow(/SHA256SUMS not found; cannot verify archive/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    WINDOWS_INSTALLER_TEST_TIMEOUT,
  );

  itOnWindows(
    'rejects a local archive missing required entries',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir, {
          includeNode: false,
        });

        expect(() =>
          runWindowsInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
          ),
        ).toThrow(/qwen-code\\node\\node.exe/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    WINDOWS_INSTALLER_TEST_TIMEOUT,
  );

  itOnWindows(
    'rejects standalone archives containing path traversal entries',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createWindowsTraversalStandaloneArchive(tmpDir);

        expect(() =>
          runWindowsInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
          ),
        ).toThrow(/Archive contains unsafe path/);
        expect(existsSync(path.join(tmpDir, 'qwen-slip'))).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    WINDOWS_INSTALLER_TEST_TIMEOUT,
  );

  itOnWindows(
    'refuses to overwrite a directory with an unrelated manifest',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const installDir = path.join(installRoot, 'qwen-code');
        mkdirSync(installDir, { recursive: true });
        writeFileSync(
          path.join(installDir, 'manifest.json'),
          JSON.stringify({ name: 'other-app', target: 'win-x64' }),
        );
        writeFileSync(path.join(installDir, 'important.txt'), 'keep me\n');

        expect(() =>
          runWindowsInstaller(archive, installRoot, path.join(tmpDir, 'home')),
        ).toThrow(/not a Qwen Code standalone install/);
        expect(readScript(path.join(installDir, 'important.txt'))).toBe(
          'keep me\n',
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    WINDOWS_INSTALLER_TEST_TIMEOUT,
  );

  itOnWindows(
    'rejects unsafe environment-derived install paths',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        const marker = path.join(tmpDir, 'pwned.txt');

        expect(() =>
          runWindowsInstaller(
            archive,
            path.join(tmpDir, 'install'),
            path.join(tmpDir, 'home'),
            'standalone',
            {
              QWEN_INSTALL_ROOT: `${path.join(tmpDir, 'install')}" & echo pwned > "${marker}" & "`,
            },
          ),
        ).toThrow(/unsafe command characters/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    WINDOWS_INSTALLER_TEST_TIMEOUT,
  );
});

// Tracks pending dist/ backups so a crashed test cannot leave the working tree
// without dist/. process.on('exit') runs synchronous handlers, which is enough
// for renameSync; SIGINT/SIGTERM force re-entry through 'exit'.
const pendingDistBackups = new Set();
let distBackupHandlersRegistered = false;

function registerDistBackupSafetyNet() {
  if (distBackupHandlersRegistered) {
    return;
  }
  distBackupHandlersRegistered = true;

  const drain = () => {
    for (const restore of pendingDistBackups) {
      try {
        restore();
      } catch {
        // best-effort restore; nothing we can do at exit
      }
    }
    pendingDistBackups.clear();
  };

  process.on('exit', drain);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      drain();
      process.exit(1);
    });
  }
}

function ensureMinimalDist() {
  registerDistBackupSafetyNet();

  const distPath = path.resolve('dist');
  // Backup root must live on the same volume as dist/ so that renameSync
  // is atomic. On Windows GitHub runners the workspace lives on D: while
  // os.tmpdir() returns a path on C:; renaming across drives raises
  // EXDEV. Keeping the backup as a sibling of dist/ avoids that.
  const backupRoot = mkdtempSync(
    path.join(path.dirname(distPath), '.qwen-dist-backup-'),
  );
  const backupDist = path.join(backupRoot, 'dist');
  const hadExistingDist = existsSync(distPath);

  if (hadExistingDist) {
    renameSync(distPath, backupDist);
  }

  mkdirSync('dist/vendor', { recursive: true });
  mkdirSync('dist/bundled/qc-helper/docs', { recursive: true });
  writeFileSync('dist/cli.js', 'console.log("qwen");\n');
  writeFileSync(
    'dist/package.json',
    JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.0.0' }),
  );

  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    pendingDistBackups.delete(restore);
    rmSync(distPath, { recursive: true, force: true });
    if (hadExistingDist) {
      renameSync(backupDist, distPath);
    }
    rmSync(backupRoot, { recursive: true, force: true });
  };

  pendingDistBackups.add(restore);
  return restore;
}

function createFakeNodeArchive(tmpDir, options = {}) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-linux-x64');
  mkdirSync(path.join(fakeNodeDir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(fakeNodeDir, 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(fakeNodeDir, 'bin', 'node'), 0o755);

  if (options.withSafeNodeSymlink) {
    mkdirSync(path.join(fakeNodeDir, 'lib'), { recursive: true });
    writeFileSync(path.join(fakeNodeDir, 'lib', 'npm-cli.js'), 'npm cli\n');
    symlinkSync('../lib/npm-cli.js', path.join(fakeNodeDir, 'bin', 'npm'));
  }

  if (options.withEscapingNodeSymlink) {
    const outsideTarget = path.join(tmpDir, 'outside-node-helper.js');
    writeFileSync(outsideTarget, 'outside\n');
    symlinkSync(outsideTarget, path.join(fakeNodeDir, 'bin', 'npm'));
  }

  if (options.withNodeSymlinkCycle) {
    symlinkSync('../bin', path.join(fakeNodeDir, 'bin', 'cycle'));
  }

  const archive = path.join(tmpDir, 'node-v20.0.0-linux-x64.tar.gz');
  execFileSync(
    'tar',
    ['-czf', archive, '-C', tmpDir, path.basename(fakeNodeDir)],
    {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: 'ignore',
    },
  );
  return archive;
}

function createBadUnixNodeArchive(tmpDir) {
  const fakeRuntimeDir = path.join(tmpDir, 'not-node');
  mkdirSync(fakeRuntimeDir, { recursive: true });
  writeFileSync(path.join(fakeRuntimeDir, 'README.txt'), 'not node\n');

  const archive = path.join(tmpDir, 'bad-runtime.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', tmpDir, 'not-node'], {
    env: { ...process.env, LC_ALL: 'C' },
    stdio: 'ignore',
  });
  return archive;
}

function createBadWindowsNodeArchive(tmpDir) {
  const fakeRuntimeDir = path.join(tmpDir, 'not-node');
  mkdirSync(fakeRuntimeDir, { recursive: true });
  writeFileSync(path.join(fakeRuntimeDir, 'README.txt'), 'not node\n');

  const archive = path.join(tmpDir, 'bad-runtime.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeRuntimeDir));
  return archive;
}

function createFakeWindowsNodeArchive(tmpDir) {
  const fakeNodeDir = path.join(tmpDir, 'node-v20.0.0-win-x64');
  mkdirSync(fakeNodeDir, { recursive: true });
  writeFileSync(path.join(fakeNodeDir, 'node.exe'), 'fake node.exe\n');

  const archive = path.join(tmpDir, 'node-v20.0.0-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeNodeDir));
  return archive;
}

function createFakeWindowsStandaloneArchive(tmpDir, options = {}) {
  const {
    includeNode = true,
    manifest = { name: '@qwen-code/qwen-code', target: 'win-x64' },
  } = options;
  const packageRoot = path.join(tmpDir, 'qwen-code');
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node'), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    path.join(packageRoot, 'bin', 'qwen.cmd'),
    ['@echo off', 'echo 0.0.0-smoke', ''].join('\r\n'),
  );
  if (includeNode) {
    writeFileSync(
      path.join(packageRoot, 'node', 'node.exe'),
      'fake node.exe\n',
    );
  }
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify(manifest),
  );

  const archive = path.join(outDir, 'qwen-code-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(packageRoot));
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function createWindowsTraversalStandaloneArchive(tmpDir) {
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });

  const archive = path.join(outDir, 'qwen-code-win-x64.zip');
  // PowerShell's `-Command` parser is fragile for multi-line scripts that
  // include function definitions and quoted entry names. Joining with
  // `; ` produces lines like `function f() {; ...; }; }` that older
  // PowerShell versions reject. Write the script to a .ps1 file and run
  // `-File` instead, which uses the same parser as a real script.
  const scriptPath = path.join(tmpDir, 'create-traversal-archive.ps1');
  writeFileSync(
    scriptPath,
    [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.IO.Compression',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      'function Add-ZipEntry($zip, $name, $content) {',
      '  $entry = $zip.CreateEntry($name)',
      '  $writer = [System.IO.StreamWriter]::new($entry.Open())',
      '  try { $writer.Write($content) } finally { $writer.Dispose() }',
      '}',
      'if (Test-Path -LiteralPath $env:QWEN_TEST_ZIP_ARCHIVE) { Remove-Item -LiteralPath $env:QWEN_TEST_ZIP_ARCHIVE -Force }',
      '$zip = [System.IO.Compression.ZipFile]::Open($env:QWEN_TEST_ZIP_ARCHIVE, [System.IO.Compression.ZipArchiveMode]::Create)',
      'try {',
      "  Add-ZipEntry $zip '../qwen-slip' 'path traversal'",
      '  Add-ZipEntry $zip \'qwen-code/bin/qwen.cmd\' "@echo off`r`necho 0.0.0-smoke`r`n"',
      "  Add-ZipEntry $zip 'qwen-code/node/node.exe' 'fake node.exe'",
      '  Add-ZipEntry $zip \'qwen-code/manifest.json\' \'{"name":"@qwen-code/qwen-code","target":"win-x64"}\'',
      '} finally { $zip.Dispose() }',
      '',
    ].join('\r\n'),
  );

  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      env: {
        ...process.env,
        QWEN_TEST_ZIP_ARCHIVE: archive,
      },
      stdio: 'pipe',
    },
  );
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function createZipForTest(archive, cwd, entry) {
  if (process.platform === 'win32') {
    // Mirror create-standalone-package.js: use CreateFromDirectory so
    // entry names use forward slashes and match what the production
    // builder ships. Compress-Archive would write backslashes, which
    // the .bat installer's ValidateArchiveContents normalizes but the
    // production archive shouldn't depend on that leniency.
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath $env:QWEN_TEST_ZIP_ARCHIVE) { Remove-Item -LiteralPath $env:QWEN_TEST_ZIP_ARCHIVE -Force }; [IO.Compression.ZipFile]::CreateFromDirectory($env:QWEN_TEST_ZIP_ENTRY, $env:QWEN_TEST_ZIP_ARCHIVE, [IO.Compression.CompressionLevel]::Optimal, $true)',
      ],
      {
        env: {
          ...process.env,
          QWEN_TEST_ZIP_ENTRY: path.join(cwd, entry),
          QWEN_TEST_ZIP_ARCHIVE: archive,
        },
        stdio: 'ignore',
      },
    );
    return;
  }

  execFileSync('zip', ['-qr', archive, entry], {
    cwd,
    stdio: 'ignore',
  });
}

function extractZipForTest(archive, destination) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:QWEN_TEST_ZIP_ARCHIVE -DestinationPath $env:QWEN_TEST_ZIP_DESTINATION -Force',
      ],
      {
        env: {
          ...process.env,
          QWEN_TEST_ZIP_ARCHIVE: archive,
          QWEN_TEST_ZIP_DESTINATION: destination,
        },
        stdio: 'ignore',
      },
    );
    return;
  }

  execFileSync('unzip', ['-q', archive, '-d', destination], {
    stdio: 'ignore',
  });
}

function packageFakeStandalone(tmpDir, nodeArchiveOptions = {}) {
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'node',
    [
      'scripts/create-standalone-package.js',
      '--target',
      'linux-x64',
      '--node-archive',
      createFakeNodeArchive(tmpDir, nodeArchiveOptions),
      '--out-dir',
      outDir,
      '--version',
      '0.0.0-smoke',
    ],
    { stdio: 'pipe' },
  );
  return path.join(outDir, 'qwen-code-linux-x64.tar.gz');
}

function runUnixInstaller(
  archive,
  installRoot,
  home,
  method = 'standalone',
  extraEnv = {},
) {
  mkdirSync(home, { recursive: true });
  try {
    return execFileSync(
      'bash',
      [
        'scripts/installation/install-qwen-with-source.sh',
        '--method',
        method,
        '--archive',
        archive,
        '--source',
        'smoke',
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          QWEN_INSTALL_ROOT: installRoot,
          ...extraEnv,
        },
        stdio: 'pipe',
      },
    );
  } catch (error) {
    const processError = error;
    throw new Error(
      [
        processError.message,
        processError.stdout?.toString() || '',
        processError.stderr?.toString() || '',
      ].join('\n'),
    );
  }
}

function runWindowsInstaller(
  archive,
  installRoot,
  home,
  method = 'standalone',
  extraEnv = {},
) {
  mkdirSync(home, { recursive: true });
  try {
    return runWindowsCommand(
      [
        `call "${path.resolve('scripts/installation/install-qwen-with-source.bat')}"`,
        '--method',
        method,
        '--archive',
        `"${archive}"`,
        '--source',
        'smoke',
      ].join(' '),
      {
        USERPROFILE: home,
        QWEN_INSTALL_ROOT: installRoot,
        ...extraEnv,
      },
    );
  } catch (error) {
    const processError = error;
    throw new Error(
      [
        processError.message,
        processError.stdout?.toString() || '',
        processError.stderr?.toString() || '',
      ].join('\n'),
    );
  }
}

function runWindowsCommand(command, env = {}) {
  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'pipe',
    // cmd.exe parses the command string itself; preserve quoted paths.
    windowsVerbatimArguments: true,
  });
}

function createSymlinkStandaloneArchive(tmpDir) {
  const packageRoot = path.join(tmpDir, 'malicious', 'qwen-code');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  symlinkSync('/usr/bin/env', path.join(packageRoot, 'bin', 'qwen'));
  writeFileSync(
    path.join(packageRoot, 'node', 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code' }),
  );

  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, 'qwen-code-linux-x64.tar.gz');
  execFileSync(
    'tar',
    ['-czf', archive, '-C', path.dirname(packageRoot), 'qwen-code'],
    {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: 'ignore',
    },
  );
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function createTraversalStandaloneArchive(tmpDir) {
  const maliciousRoot = path.join(tmpDir, 'malicious');
  const packageRoot = path.join(maliciousRoot, 'qwen-code');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  writeFileSync(
    path.join(packageRoot, 'bin', 'qwen'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'bin', 'qwen'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'node', 'bin', 'node'),
    '#!/usr/bin/env sh\necho 0.0.0-smoke\n',
  );
  chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code' }),
  );
  writeFileSync(path.join(tmpDir, 'qwen-slip'), 'path traversal\n');

  const outDir = path.join(tmpDir, 'out');
  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, 'qwen-code-linux-x64.zip');
  execFileSync('zip', ['-qr', archive, 'qwen-code', '../qwen-slip'], {
    cwd: maliciousRoot,
    stdio: 'ignore',
  });
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function writeChecksumFile(outDir, archiveName) {
  const archive = path.join(outDir, archiveName);
  const hash = crypto
    .createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex');
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${hash}  ${archiveName}\n`);
}

// Writes a synthetic standalone release directory: each archive name in
// `archiveNames` becomes a small file whose content equals the asset name,
// and SHA256SUMS is regenerated to match.
function writeStandaloneReleaseAssets(outDir, archiveNames) {
  mkdirSync(outDir, { recursive: true });
  for (const assetName of archiveNames) {
    writeFileSync(path.join(outDir, assetName), `${assetName}\n`);
  }
  writeStandaloneReleaseChecksums(outDir, archiveNames);
}

function writeStandaloneReleaseChecksums(outDir, archiveNames) {
  const lines = archiveNames.map((assetName) => {
    const filePath = path.join(outDir, assetName);
    // Allow callers to list a not-yet-written archive name (e.g. an
    // "unexpected extra" entry) without requiring the file to exist.
    const hash = existsSync(filePath)
      ? crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex')
      : 'a'.repeat(64);
    return `${hash}  ${assetName}`;
  });
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

// Generates a SHA256SUMS-formatted string for the given archive names. The
// hash values are placeholders — the remote verifier (verifyReleaseBaseUrl)
// only checks that SHA256SUMS lists the expected entries and that each
// archive URL is reachable; it does not download archives or compare hashes.
function placeholderChecksumContent(archiveNames) {
  return `${archiveNames
    .map(
      (assetName) =>
        `${crypto
          .createHash('sha256')
          .update(`${assetName}\n`)
          .digest('hex')}  ${assetName}`,
    )
    .join('\n')}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
