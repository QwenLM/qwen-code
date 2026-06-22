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
  readdirSync,
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
const hostedInstallationScriptUrl = pathToFileURL(
  path.resolve('scripts/build-hosted-installation-assets.js'),
).href;
const installationReleaseVerificationScriptUrl = pathToFileURL(
  path.resolve('scripts/verify-installation-release.js'),
).href;
const releaseScriptUtilsUrl = pathToFileURL(
  path.resolve('scripts/release-script-utils.js'),
).href;
// These E2E cases execute the Unix shell installer and POSIX symlink behavior.
// Windows batch behavior has separate Windows-only E2E coverage below.
const itOnUnix = process.platform === 'win32' ? it.skip : it;
const itOnWindows = process.platform === 'win32' ? it : it.skip;

vi.setConfig({ testTimeout: 30_000 });

describe('installation scripts', () => {
  it('keeps the Linux/macOS installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-qwen-standalone.sh',
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
    expect(script).not.toMatch(/brew install node@\d+/);
    expect(script).toContain('brew install node');
    expect(script).toContain(
      '--source may only contain letters, numbers, dot, underscore, or dash',
    );
    expect(script).toContain('Node.js 22 or newer is required');
    expect(script).toContain('npm_package_spec()');
    expect(script).toContain('@qwen-code/qwen-code@latest');
    expect(script).toContain('Installing Qwen Code version:');
    expect(script).toContain('print_logo');
    expect(script).toContain('supports_truecolor()');
    expect(script).toContain('COLORTERM');
    expect(script).toContain('installed successfully, to start:');
    expect(script).toContain('cd <project>');
    expect(script).toContain('uninstall-qwen-standalone.sh');
    expect(script).not.toContain('rm -rf $(shell_quote "${install_dir}")');
  });

  it('supports code-server-style standalone install on Linux/macOS', () => {
    const script = readScript(
      'scripts/installation/install-qwen-standalone.sh',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--mirror MIRROR');
    expect(script).toContain('--base-url URL');
    expect(script).toContain('--archive PATH');
    expect(script).toContain('install_standalone()');
    expect(script).toContain('install_npm()');
    expect(script).toContain('detect_target()');
    expect(script).toContain('verify_checksum()');
    expect(script).toContain(
      'SHA256SUMS not found at ${checksum_file}; cannot verify archive',
    );
    expect(script).toContain('awk -v archive_name');
    expect(script).not.toContain(
      'grep -E "(^|[[:space:]])[*]?${archive_name}$"',
    );
    expect(script).toContain('validate_archive_contents()');
    expect(script).toContain('Archive contains unsafe path');
    expect(script).toContain('qwen-code-${target}');
    expect(script).toContain('*.tar.xz)');
    expect(script).toContain('METHOD="${METHOD:-detect}"');
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('standalone_status=$?');
    expect(script).toContain('[[ "${standalone_status}" -eq 2 ]]');
    expect(script).toMatch(
      /Aliyun standalone archive not found; retrying GitHub mirror\.[\s\S]*checksum_source="\$\{base_url\}\/SHA256SUMS"[\s\S]*MIRROR="github"/,
    );
    expect(script).toMatch(
      /archive_url="\$\{github_fallback_base_url\}\/\$\{archive_name\}"[\s\S]*checksum_source="\$\{github_fallback_base_url\}\/SHA256SUMS"[\s\S]*MIRROR="github"[\s\S]*Aliyun standalone archive download failed; retrying GitHub mirror\./,
    );
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
    expect(script).toContain(
      'Archive contains symlinks or hardlinks; refusing to install',
    );
    expect(script).toContain('not a Qwen Code standalone install');
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
    expect(script).toContain(
      'curl -fL --retry 2 --connect-timeout 15 --max-time 300 --progress-bar "${url}" -o "${destination}"',
    );
    expect(script).not.toContain('--trace-ascii');
    expect(script).not.toContain('mkfifo');
    expect(script).not.toContain('qwen_install_$$');
    expect(script).toContain(
      'curl -fsSL --retry 2 --connect-timeout 10 --max-time 30 "${url}"',
    );
    expect(script).toContain('wget -q "${wget_args[@]}" -O - "${url}"');
    expect(script).toContain(
      'wget --progress=bar:force:noscroll "${wget_args[@]}" "${url}" -O "${destination}"',
    );
    expect(script).toMatch(
      /wget --progress=bar:force:noscroll "\$\{wget_args\[@\]\}" "\$\{url\}" -O "\$\{destination\}" &[\s\S]{0,120}ACTIVE_DOWNLOAD_PID=\$!/,
    );
    expect(script).toMatch(
      /wget "\$\{wget_args\[@\]\}" "\$\{url\}" -O "\$\{destination\}" &[\s\S]{0,120}ACTIVE_DOWNLOAD_PID=\$!/,
    );
    expect(script).toContain('wget_args+=(--read-timeout=300)');
    expect(script).toContain(
      'curl -fsL --retry 1 --connect-timeout 10 --max-time "${timeout}"',
    );
    expect(script).toContain('wget_args+=(--read-timeout=30)');
    expect(script).toContain('Downloading ${archive_name}');
    expect(script).not.toContain(
      'curl -fsSL --retry 2 "${url}" -o "${destination}"',
    );
    expect(script).not.toContain(
      'wget -q --tries=3 "${url}" -O "${destination}"',
    );
    expect(script).toContain('TEMP_DIRS+=');
    expect(script).toContain('validate_github_repo()');
    expect(script).toContain(
      'QWEN_INSTALL_GITHUB_REPO must be in owner/repo format',
    );
    expect(script).toContain('set -gx PATH ${quoted_install_bin_dir} \\$PATH');
    expect(script).toContain('export PATH=${quoted_install_bin_dir}:\\$PATH');
    expect(script).toContain('Unsupported shell for automatic PATH update');
    expect(script).toContain('# Qwen Code PATH block begin');
    expect(script).toContain('# Qwen Code PATH block end');
    expect(script).toContain('probe_url_available()');
    expect(script).toContain('/latest/VERSION');
    expect(script).toContain('resolve_aliyun_version_path()');
    expect(script).toContain('retrying GitHub mirror');
    expect(script).toContain('entry="${entry//\\\\//}"');
    expect(script).toContain('restore_stale_install_backup()');
    expect(script).toContain(
      'restore_stale_install_backup "${old_install_dir}" "${INSTALL_LIB_DIR}"',
    );
    expect(script).toContain('ACTIVE_DOWNLOAD_PID=""');
    expect(script).toContain('restore_cursor >&2');
    expect(script).toContain(
      'kill "${ACTIVE_DOWNLOAD_PID}" 2>/dev/null || true',
    );
    expect(script).not.toContain(
      'rm -rf "${new_install_dir}" "${old_install_dir}" "${wrapper_tmp}"',
    );
    expect(script).not.toContain('-print -quit');
  });

  it('keeps the Windows installer lightweight', () => {
    const script = readScript(
      'scripts/installation/install-qwen-standalone.bat',
    );

    expect(script).not.toContain('InstallNodeJSDirectly');
    expect(script).not.toContain('node-v!NODE_VERSION!');
    expect(script).not.toContain('msiexec');
    expect(script).toContain('Invoke-WebRequest');
    expect(script).toContain(
      '& $curl --connect-timeout 15 --max-time 300 --retry 2 -#fSLo',
    );
    expect(script).toContain(
      '& $curl --connect-timeout 15 --max-time 300 --retry 2 -fsSLo',
    );
    expect(script).toContain('-TimeoutSec 300');
    expect(script).toContain('$request.Timeout = 10000');
    expect(script).toContain('$request.ReadWriteTimeout = 30000');
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
    expect(script).toContain(':NpmPackageSpec');
    expect(script).toContain('@qwen-code/qwen-code@latest');
    expect(script).toContain('Installing Qwen Code version:');
    expect(script).toContain('QWEN CODE');
    expect(script).toContain(
      'Qwen Code !INSTALLED_VERSION! installed successfully, to start:',
    );
    expect(script).toContain('cd ^<project^>');
    expect(script).toContain('uninstall-qwen-standalone.ps1');
    expect(script).toContain('QWEN_VERSION_POINTER_FILE');
    expect(script).toContain('QWEN_NORMALIZED_VERSION_FILE');
    expect(script).toContain('NORMALIZED_VERSION_FILE');
    expect(script).toContain(
      '[IO.File]::ReadAllText($env:QWEN_VERSION_POINTER_FILE)',
    );
    expect(script).toContain(
      '[IO.File]::WriteAllText($env:QWEN_NORMALIZED_VERSION_FILE',
    );
    expect(script).toContain('set "QWEN_VERSION_VALUE=!VERSION!"');
    expect(script).toContain(
      "$value -match '^v?[0-9]+\\.[0-9]+\\.[0-9]+([.-][A-Za-z0-9]+)*$'",
    );
    expect(script).not.toContain(
      'findstr /R /C:"^[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*[A-Za-z0-9.-]*$"',
    );
    expect(script).not.toContain('[A-Za-z0-9][A-Za-z0-9.-]*$');
    expect(script).not.toContain('rmdir /S /Q "!SUMMARY_INSTALL_DIR!"');
    expect(script).not.toContain('del /F /Q "!INSTALLED_BIN!"');
  });

  it('supports code-server-style standalone install on Windows', () => {
    const script = readScript(
      'scripts/installation/install-qwen-standalone.bat',
    );

    expect(script).toContain('--method METHOD');
    expect(script).toContain('--mirror MIRROR');
    expect(script).toContain('--base-url URL');
    expect(script).toContain('--archive PATH');
    expect(script).toContain(':InstallStandalone');
    expect(script).toContain(':InstallNpm');
    expect(script).toContain(':VerifyChecksum');
    expect(script).toContain(
      'SHA256SUMS not found at !CHECKSUM_FILE!; cannot verify archive',
    );
    expect(script).toContain('Get-FileHash -Algorithm SHA256');
    expect(script).toContain('tokens=1,2');
    expect(script).toContain('CHECKSUM_NAME');
    expect(script).toContain('if "!CHECKSUM_NAME!"=="!ARCHIVE_NAME!"');
    expect(script).not.toContain('findstr /C:"!ARCHIVE_NAME!"');
    expect(script).not.toContain('certutil -hashfile');
    expect(script).toContain('qwen-code-!TARGET!.zip');
    expect(script).toContain(
      'if /i "!PROCESSOR_ARCHITECTURE!"=="AMD64" set "TARGET=win-x64"',
    );
    expect(script).not.toContain('if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64"');
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
    expect(script).not.toContain('-EncodedCommand');
    expect(script).toContain('QWEN_VALIDATE_OPTIONS_SCRIPT');
    expect(script).toContain('$unsafe = [char[]](10,13,33,34');
    expect(script).toContain(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "!QWEN_VALIDATE_OPTIONS_SCRIPT!"',
    );
    expect(script).toContain('if "!INSTALL_BASE:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_DIR:~1,2!"==":/"');
    expect(script).toContain('if "!INSTALL_BIN_DIR:~1,2!"==":/"');
    expect(script).toContain(':ValidateVersion');
    expect(script).toContain(
      'call :ValidateHttpsUrlVar "NPM_REGISTRY" "--registry"',
    );
    expect(script).toContain('$curl = $env:QWEN_INSTALL_CURL_EXE');
    expect(script).toContain('QWEN_INSTALL_CURL_EXE');
    expect(script).toContain('Get-Command curl.exe -CommandType Application');
    expect(script).toContain(
      '--connect-timeout 15 --max-time 300 --retry 2 -#fSLo',
    );
    expect(script).toContain(
      '--connect-timeout 15 --max-time 300 --retry 2 -fsSLo',
    );
    expect(script).toContain('Invoke-WebRequest');
    expect(script).toContain('-TimeoutSec 300');
    expect(script).toContain(
      '[Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13',
    );
    expect(script).toContain(
      '$request = [Net.WebRequest]::Create($env:QWEN_CHECK_URL)',
    );
    expect(script).toContain("Headers.Add('Range', 'bytes=0-0')");
    expect(script).toContain('must start with https://');
    expect(script).toContain('Falling back to npm installation');
    expect(script).toContain('set "STANDALONE_STATUS=!ERRORLEVEL!"');
    expect(script).toContain('if !STANDALONE_STATUS! EQU 2');
    expect(script).toContain('Archive is empty: %~1');
    expect(script).toContain('set "ARG_KEY=%~1"');
    expect(script).toContain('set "ARG_HAS_INLINE_VALUE=0"');
    expect(script).toContain('if "!ARG_HAS_INLINE_VALUE!"=="1"');
    expect(script).toContain('if /i "!ARG_KEY!"=="--version"');
    expect(script).toContain('$value -match');
    expect(script).toContain('QWEN_INSTALL_GITHUB_REPO');
    expect(script).toContain(
      'QWEN_INSTALL_GITHUB_REPO must be in owner/repo format',
    );
    expect(script).toContain(
      'Standalone install failed. Retry with --method npm',
    );
    expect(script).toContain('qwen-code\\node\\node.exe');
    expect(script).toContain('Archive contains symlinks or reparse points');
    expect(script).toContain('unsafe path with control character');
    expect(script).toContain('Failed to update !PATH_SCOPE! PATH');
    expect(script).toContain("$ErrorActionPreference = 'Stop'; try");
    expect(script).toContain('catch { exit 1 }');
    expect(script).toContain('PRE_INSTALL_QWENS_LIST');
    expect(script).toContain('QWEN_INSTALL_ROOT');
    expect(script).toContain('npm fallback also failed');
    expect(script).toContain('echo Downloading !ARCHIVE_NAME!');
    expect(script).toContain(':CreateTempFile');
    expect(script).toContain('/latest/VERSION');
    expect(script).toContain(':ResolveAliyunVersionPath');
    expect(script).toContain(':UseGithubFallbackBaseUrl');
    expect(script).toContain('retrying GitHub mirror');
    expect(script).toContain('endlocal & set "PATH=%INSTALL_BIN_DIR%;%PATH%"');
    expect(script).not.toContain(
      'endlocal & set "PATH=!INSTALL_BIN_DIR!;%PATH%"',
    );
    expect(script).toContain(
      'if /i "!METHOD!"=="detect" exit /b 2\r\n        exit /b 1',
    );
    expect(script).toContain(':RestoreStaleInstallBackup');
    expect(script).toContain('call :RestoreStaleInstallBackup');
    expect(script).not.toContain(
      'ERROR: Failed to remove stale backup directory',
    );
    expect(script).toContain('call :ValidateRawEnvironmentOptions');
    expect(script).toContain('$rawNames = @(');
    expect(script).toContain("'QWEN_INSTALL_VERSION'");
    expect(script.indexOf('$rawNames = @(')).toBeLessThan(
      script.indexOf('set "QWEN_VALIDATE_VERSION=!VERSION!"'),
    );
    expect(script).toContain('set "ARCHIVE_NAME=qwen-code-!TARGET!.zip"');
    expect(script).toContain('Keep :DetectTarget in sync with RELEASE_TARGETS');
    // ARM64 is intentionally not detected: RELEASE_TARGETS has no win-arm64
    // entry, so we want :DetectTarget to fall through to the unsupported-arch
    // branch and let the caller fall back to npm.
    expect(script).not.toContain(
      'if /i "!PROCESSOR_ARCHITECTURE!"=="ARM64" set "TARGET=win-arm64"',
    );
    expect(script).not.toContain('%RANDOM%');
  });

  it('checks out the Windows standalone batch installer with CRLF line endings', () => {
    const attrs = execFileSync(
      'git',
      [
        'check-attr',
        'eol',
        '--',
        'scripts/installation/install-qwen-standalone.bat',
      ],
      { encoding: 'utf8' },
    );

    expect(attrs).toContain(
      'scripts/installation/install-qwen-standalone.bat: eol: crlf',
    );

    const script = readScript(
      'scripts/installation/install-qwen-standalone.bat',
    );
    const bareLfLines = script
      .split(/(?<=\n)/)
      .filter((line) => line.endsWith('\n') && !line.endsWith('\r\n'));
    expect(bareLfLines).toHaveLength(0);
  });

  it('prepends fake Windows tools to both PATH casings', () => {
    const fakeBin = 'C:\\qwen-test-bin';

    const env = prependWindowsPath(fakeBin);

    expect(env.PATH).toMatch(/^C:\\qwen-test-bin;/);
    expect(env.Path).toMatch(/^C:\\qwen-test-bin;/);
  });

  it('creates a fake Windows curl command script', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-curl-helper-'));

    try {
      const fakeCurl = createFakeWindowsCurlCommand(tmpDir);

      expect(fakeCurl).toBe(path.join(tmpDir, 'curl.cmd'));
      expect(readScript(fakeCurl)).toContain('QWEN_FAKE_CURL_LOG');
      expect(readScript(fakeCurl)).toContain(
        '/releases/qwen-code/latest/VERSION',
      );
      expect(readScript(fakeCurl)).toContain('set "destination=%~2"');
      expect(readScript(fakeCurl)).not.toContain('set "destination=%~1"');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('injects Windows processor overrides directly into cmd commands', () => {
    const prepared = prepareWindowsCommand(
      'call "C:\\tools\\install-qwen-standalone.bat"',
      {
        Path: 'C:\\fake-bin',
        PROCESSOR_ARCHITECTURE: 'AMD64',
        PROCESSOR_ARCHITEW6432: '',
      },
      {
        Path: 'C:\\Windows\\System32',
        processor_architecture: 'ARM64',
        PROCESSOR_ARCHITEW6432: 'ARM64',
      },
    );

    expect(prepared.command).toBe(
      'set "PROCESSOR_ARCHITECTURE=AMD64" && set "PROCESSOR_ARCHITEW6432=" && call "C:\\tools\\install-qwen-standalone.bat"',
    );
    expect(prepared.env).toEqual({ Path: 'C:\\fake-bin' });
  });

  it('creates PowerShell validation scripts with a ps1 extension', () => {
    const script = readScript(
      'scripts/installation/install-qwen-standalone.bat',
    );

    expect(script).toContain(
      'call :CreateTempFile "qwen-validate-options" ".ps1"',
    );
    expect(script).toContain(
      "($env:QWEN_TEMP_FILE_PREFIX + '-' + [IO.Path]::GetRandomFileName() + $env:QWEN_TEMP_FILE_EXTENSION)",
    );
  });
});

describe('release-script-utils', () => {
  it('parses SHA256SUMS with BOM, empty lines, and CRLF', async () => {
    const { parseSha256Sums } = await import(releaseScriptUtilsUrl);

    const checksums = parseSha256Sums(
      `\uFEFF${'a'.repeat(64)}  install-qwen-standalone.sh\n\n${'b'.repeat(64)} *install-qwen-standalone.bat\r\n${'c'.repeat(64)}  install-qwen-standalone.ps1\n`,
    );

    expect(checksums.get('install-qwen-standalone.sh')).toBe('a'.repeat(64));
    expect(checksums.get('install-qwen-standalone.bat')).toBe('b'.repeat(64));
    expect(checksums.get('install-qwen-standalone.ps1')).toBe('c'.repeat(64));
  });

  it('rejects malformed SHA256SUMS entries', async () => {
    const { parseSha256Sums } = await import(releaseScriptUtilsUrl);

    expect(() =>
      parseSha256Sums('short-hash  install-qwen-standalone.sh\n'),
    ).toThrow(/Malformed SHA256SUMS line 1/);
  });

  it('rejects duplicate SHA256SUMS entries', async () => {
    const { parseSha256Sums } = await import(releaseScriptUtilsUrl);
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);

    expect(() =>
      parseSha256Sums(
        `${first}  install-qwen-standalone.sh\n${second}  install-qwen-standalone.sh\n`,
      ),
    ).toThrow(/Duplicate SHA256SUMS entry for: install-qwen-standalone\.sh/);
  });

  it('supports --key=value form in parseArgs', async () => {
    const { parseArgs } = await import(releaseScriptUtilsUrl);
    const defs = {
      '--out-dir': { key: 'outDir', type: 'value' },
      '--verbose': { key: 'verbose', type: 'flag' },
    };

    const args = parseArgs(['--out-dir=/tmp/build', '--verbose'], defs);
    expect(args.outDir).toBe('/tmp/build');
    expect(args.verbose).toBe(true);
    expect(args.help).toBe(false);
  });

  it('supports --key value form in parseArgs', async () => {
    const { parseArgs } = await import(releaseScriptUtilsUrl);
    const defs = { '--out-dir': { key: 'outDir', type: 'value' } };

    const args = parseArgs(['--out-dir', '/tmp/build'], defs);
    expect(args.outDir).toBe('/tmp/build');
  });

  it('rejects unknown options and missing values', async () => {
    const { parseArgs } = await import(releaseScriptUtilsUrl);
    const defs = { '--out-dir': { key: 'outDir', type: 'value' } };

    expect(() => parseArgs(['--unknown'], defs)).toThrow(
      /Unknown option: --unknown/,
    );
    expect(() => parseArgs(['--out-dir'], defs)).toThrow(
      /--out-dir requires a value/,
    );
    expect(() => parseArgs(['--out-dir='], defs)).toThrow(
      /--out-dir requires a value/,
    );
    expect(() => parseArgs(['--out-dir', '--help'], defs)).toThrow(
      /--out-dir requires a value/,
    );
    expect(() => parseArgs(['--out-dir=-tmp'], defs)).toThrow(
      /--out-dir requires a value/,
    );
  });

  it('rejects --key=value for flag-type options', async () => {
    const { parseArgs } = await import(releaseScriptUtilsUrl);
    const defs = { '--verbose': { key: 'verbose', type: 'flag' } };

    expect(() => parseArgs(['--verbose=true'], defs)).toThrow(
      /--verbose does not accept a value/,
    );
  });

  it('recognises -h and --help without definitions', async () => {
    const { parseArgs } = await import(releaseScriptUtilsUrl);

    expect(parseArgs(['--help'], {}).help).toBe(true);
    expect(parseArgs(['-h'], {}).help).toBe(true);
    expect(() => parseArgs(['--help=anything'], {})).toThrow(
      /--help does not accept a value/,
    );
  });

  it('fail() wraps messages with ERROR: prefix', async () => {
    const { fail } = await import(releaseScriptUtilsUrl);
    expect(() => fail('something went wrong')).toThrow(
      'ERROR: something went wrong',
    );
  });
});

const STUB_BAT_CONTENT =
  '@echo off\r\n' +
  'set "VERSION=%QWEN_INSTALL_VERSION%"\r\n' +
  'set "REPAIR_PATH=%QWEN_INSTALL_REPAIR_PATH%"\r\n' +
  'set "PATH_SCOPE=%QWEN_INSTALL_PATH_SCOPE%"\r\n' +
  'if "%VERSION%"=="" set "VERSION=latest"\r\n' +
  'set "VERSION=latest"\r\n' +
  'if "%~1"=="--version" set "VERSION=%~2"\r\n' +
  'if /i "%~1"=="--repair-path" set "REPAIR_PATH=1"\r\n' +
  'set "ARG_KEY=%~1"\r\n' +
  'if /i "!ARG_KEY!"=="--path-scope" set "PATH_SCOPE=%~2"\r\n';

const STUB_SH_CONTENT =
  '#!/usr/bin/env bash\n' +
  'VERSION="${QWEN_INSTALL_VERSION:-latest}"\n' +
  'case "$1" in --version) shift; VERSION="$1" ;; --version=*) VERSION="${1#*=}" ;; esac\n';

const STUB_UNINSTALL_SH_CONTENT =
  '#!/usr/bin/env bash\n' +
  'is_qwen_standalone_install_dir() { return 0; }\n' +
  'remove_shell_path_entry() { :; }\n' +
  'QWEN_UNINSTALL_PURGE=""\n';

const STUB_UNINSTALL_PS1_CONTENT =
  'function Test-QwenStandaloneInstallDir { return $true }\n' +
  'function Remove-PathEntryFromAllScopes { }\n' +
  'function Remove-CurrentCmdPathShim { }\n' +
  '$env:QWEN_UNINSTALL_PURGE = ""\n';

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
    expect(packageJson.scripts['package:installation-assets']).toBeUndefined();
    expect(existsSync('scripts/create-standalone-package.js')).toBe(true);
    expect(existsSync('scripts/build-standalone-release.js')).toBe(true);
    expect(existsSync('scripts/build-hosted-installation-assets.js')).toBe(
      true,
    );
    expect(existsSync('scripts/verify-installation-release.js')).toBe(true);
    expect(existsSync('scripts/build-installation-assets.js')).toBe(false);

    const packageScript = readScript('scripts/create-standalone-package.js');
    expect(packageScript).toContain('Copyright 2025 Qwen Team');
    expect(packageScript).toContain("'bundled/qc-helper/docs'");
    expect(packageScript).toContain('DIST_ALLOWED_ENTRIES');
    expect(packageScript).toContain('Unexpected dist asset');
    expect(packageScript).toContain('topLevelDistEntryForPath(outDir)');
    expect(packageScript).toContain("path.join(packageRoot, 'package.json')");
    expect(packageScript).toContain('validateNodeRuntime');
    expect(packageScript).toContain('copyNodeRuntimeEntry');
    expect(packageScript).toContain('symlink cycle');
    expect(packageScript).toContain('refusing to write empty SHA256SUMS');
    expect(packageScript).toContain('--skip-checksums');
    expect(packageScript).toContain('dereference: true');
    expect(packageScript).toContain('fs.createReadStream');
    expect(packageScript).toContain('Expand-Archive');
    expect(packageScript).toContain('Compress-Archive');

    const releaseScript = readScript('scripts/build-standalone-release.js');
    expect(releaseScript).toContain('Copyright 2025 Qwen Team');
    expect(releaseScript).toContain('https://nodejs.org/dist/v${nodeVersion}');
    expect(releaseScript).toContain('SHASUMS256.txt');
    expect(releaseScript).toContain('verifyNodeArchive');
    expect(releaseScript).toContain(
      'EXPECTED_ARCHIVE_COUNT = RELEASE_TARGETS.length',
    );
    expect(releaseScript).toContain('nodeArchiveExtension');
    expect(releaseScript).toContain('fs.createReadStream');
    expect(releaseScript).toContain('expectedArchiveNames');
    expect(releaseScript).toContain('qwen-code-${qwenTarget}');
    expect(releaseScript).toContain('scripts/create-standalone-package.js');
    expect(releaseScript).toContain('--skip-checksums');
    expect(releaseScript).toContain('writeSha256Sums(outDir)');

    const hostedInstallScript = readScript(
      'scripts/build-hosted-installation-assets.js',
    );
    expect(hostedInstallScript).toContain('Copyright 2026 Qwen Team');
    expect(hostedInstallScript).toContain('buildHostedInstallationAssets');
    expect(hostedInstallScript).toContain('HOSTED_INSTALLATION_ASSETS');
    expect(hostedInstallScript).toContain(
      "output: 'install-qwen-standalone.sh'",
    );
    expect(hostedInstallScript).toContain(
      "output: 'install-qwen-standalone.bat'",
    );
    expect(hostedInstallScript).toContain(
      "output: 'install-qwen-standalone.ps1'",
    );
    expect(hostedInstallScript).not.toContain("output: 'install'");

    const releaseVerifyScript = readScript(
      'scripts/verify-installation-release.js',
    );
    expect(releaseVerifyScript).toContain('Copyright 2026 Qwen Team');
    expect(releaseVerifyScript).toContain('verifyReleaseDirectory');
    expect(releaseVerifyScript).toContain('verifyReleaseBaseUrl');
    expect(releaseVerifyScript).toContain('EXPECTED_RELEASE_ASSET_NAMES');
    expect(releaseVerifyScript).toContain('EXPECTED_STANDALONE_ARCHIVE_NAMES');
    expect(releaseVerifyScript).toContain('import { RELEASE_TARGETS }');
    expect(releaseVerifyScript).toContain(
      'standaloneArchiveNamesFromReleaseTargets',
    );
    expect(releaseVerifyScript).not.toContain("'qwen-code-win-x64.zip'");
    expect(releaseVerifyScript).not.toContain('INSTALLATION_ASSET_NAMES');
    expect(releaseVerifyScript).not.toContain('assertInstallAliasMatches');
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

  it('loads the hosted installation release helpers', () => {
    const hostedOutput = execFileSync(
      process.execPath,
      ['scripts/build-hosted-installation-assets.js', '--help'],
      { encoding: 'utf8' },
    );
    const verifierOutput = execFileSync(
      process.execPath,
      ['scripts/verify-installation-release.js', '--help'],
      { encoding: 'utf8' },
    );

    expect(hostedOutput).toContain('package:hosted-installation');
    expect(hostedOutput).toContain('--out-dir PATH');
    expect(verifierOutput).toContain('verify:installation-release');
    expect(verifierOutput).toContain('--dir PATH');
    expect(verifierOutput).toContain('--base-url URL');
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
    expectFail(
      [
        'scripts/verify-installation-release.js',
        '--dir=/tmp',
        '--base-url=https://example.com/r/',
      ],
      /Pass --dir or --base-url, not both/,
    );
    expectFail(
      ['scripts/verify-installation-release.js', '--unknown=foo'],
      /Unknown option: --unknown/,
    );
  });

  it('parses Node.js SHASUMS entries', async () => {
    const { parseChecksums } = await import(standaloneReleaseScriptUrl);

    const checksums = parseChecksums(
      [
        'a'.repeat(64) + '  node-v22.0.0-linux-x64.tar.xz',
        'b'.repeat(64) + ' *node-v22.0.0-win-x64.zip',
        '',
      ].join('\n'),
    );

    expect(checksums.get('node-v22.0.0-linux-x64.tar.xz')).toBe('a'.repeat(64));
    expect(checksums.get('node-v22.0.0-win-x64.zip')).toBe('b'.repeat(64));
  });

  it('validates standalone release checksum output', async () => {
    const { assertStandaloneOutput, RELEASE_TARGETS } = await import(
      standaloneReleaseScriptUrl
    );
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-test-'));

    try {
      const lines = RELEASE_TARGETS.map(({ qwenTarget }) => {
        const extension = qwenTarget === 'win-x64' ? 'zip' : 'tar.gz';
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
    const installShellSource = readScript(
      'scripts/installation/install-qwen-standalone.sh',
    );
    expect(installShellSource).toContain(
      'VERSION="${QWEN_INSTALL_VERSION:-latest}"',
    );
    expect(installShellSource).toContain('--version)');
    expect(installShellSource).toContain('--version requires a value');

    const installBatchSource = readScript(
      'scripts/installation/install-qwen-standalone.bat',
    );
    expect(installBatchSource).toContain('set "VERSION=latest"');
    expect(installBatchSource).toContain(
      'if defined QWEN_INSTALL_VERSION set "VERSION=!QWEN_INSTALL_VERSION!"',
    );
    expect(installBatchSource).toContain('!ARG_KEY!"=="--version"');
    expect(installBatchSource).toContain('--version requires a value');

    const installPowerShellSource = readScript(
      'scripts/installation/install-qwen-standalone.ps1',
    );
    expect(installPowerShellSource).toContain('install-qwen-standalone.bat');
    expect(installPowerShellSource).toContain('Invoke-WebRequest');
    expect(installPowerShellSource).toContain('Download-File');
    expect(installPowerShellSource).toContain(
      'curl.exe --connect-timeout 15 --max-time 300 --retry 2 -sSfLo',
    );
    expect(installPowerShellSource).toContain('-TimeoutSec 300');
    expect(installPowerShellSource).toContain(
      "$global:ProgressPreference = 'SilentlyContinue'",
    );
    expect(installPowerShellSource).toContain('QWEN_INSTALL_VERSION');
    expect(installPowerShellSource).toContain('--version vX.Y.Z');
    expect(installPowerShellSource).toContain('SHA256SUMS');
    expect(installPowerShellSource).toContain('Get-FileHash');
    expect(installPowerShellSource).toContain('Checksum mismatch');
    expect(installPowerShellSource).toContain('@args');
  });

  it('PowerShell hosted entrypoint refreshes the current Windows shell', () => {
    const installPowerShellSource = readScript(
      'scripts/installation/install-qwen-standalone.ps1',
    );
    const installBatchSource = readScript(
      'scripts/installation/install-qwen-standalone.bat',
    );

    expect(installPowerShellSource).toContain('Update-CurrentSessionPath');
    expect(installPowerShellSource).toContain('Install-CurrentCmdPathShim');
    expect(installPowerShellSource).toContain('Save-CurrentCmdPathShim');
    expect(installPowerShellSource).toContain('current-cmd-shim.txt');
    expect(installPowerShellSource).toContain('Test-WritableDirectory');
    expect(installPowerShellSource).toContain('Qwen Code current-session shim');
    expect(installPowerShellSource).toContain(
      'TEMP environment variable is not set',
    );
    expect(installPowerShellSource).toMatch(
      /function Get-QwenInstallBinDir \{[\s\S]*QWEN_INSTALL_BIN_DIR[\s\S]*return Join-Path \(Get-QwenInstallBase\) 'bin'[\s\S]*\}/,
    );
    expect(installPowerShellSource).toContain(
      'Test-SystemManagedPathDirectory',
    );
    expect(installPowerShellSource).not.toContain(
      "$preferredDirectories += Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps'",
    );
    expect(installPowerShellSource).toContain('QWEN_NO_MODIFY_PATH');
    expect(installPowerShellSource).not.toContain('doskey.exe');

    expect(installBatchSource).toContain('QWEN_INSTALLER_PARENT_POWERSHELL');
    expect(installBatchSource).toContain(
      'Final PATH refresh is handled by the PowerShell entrypoint.',
    );
  });

  it('stages hosted installation assets with checksums', async () => {
    const {
      HOSTED_INSTALLATION_ASSET_NAMES,
      HOSTED_INSTALLATION_ASSETS,
      assertHostedInstallationAssetChecksums,
      buildHostedInstallationAssets,
    } = await import(hostedInstallationScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));

    try {
      await buildHostedInstallationAssets(tmpDir);

      const installSh = path.join(tmpDir, 'install-qwen-standalone.sh');
      const installBat = path.join(tmpDir, 'install-qwen-standalone.bat');
      const installPs1 = path.join(tmpDir, 'install-qwen-standalone.ps1');
      const uninstallSh = path.join(tmpDir, 'uninstall-qwen-standalone.sh');
      const uninstallPs1 = path.join(tmpDir, 'uninstall-qwen-standalone.ps1');
      const checksums = readScript(path.join(tmpDir, 'SHA256SUMS'));
      const checksumLines = checksums.trim().split('\n');

      expect(HOSTED_INSTALLATION_ASSET_NAMES).toEqual([
        'install-qwen-standalone.sh',
        'install-qwen-standalone.bat',
        'install-qwen-standalone.ps1',
        'uninstall-qwen-standalone.sh',
        'uninstall-qwen-standalone.ps1',
      ]);
      expect(HOSTED_INSTALLATION_ASSETS.map(({ output }) => output)).toEqual(
        HOSTED_INSTALLATION_ASSET_NAMES,
      );
      expect(readScript(installSh)).toBe(
        readScript('scripts/installation/install-qwen-standalone.sh'),
      );
      expect(readScript(installBat)).toBe(
        readScript('scripts/installation/install-qwen-standalone.bat').replace(
          /\r?\n/g,
          '\r\n',
        ),
      );
      expect(readScript(installPs1)).toBe(
        readScript('scripts/installation/install-qwen-standalone.ps1'),
      );
      expect(readScript(uninstallSh)).toBe(
        readScript('scripts/installation/uninstall-qwen-standalone.sh'),
      );
      expect(readScript(uninstallPs1)).toBe(
        readScript('scripts/installation/uninstall-qwen-standalone.ps1'),
      );
      expect(existsSync(path.join(tmpDir, 'install'))).toBe(false);
      expect(checksumLines.map((line) => line.split('  ')[1])).toEqual([
        'install-qwen-standalone.bat',
        'install-qwen-standalone.ps1',
        'install-qwen-standalone.sh',
        'uninstall-qwen-standalone.ps1',
        'uninstall-qwen-standalone.sh',
      ]);
      expect(checksums).toMatch(
        /^[0-9a-f]{64} {2}install-qwen-standalone\.sh$/m,
      );
      expect(checksums).toMatch(
        /^[0-9a-f]{64} {2}install-qwen-standalone\.bat$/m,
      );
      expect(checksums).toMatch(
        /^[0-9a-f]{64} {2}install-qwen-standalone\.ps1$/m,
      );
      expect(checksums).toMatch(
        /^[0-9a-f]{64} {2}uninstall-qwen-standalone\.sh$/m,
      );
      expect(checksums).toMatch(
        /^[0-9a-f]{64} {2}uninstall-qwen-standalone\.ps1$/m,
      );
      if (process.platform !== 'win32') {
        expect(lstatSync(installSh).mode & 0o111).not.toBe(0);
        expect(lstatSync(uninstallSh).mode & 0o111).not.toBe(0);
      }

      writeFileSync(installSh, 'tampered');
      await expect(
        assertHostedInstallationAssetChecksums(tmpDir),
      ).rejects.toThrow(/Checksum mismatch for install-qwen-standalone\.sh/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects hosted installer sources without pinned hosted behavior', async () => {
    const { buildHostedInstallationAssets } = await import(
      hostedInstallationScriptUrl
    );
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-root-'));
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));
    const sourceDir = path.join(tmpRoot, 'scripts', 'installation');

    try {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.sh'),
        '#!/usr/bin/env bash\n' +
          'VERSION="${QWEN_INSTALL_VERSION:-stable}"\n' +
          'case "$1" in --version) shift; VERSION="$1" ;; esac\n',
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.bat'),
        '@echo off\r\nset "VERSION=latest"\r\n',
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.ps1'),
        "# --version vX.Y.Z\n$env:QWEN_INSTALL_VERSION = 'latest'\n",
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.sh'),
        '#!/usr/bin/env bash\nis_qwen_standalone_install_dir() { return 0; }\n',
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.ps1'),
        'function Test-QwenStandaloneInstallDir { return $true }\n',
      );

      await expect(
        buildHostedInstallationAssets(tmpDir, { root: tmpRoot }),
      ).rejects.toThrow(
        /install-qwen-standalone\.sh default install version must be 'latest'/,
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects hosted installer sources without real version parsing', async () => {
    const { buildHostedInstallationAssets } = await import(
      hostedInstallationScriptUrl
    );
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-root-'));
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));
    const sourceDir = path.join(tmpRoot, 'scripts', 'installation');

    try {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.sh'),
        '#!/usr/bin/env bash\n' +
          'VERSION="${QWEN_INSTALL_VERSION:-latest}"\n' +
          'echo "Usage: --version VERSION"\n',
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.bat'),
        '@echo off\r\nset "VERSION=latest"\r\n',
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.ps1'),
        '& $qwenInstallerPath @args\n# QWEN_INSTALL_VERSION\n',
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.sh'),
        '#!/usr/bin/env bash\nis_qwen_standalone_install_dir() { return 0; }\n',
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.ps1'),
        'function Test-QwenStandaloneInstallDir { return $true }\n',
      );

      await expect(
        buildHostedInstallationAssets(tmpDir, { root: tmpRoot }),
      ).rejects.toThrow(/install-qwen-standalone\.sh.*--version parser/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects hosted ps1 shim with a hardcoded version pin', async () => {
    const { buildHostedInstallationAssets } = await import(
      hostedInstallationScriptUrl
    );
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-root-'));
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));
    const sourceDir = path.join(tmpRoot, 'scripts', 'installation');

    try {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.sh'),
        STUB_SH_CONTENT,
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.bat'),
        STUB_BAT_CONTENT,
      );
      // The ps1 shim has every required behavior pattern but also contains
      // a hardcoded $env:QWEN_INSTALL_VERSION assignment, which must be
      // rejected by the forbidden-patterns guard.
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.ps1'),
        '# QWEN_INSTALL_VERSION documentation\n' +
          '$env:QWEN_INSTALL_VERSION = "v0.1.0"\n' +
          '$tmp = Get-FileHash $env:TEMP\n' +
          '# SHA256SUMS\n' +
          '& $qwenInstallerPath @args\n',
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.sh'),
        STUB_UNINSTALL_SH_CONTENT,
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.ps1'),
        STUB_UNINSTALL_PS1_CONTENT,
      );

      await expect(
        buildHostedInstallationAssets(tmpDir, { root: tmpRoot }),
      ).rejects.toThrow(
        /install-qwen-standalone\.ps1 must not contain.*no hardcoded QWEN_INSTALL_VERSION assignment/,
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows hosted ps1 shim that only documents QWEN_INSTALL_VERSION in comments', async () => {
    const { buildHostedInstallationAssets } = await import(
      hostedInstallationScriptUrl
    );
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-root-'));
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-hosted-install-'));
    const sourceDir = path.join(tmpRoot, 'scripts', 'installation');

    try {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.sh'),
        STUB_SH_CONTENT,
      );
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.bat'),
        STUB_BAT_CONTENT,
      );
      // ps1 contains the exact docstring shipped in production
      // ("$env:QWEN_INSTALL_VERSION = 'vX.Y.Z'") as a `#` comment; the
      // forbidden-pattern guard must not regress on that documented example.
      writeFileSync(
        path.join(sourceDir, 'install-qwen-standalone.ps1'),
        '# To pin a specific release, set $env:QWEN_INSTALL_VERSION before invoking,\n' +
          "# e.g. $env:QWEN_INSTALL_VERSION = 'vX.Y.Z'. This is equivalent to passing\n" +
          '# --version vX.Y.Z to install-qwen-standalone.bat directly.\n' +
          '$tmp = Get-FileHash $env:TEMP\n' +
          '# SHA256SUMS\n' +
          '& $qwenInstallerPath @args\n',
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.sh'),
        STUB_UNINSTALL_SH_CONTENT,
      );
      writeFileSync(
        path.join(sourceDir, 'uninstall-qwen-standalone.ps1'),
        STUB_UNINSTALL_PS1_CONTENT,
      );

      // Build should succeed (only resolves; throws would fail the test).
      await buildHostedInstallationAssets(tmpDir, { root: tmpRoot });
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

      appendFileSync(
        path.join(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES[0]),
        'tamper',
      );
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        new RegExp(
          `Checksum mismatch for ${escapeRegExp(EXPECTED_STANDALONE_ARCHIVE_NAMES[0])}`,
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
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects unexpected files and non-file release assets', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseDirectory } =
      await import(installationReleaseVerificationScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-verify-'));

    try {
      writeStandaloneReleaseAssets(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES);
      writeFileSync(path.join(tmpDir, '.DS_Store'), '');
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /Unexpected file\(s\) in release directory: \.DS_Store/,
      );

      rmSync(path.join(tmpDir, '.DS_Store'));
      rmSync(path.join(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES[0]));
      mkdirSync(path.join(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES[0]));
      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /Release asset is not a regular file: qwen-code-/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnUnix('rejects symlinked release assets and checksum files', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseDirectory } =
      await import(installationReleaseVerificationScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-verify-'));
    let linkedAsset = '';
    let linkedChecksums = '';

    try {
      writeStandaloneReleaseAssets(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES);
      const assetName = EXPECTED_STANDALONE_ARCHIVE_NAMES[0];
      const assetPath = path.join(tmpDir, assetName);
      linkedAsset = path.join(tmpDir, '..', `${assetName}.linked`);
      writeFileSync(linkedAsset, `${assetName}\n`);
      rmSync(assetPath);
      symlinkSync(linkedAsset, assetPath);

      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /Release asset is not a regular file: qwen-code-/,
      );

      rmSync(assetPath);
      writeFileSync(assetPath, `${assetName}\n`);
      const checksumPath = path.join(tmpDir, 'SHA256SUMS');
      linkedChecksums = path.join(tmpDir, '..', 'SHA256SUMS.linked');
      writeFileSync(linkedChecksums, readScript(checksumPath));
      rmSync(checksumPath);
      symlinkSync(linkedChecksums, checksumPath);

      await expect(verifyReleaseDirectory(tmpDir)).rejects.toThrow(
        /SHA256SUMS is not a regular file/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (linkedAsset) rmSync(linkedAsset, { force: true });
      if (linkedChecksums) rmSync(linkedChecksums, { force: true });
    }
  });

  it('verifies release asset URLs from SHA256SUMS', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );
    const fetchedUrls = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
          fetchImpl: async (url, options = {}) => {
            fetchedUrls.push([url, options.method || 'GET', !!options.signal]);
            if (url.endsWith('/SHA256SUMS')) {
              return new Response(checksumContent);
            }
            const assetName = EXPECTED_STANDALONE_ARCHIVE_NAMES.find((name) =>
              url.endsWith(`/${name}`),
            );
            return new Response(`${assetName}\n`);
          },
        }),
      ).resolves.not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }

    expect(fetchedUrls).toContainEqual([
      'https://example.com/qwen-code/v0.0.0/SHA256SUMS',
      'GET',
      true,
    ]);
    for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
      expect(fetchedUrls).toContainEqual([
        `https://example.com/qwen-code/v0.0.0/${assetName}`,
        'GET',
        true,
      ]);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    for (const [url] of fetchedUrls) {
      expect(url).not.toMatch(/install-qwen\.(sh|bat|ps1)$/);
      expect(url).not.toMatch(/\/install$/);
    }
  });

  it('rejects remote release archives whose downloaded hash differs', async () => {
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
          const assetName = EXPECTED_STANDALONE_ARCHIVE_NAMES.find((name) =>
            url.endsWith(`/${name}`),
          );
          if (assetName === EXPECTED_STANDALONE_ARCHIVE_NAMES[0]) {
            return new Response('tampered\n');
          }
          return new Response(`${assetName}\n`);
        },
      }),
    ).rejects.toThrow(/Checksum mismatch for qwen-code-/);
  });

  it('rejects a release base URL that is not https', async () => {
    const { verifyReleaseBaseUrl } = await import(
      installationReleaseVerificationScriptUrl
    );

    await expect(verifyReleaseBaseUrl('file:///tmp/release/')).rejects.toThrow(
      /--base-url must use https/,
    );
    await expect(
      verifyReleaseBaseUrl('http://example.com/release/'),
    ).rejects.toThrow(/--base-url must use https/);
  });

  it('does not follow remote release redirects', async () => {
    const { verifyReleaseBaseUrl } = await import(
      installationReleaseVerificationScriptUrl
    );
    const fetchedOptions = [];

    await expect(
      verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
        fetchImpl: async (_url, options = {}) => {
          fetchedOptions.push(options);
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://169.254.169.254/latest/meta-data/' },
          });
        },
      }),
    ).rejects.toThrow(/Redirect responses are not allowed/);

    expect(fetchedOptions).toHaveLength(1);
    expect(fetchedOptions[0].redirect).toBe('manual');
  });

  it('does not follow remote archive body redirects', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );
    const redirectedAsset = EXPECTED_STANDALONE_ARCHIVE_NAMES[0];

    await expect(
      verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
        fetchImpl: async (url) => {
          if (url.endsWith('/SHA256SUMS')) {
            return new Response(checksumContent);
          }
          if (url.endsWith(`/${redirectedAsset}`)) {
            return new Response(null, {
              status: 302,
              headers: {
                Location: 'https://169.254.169.254/latest/meta-data/',
              },
            });
          }
          const assetName = EXPECTED_STANDALONE_ARCHIVE_NAMES.find((name) =>
            url.endsWith(`/${name}`),
          );
          return new Response(`${assetName}\n`);
        },
      }),
    ).rejects.toThrow(/Redirect responses are not allowed/);
  });

  it('rejects private release base URLs at the verification entry point', async () => {
    const { verifyReleaseBaseUrl } = await import(
      installationReleaseVerificationScriptUrl
    );

    await expect(
      verifyReleaseBaseUrl('https://127.0.0.1/releases/'),
    ).rejects.toThrow(/must not target a private network/);
    await expect(
      verifyReleaseBaseUrl('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/must not target a private network/);
    await expect(
      verifyReleaseBaseUrl('https://sub.localhost./releases/'),
    ).rejects.toThrow(/must not target a private network/);
    // IPv4-mapped IPv6
    await expect(
      verifyReleaseBaseUrl('https://[::ffff:127.0.0.1]/releases/'),
    ).rejects.toThrow(/must not target a private network/);
    // IPv4-compatible IPv6
    await expect(
      verifyReleaseBaseUrl('https://[::7f00:1]/releases/'),
    ).rejects.toThrow(/must not target a private network/);
  });

  it('downloads release archive bodies instead of relying on HEAD probes', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );
    const fetchedUrls = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
          fetchImpl: async (url, options = {}) => {
            const method = options.method || 'GET';
            const range = options.headers?.Range || '';
            fetchedUrls.push([url, method, range]);
            if (url.endsWith('/SHA256SUMS')) {
              return new Response(checksumContent);
            }
            if (method === 'HEAD') {
              return new Response(null, { status: 405 });
            }
            const assetName = EXPECTED_STANDALONE_ARCHIVE_NAMES.find((name) =>
              url.endsWith(`/${name}`),
            );
            return new Response(`${assetName}\n`);
          },
        }),
      ).resolves.not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }

    for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
      const assetUrl = `https://example.com/qwen-code/v0.0.0/${assetName}`;
      expect(fetchedUrls).toContainEqual([assetUrl, 'GET', '']);
      expect(fetchedUrls).not.toContainEqual([assetUrl, 'HEAD', '']);
    }
  });

  it('reports each unavailable asset with its reason', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );
    const unavailableAsset = EXPECTED_STANDALONE_ARCHIVE_NAMES[0];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
          fetchImpl: async (url) => {
            if (url.endsWith('/SHA256SUMS')) {
              return new Response(checksumContent);
            }
            // The first asset always fails (HEAD and Range); the rest succeed
            // on HEAD. Verifier should list only the failing one in the error.
            if (url.endsWith(`/${unavailableAsset}`)) {
              return new Response(null, { status: 404 });
            }
            const assetName = EXPECTED_STANDALONE_ARCHIVE_NAMES.find((name) =>
              url.endsWith(`/${name}`),
            );
            return new Response(`${assetName}\n`);
          },
        }),
      ).rejects.toThrow(
        new RegExp(
          `Unavailable or invalid release asset\\(s\\): ${escapeRegExp(unavailableAsset)} \\(.*\\)`,
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports a single error when every asset URL is unavailable', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent = placeholderChecksumContent(
      EXPECTED_STANDALONE_ARCHIVE_NAMES,
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
          fetchImpl: async (url) => {
            if (url.endsWith('/SHA256SUMS')) {
              return new Response(checksumContent);
            }
            return new Response(null, { status: 503 });
          },
        }),
      ).rejects.toThrow(
        new RegExp(
          `All ${EXPECTED_STANDALONE_ARCHIVE_NAMES.length} release asset URLs are unavailable; check --base-url: https://example\\.com/qwen-code/v0\\.0\\.0/`,
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('parses SHA256SUMS even when the file starts with a UTF-8 BOM', async () => {
    const { EXPECTED_STANDALONE_ARCHIVE_NAMES, verifyReleaseBaseUrl } =
      await import(installationReleaseVerificationScriptUrl);
    const checksumContent =
      '\uFEFF' + placeholderChecksumContent(EXPECTED_STANDALONE_ARCHIVE_NAMES);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        verifyReleaseBaseUrl('https://example.com/qwen-code/v0.0.0', {
          fetchImpl: async (url) => {
            if (url.endsWith('/SHA256SUMS')) {
              return new Response(checksumContent);
            }
            const assetName = EXPECTED_STANDALONE_ARCHIVE_NAMES.find((name) =>
              url.endsWith(`/${name}`),
            );
            return new Response(`${assetName}\n`);
          },
        }),
      ).resolves.not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('prints explicit release asset paths for GitHub release upload', async () => {
    const { EXPECTED_RELEASE_ASSET_NAMES, EXPECTED_STANDALONE_ARCHIVE_NAMES } =
      await import(installationReleaseVerificationScriptUrl);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-release-list-'));

    try {
      writeStandaloneReleaseAssets(tmpDir, EXPECTED_STANDALONE_ARCHIVE_NAMES);

      const output = execFileSync(
        process.execPath,
        [
          'scripts/verify-installation-release.js',
          '--dir',
          tmpDir,
          '--list-release-asset-paths',
        ],
        { encoding: 'utf8' },
      );

      expect(output.trim().split('\n')).toEqual(
        EXPECTED_RELEASE_ASSET_NAMES.map((assetName) =>
          path.join(tmpDir, assetName),
        ),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a runtime archive without a Node executable', () => {
    const createdDist = ensureMinimalDist();
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
      restoreMinimalDist(createdDist);
    }
  });

  it('packages a win-x64 standalone archive', () => {
    const createdDist = ensureMinimalDist();
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
      expect(readScript(path.join(outDir, 'SHA256SUMS'))).toContain(
        'qwen-code-win-x64.zip',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
    }
  }, 30_000);

  it('requires the native audio prebuild when release packaging opts in', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));
    const target = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
    const prebuildDirName =
      process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
    const fakeRuntimeArchive =
      process.platform === 'win32'
        ? createFakeWindowsNodeArchive(tmpDir)
        : createFakeNodeArchive(tmpDir);

    try {
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
          {
            env: {
              ...process.env,
              QWEN_STANDALONE_REQUIRE_AUDIO_CAPTURE_PREBUILD: '1',
            },
            stdio: 'pipe',
          },
        ),
      ).toThrow(new RegExp(`audio-capture prebuild.*${prebuildDirName}`));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
    }
  });

  it('requires a native audio prebuild file when release packaging opts in', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));
    const target = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
    const prebuildDirName =
      process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
    const fakeRuntimeArchive =
      process.platform === 'win32'
        ? createFakeWindowsNodeArchive(tmpDir)
        : createFakeNodeArchive(tmpDir);
    const prebuildDir = path.join(
      'packages',
      'audio-capture',
      'prebuilds',
      prebuildDirName,
    );
    const createdPrebuildDir = !existsSync(prebuildDir);

    try {
      mkdirSync(prebuildDir, { recursive: true });

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
          {
            env: {
              ...process.env,
              QWEN_STANDALONE_REQUIRE_AUDIO_CAPTURE_PREBUILD: '1',
            },
            stdio: 'pipe',
          },
        ),
      ).toThrow(new RegExp(`audio-capture prebuild.*${prebuildDirName}`));
    } finally {
      if (createdPrebuildDir) {
        rmSync(prebuildDir, { recursive: true, force: true });
      }
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
    }
  });

  itOnUnix('does not package audio-capture test artifacts', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-test-'));
    const prebuildDir = path.join(
      'packages',
      'audio-capture',
      'prebuilds',
      'linux-x64',
    );
    const prebuildFile = path.join(
      prebuildDir,
      '@qwen-code+audio-capture.node',
    );
    const createdPrebuildDir = !existsSync(prebuildDir);
    const createdPrebuild = !existsSync(prebuildFile);

    try {
      mkdirSync(prebuildDir, { recursive: true });
      if (createdPrebuild) {
        writeFileSync(prebuildFile, 'fake native addon\n');
      }

      const archive = packageFakeStandalone(tmpDir);
      const extractDir = path.join(tmpDir, 'extract');
      mkdirSync(extractDir, { recursive: true });
      execFileSync('tar', ['-xzf', archive, '-C', extractDir], {
        stdio: 'ignore',
      });

      const addonDist = path.join(
        extractDir,
        'qwen-code',
        'lib',
        'node_modules',
        '@qwen-code',
        'audio-capture',
        'dist',
      );
      expect(existsSync(path.join(addonDist, 'index.js'))).toBe(true);
      expect(existsSync(path.join(addonDist, 'platform.test.js'))).toBe(false);
      expect(existsSync(path.join(addonDist, 'platform.test.d.ts'))).toBe(
        false,
      );
      expect(existsSync(path.join(addonDist, 'platform.test.js.map'))).toBe(
        false,
      );
    } finally {
      if (createdPrebuild) {
        rmSync(prebuildFile, { force: true });
      }
      if (createdPrebuildDir) {
        rmSync(prebuildDir, { recursive: true, force: true });
      }
      restoreMinimalDist(createdDist);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnUnix('dereferences safe Node.js runtime symlinks', () => {
    const createdDist = ensureMinimalDist();
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
      restoreMinimalDist(createdDist);
    }
  });

  itOnUnix('rejects Node.js runtime symlinks that escape the archive', () => {
    const createdDist = ensureMinimalDist();
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
      restoreMinimalDist(createdDist);
    }
  });

  itOnUnix('rejects Node.js runtime symlink cycles', () => {
    const createdDist = ensureMinimalDist();
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
      restoreMinimalDist(createdDist);
    }
  });

  it('rejects unexpected dist assets', () => {
    const createdDist = ensureMinimalDist();
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
      restoreMinimalDist(createdDist);
    }
  });

  it('syncs standalone and hosted installation assets during release', () => {
    const releaseWorkflow = readScript('.github/workflows/release.yml');
    const ossWorkflow = readScript('.github/workflows/sync-release-to-oss.yml');

    // release.yml builds standalone archives, verifies them, and creates GitHub Release
    expect(releaseWorkflow).toContain('npm run package:standalone:release --');
    expect(releaseWorkflow).toContain(
      'QWEN_STANDALONE_REQUIRE_AUDIO_CAPTURE_PREBUILD',
    );
    expect(releaseWorkflow).toContain(
      'npm run verify:installation-release -- --dir dist/standalone',
    );
    expect(releaseWorkflow).not.toContain('package:installation-assets');
    expect(releaseWorkflow).not.toContain('verify_node_checksum()');
    expect(releaseWorkflow).not.toContain('download_node()');
    const createReleaseStepIndex = releaseWorkflow.indexOf(
      "- name: 'Create GitHub Release and Tag'",
    );
    expect(createReleaseStepIndex).toBeGreaterThanOrEqual(0);
    const createReleaseStep = releaseWorkflow.slice(createReleaseStepIndex);
    expect(createReleaseStep).toContain('dist/standalone/qwen-code-*');
    expect(createReleaseStep).toContain('dist/standalone/SHA256SUMS');
    // OSS upload logic must not remain in release.yml
    expect(releaseWorkflow).not.toContain('secrets.ALIYUN_OSS_ACCESS_KEY_ID');
    expect(releaseWorkflow).not.toContain(
      'node scripts/upload-aliyun-oss-assets.js',
    );
    expect(releaseWorkflow).not.toContain('package:hosted-installation');

    // sync-release-to-oss.yml handles OSS sync triggered by release publish
    expect(ossWorkflow).toContain(
      'npm run package:hosted-installation -- --out-dir dist/installation',
    );
    expect(ossWorkflow).toContain('--list-release-asset-paths');
    expect(ossWorkflow).toContain(
      'npm run verify:installation-release -- --dir dist/standalone',
    );
    expect(ossWorkflow).toContain('secrets.ALIYUN_OSS_ACCESS_KEY_ID');
    expect(ossWorkflow).toContain('secrets.ALIYUN_OSS_ACCESS_KEY_SECRET');
    expect(ossWorkflow).toContain('vars.ALIYUN_OSS_BUCKET');
    expect(ossWorkflow).toContain('vars.ALIYUN_OSS_ENDPOINT');
    expect(ossWorkflow).toContain('vars.OSSUTIL_URL');
    expect(ossWorkflow).toContain('vars.OSSUTIL_SHA256');
    expect(ossWorkflow).not.toContain('sudo install');
    expect(ossWorkflow).toContain('${HOME}/.local/bin/ossutil');
    expect(ossWorkflow).toContain('${GITHUB_PATH}');
    expect(existsSync('scripts/upload-aliyun-oss-assets.js')).toBe(true);
    expect(ossWorkflow).toContain('node scripts/upload-aliyun-oss-assets.js');
    expect(ossWorkflow.match(/upload_asset\(\)/g) || []).toHaveLength(0);
    expect(ossWorkflow).toContain('releases/qwen-code/${RELEASE_TAG}');
    expect(ossWorkflow).toContain('releases/qwen-code/latest');
    expect(ossWorkflow).not.toContain(
      'upload_release_assets "releases/qwen-code/latest"',
    );

    const syncStepIndex = ossWorkflow.indexOf(
      "- name: 'Sync Release Assets to Aliyun OSS'",
    );
    const packageHostedStepIndex = ossWorkflow.indexOf(
      "- name: 'Package Hosted Installation Assets'",
    );
    const verifyStepIndex = ossWorkflow.indexOf(
      "- name: 'Verify Aliyun OSS Release Assets'",
    );
    const publishLatestStepIndex = ossWorkflow.indexOf(
      "- name: 'Publish Aliyun OSS Latest VERSION'",
    );
    const syncHostedStepIndex = ossWorkflow.indexOf(
      "- name: 'Sync Hosted Installation Assets to Aliyun OSS'",
    );
    const verifyHostedStepIndex = ossWorkflow.indexOf(
      "- name: 'Verify Aliyun OSS Hosted Installation Assets'",
    );
    expect(syncStepIndex).toBeGreaterThanOrEqual(0);
    expect(packageHostedStepIndex).toBeGreaterThanOrEqual(0);
    expect(verifyStepIndex).toBeGreaterThan(syncStepIndex);
    expect(syncHostedStepIndex).toBeGreaterThan(verifyStepIndex);
    expect(verifyHostedStepIndex).toBeGreaterThan(syncHostedStepIndex);
    // Latest VERSION pointer must flip only after every release asset and
    // hosted installer object is uploaded and verified.
    expect(publishLatestStepIndex).toBeGreaterThan(verifyHostedStepIndex);
    expect(ossWorkflow.slice(syncStepIndex, verifyStepIndex)).not.toContain(
      'releases/qwen-code/latest/VERSION',
    );
    expect(ossWorkflow.slice(publishLatestStepIndex)).toContain(
      'releases/qwen-code/latest/VERSION',
    );
    const syncStep = ossWorkflow.slice(syncStepIndex, verifyStepIndex);
    expect(syncStep).not.toContain('dist/installation/');
    expect(syncStep).not.toContain('installation/install-qwen-standalone.sh');
    const syncHostedStep = ossWorkflow.slice(
      syncHostedStepIndex,
      verifyHostedStepIndex,
    );
    expect(syncHostedStep).toContain(
      'dist/installation/install-qwen-standalone.sh',
    );
    expect(syncHostedStep).toContain(
      'dist/installation/install-qwen-standalone.bat',
    );
    expect(syncHostedStep).toContain(
      'dist/installation/install-qwen-standalone.ps1',
    );
    expect(syncHostedStep).toContain(
      'dist/installation/uninstall-qwen-standalone.sh',
    );
    expect(syncHostedStep).toContain(
      'dist/installation/uninstall-qwen-standalone.ps1',
    );
    expect(syncHostedStep).toContain('--prefix "installation/${RELEASE_TAG}"');
    expect(syncHostedStep).toContain('--prefix "installation"');
    expect(syncHostedStep).toContain(
      'dist/installation/install-qwen-standalone.sh',
    );
    const uploadScript = readScript('scripts/upload-aliyun-oss-assets.js');
    expect(uploadScript).toContain("'--acl'");
    expect(uploadScript).toContain("'public-read'");
    expect(ossWorkflow).toContain(
      'curl -fsSL --connect-timeout 15 --max-time 300 "${OSSUTIL_URL}"',
    );
    expect(ossWorkflow).toContain(
      'npm run verify:installation-release -- --base-url "${ALIYUN_OSS_PUBLIC_BASE_URL}/releases/qwen-code/${RELEASE_TAG}"',
    );
    expect(ossWorkflow).toContain(
      'latest_version="$(curl -fsSL --connect-timeout 15 --max-time 300 "${ALIYUN_OSS_PUBLIC_BASE_URL}/releases/qwen-code/latest/VERSION" | tr -d',
    );
    expect(ossWorkflow).not.toContain(
      'npm run verify:installation-release -- --base-url "${ALIYUN_OSS_PUBLIC_BASE_URL}/releases/qwen-code/latest"',
    );
    const verifyStep = ossWorkflow.slice(verifyStepIndex, syncHostedStepIndex);
    expect(verifyStep).not.toContain('hosted_tmp_dir');
    const verifyHostedStep = ossWorkflow.slice(verifyHostedStepIndex);
    expect(ossWorkflow).toContain('hosted_tmp_dir="$(mktemp -d)"');
    expect(verifyHostedStep).toContain(
      'url="${ALIYUN_OSS_PUBLIC_BASE_URL}/installation/${RELEASE_TAG}/${asset}"',
    );
    expect(verifyHostedStep).toContain(
      'global_url="${ALIYUN_OSS_PUBLIC_BASE_URL}/installation/${asset}"',
    );
    expect(verifyHostedStep).toContain(
      'curl -fsSL --connect-timeout 15 --max-time 300 "${url}"',
    );
    expect(verifyHostedStep).toContain(
      'curl -fsSL --connect-timeout 15 --max-time 300 "${global_url}"',
    );
    expect(ossWorkflow).toContain(
      'cmp -s "dist/installation/SHA256SUMS" "${hosted_tmp_dir}/versioned/SHA256SUMS"',
    );
    expect(ossWorkflow).toContain(
      'cmp -s "dist/installation/SHA256SUMS" "${hosted_tmp_dir}/global/SHA256SUMS"',
    );
    expect(ossWorkflow).toContain(
      '(cd "${hosted_tmp_dir}/versioned" && sha256sum -c SHA256SUMS)',
    );
    expect(ossWorkflow).toContain(
      '(cd "${hosted_tmp_dir}/global" && sha256sum -c SHA256SUMS)',
    );
  });

  it('automatically publishes the VSCode companion after stable CLI releases', () => {
    const workflow = readScript(
      '.github/workflows/release-vscode-companion.yml',
    );

    expect(workflow).toContain("release:\n    types: ['published']");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("github.event_name != 'release'");
    expect(workflow).toContain(
      "startsWith(github.event.release.tag_name, 'v')",
    );
    expect(workflow).toContain('github.event.release.prerelease == false');
    expect(
      workflow.match(
        /github\.event\.release\.tag_name \|\| github\.event\.inputs\.ref \|\| github\.sha/g,
      ) || [],
    ).toHaveLength(3);
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
    expect(guide).toContain('installation/install-qwen-standalone.sh');
    expect(guide).toContain('installation/install-qwen-standalone.bat');
    expect(guide).toContain('installation/install-qwen-standalone.ps1');
    expect(guide).toContain('installation/uninstall-qwen-standalone.sh');
    expect(guide).toContain('installation/uninstall-qwen-standalone.ps1');
    expect(guide).toContain('ALIYUN_OSS_ACCESS_KEY_ID');
    expect(guide).toContain('ALIYUN_OSS_ACCESS_KEY_SECRET');
    expect(guide).toContain('ALIYUN_OSS_BUCKET');
    expect(guide).toContain('ALIYUN_OSS_ENDPOINT');
    expect(guide).toContain('hosted entrypoint');
    expect(guide).toContain('node-pty');
    expect(guide).toContain('clipboard');
  });

  it('provides standalone uninstall scripts that clean install-owned files only', () => {
    const uninstallShellSource = readScript(
      'scripts/installation/uninstall-qwen-standalone.sh',
    );
    const uninstallPowerShellSource = readScript(
      'scripts/installation/uninstall-qwen-standalone.ps1',
    );

    expect(uninstallShellSource).toContain('is_qwen_standalone_install_dir');
    expect(uninstallShellSource).toContain('remove_shell_path_entry');
    expect(uninstallShellSource).toContain('shell_quote');
    expect(uninstallShellSource).toContain('quoted_qwen_bin');
    expect(uninstallShellSource).toContain('QWEN_UNINSTALL_PURGE');
    expect(uninstallShellSource).toContain('Preserving');
    expect(uninstallShellSource).toContain('source.json');

    expect(uninstallPowerShellSource).toContain(
      'Test-QwenStandaloneInstallDir',
    );
    expect(uninstallPowerShellSource).toContain(
      'Remove-PathEntryFromAllScopes',
    );
    expect(uninstallPowerShellSource).toContain('Remove-CurrentCmdPathShim');
    expect(uninstallPowerShellSource).toContain(
      'Remove-RecordedCurrentCmdPathShim',
    );
    expect(uninstallPowerShellSource).toContain('current-cmd-shim.txt');
    expect(uninstallPowerShellSource).toContain(
      'Qwen Code current-session shim',
    );
    expect(uninstallPowerShellSource).toContain('QWEN_UNINSTALL_PURGE');
    expect(uninstallPowerShellSource).toContain('Preserving');
    expect(uninstallPowerShellSource).toMatch(
      /if \(\$installWasManaged\) \{\n\s+Remove-CurrentCmdPathShim\n\s+Remove-Item/,
    );
    expect(uninstallPowerShellSource).not.toMatch(
      /\$installWasManaged = Test-QwenStandaloneInstallDir[^\n]*\n\nRemove-CurrentCmdPathShim\n\nif \(\$installWasManaged\)/,
    );
  });
});

describe('isPrivateOrReservedHost', () => {
  it('rejects empty hostname', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('')).toBe(true);
  });

  it('rejects localhost variants', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('localhost')).toBe(true);
    expect(isPrivateOrReservedHost('sub.localhost')).toBe(true);
    expect(isPrivateOrReservedHost('localhost.')).toBe(true);
    expect(isPrivateOrReservedHost('sub.localhost.')).toBe(true);
    expect(isPrivateOrReservedHost('LOCALHOST')).toBe(true);
  });

  it('rejects private IPv4 addresses', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('169.254.1.1')).toBe(true);
  });

  it('rejects IPv6 loopback and link-local', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('::1')).toBe(true);
    expect(isPrivateOrReservedHost('[::1]')).toBe(true);
    expect(isPrivateOrReservedHost('fe80::1')).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 addresses (2-part hex)', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('::ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedHost('::ffff:a00:1')).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 addresses (3-part hex from Node normalization)', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('::ffff:0:7f00:1')).toBe(true);
    expect(isPrivateOrReservedHost('::ffff:0:a00:1')).toBe(true);
    expect(isPrivateOrReservedHost('::ffff:0:c0a8:101')).toBe(true);
  });

  it('does not collapse nonzero 3-part IPv4-mapped IPv6 prefixes', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('::ffff:abcd:7f00:1')).toBe(false);
  });

  it('blocks IPv4-compatible IPv6 addresses (deprecated but parseable)', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    // ::7f00:1 → 127.0.0.1 (loopback)
    expect(isPrivateOrReservedHost('::7f00:1')).toBe(true);
    // ::a9fe:a9fe → 169.254.169.254 (cloud metadata)
    expect(isPrivateOrReservedHost('::a9fe:a9fe')).toBe(true);
    // ::a00:1 → 10.0.0.1 (private)
    expect(isPrivateOrReservedHost('::a00:1')).toBe(true);
    // ::c0a8:101 → 192.168.1.1 (private)
    expect(isPrivateOrReservedHost('::c0a8:101')).toBe(true);
  });

  it('allows public IP addresses', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedHost('142.250.80.46')).toBe(false);
    expect(isPrivateOrReservedHost('example.com')).toBe(false);
    expect(isPrivateOrReservedHost('example.com.')).toBe(false);
    // Public IPv6
    expect(isPrivateOrReservedHost('2607:f8b0:4004:800::200e')).toBe(false);
  });

  it('does not flag decimal or octal encoded IPs (URL API normalizes them before reaching the helper)', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    // Decimal-encoded 127.0.0.1 — not 4 dotted parts, so parseIpv4Octets
    // returns null and the value is treated as a non-IP hostname (safe).
    expect(isPrivateOrReservedHost('2130706433')).toBe(false);
    // Octal-encoded 127.0.0.1 — parsed as dotted quad but leading zeros
    // are interpreted as decimal by Number(), so 0177 → 177 (not 127).
    // The resulting IP 177.0.0.1 is public, so this returns false.
    // Node's URL API normalizes these before they reach isPrivateOrReservedHost.
    expect(isPrivateOrReservedHost('0177.0.0.1')).toBe(false);
  });

  it('handles IPv6 zone IDs and empty brackets', async () => {
    const { isPrivateOrReservedHost } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(isPrivateOrReservedHost('[]')).toBe(true);
    // Node's URL API rejects URLs with IPv6 zone IDs as invalid, so this
    // value would not normally reach isPrivateOrReservedHost. If it arrives
    // raw, fe80::1%25eth0 contains ':' and is parsed as IPv6 link-local.
    expect(isPrivateOrReservedHost('fe80::1%25eth0')).toBe(true);
  });
});

describe('redactUrlForLog', () => {
  it('strips username and password from URLs', async () => {
    const { redactUrlForLog } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(redactUrlForLog('https://user:pass@example.com/path')).toBe(
      'https://example.com/path',
    );
  });

  it('strips query parameters to prevent credential leakage', async () => {
    const { redactUrlForLog } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(
      redactUrlForLog(
        'https://example.com/path?X-Amz-Signature=secret&token=abc',
      ),
    ).toBe('https://example.com/path');
  });

  it('strips URL fragments to prevent credential leakage', async () => {
    const { redactUrlForLog } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(
      redactUrlForLog('https://example.com/path#access_token=secret'),
    ).toBe('https://example.com/path');
  });

  it('redacts malformed URLs containing @, ?, or #', async () => {
    const { redactUrlForLog } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(redactUrlForLog('not-a-url@with-creds')).toBe('<redacted URL>');
    expect(redactUrlForLog('not-a-url?with-query')).toBe('<redacted URL>');
    expect(redactUrlForLog('not-a-url#with-fragment')).toBe('<redacted URL>');
  });

  it('passes through safe non-URL strings', async () => {
    const { redactUrlForLog } = await import(
      installationReleaseVerificationScriptUrl
    );
    expect(redactUrlForLog('just-a-string')).toBe('just-a-string');
  });
});

// These end-to-end installs spawn child processes via execFileSync;
// the default 5s vitest timeout is too tight on slow CI runners even
// without Windows' cmd.exe + node.exe startup overhead.
describe('Linux/macOS installer end-to-end', { timeout: 15000 }, () => {
  itOnUnix(
    'installs a local standalone archive with checksum verification',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        const output = runUnixInstaller(archive, installRoot, home).toString();

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
        expect(output).toContain('Installing Qwen Code version: latest');
        expect(output).toContain('installed successfully, to start:');
        expect(output).toContain('0.0.0-smoke');
        expect(output).toContain('cd <project>');
        expect(output).toContain('github.com/QwenLM/qwen-code');
        expect(output).not.toContain('rm -rf');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix(
    'resolves Aliyun latest through a single VERSION pointer before downloading archives',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const checksumFile = path.join(path.dirname(archive), 'SHA256SUMS');
        const fakeBin = path.join(tmpDir, 'bin');
        const curlLog = path.join(tmpDir, 'curl-urls.log');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');

        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(
          path.join(fakeBin, 'uname'),
          [
            '#!/usr/bin/env sh',
            'case "$1" in',
            '  -s) echo Linux ;;',
            '  -m) echo x86_64 ;;',
            '  *) /usr/bin/uname "$@" ;;',
            'esac',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'curl'),
          [
            '#!/usr/bin/env sh',
            'url=',
            'dest=',
            'while [ "$#" -gt 0 ]; do',
            '  case "$1" in',
            '    -o) shift; dest="$1" ;;',
            '    http*) url="$1" ;;',
            '  esac',
            '  shift',
            'done',
            'printf "%s\\n" "$url" >> "$QWEN_FAKE_CURL_LOG"',
            'case "$url" in',
            '  */releases/qwen-code/latest/VERSION)',
            '    if [ -n "$dest" ]; then',
            '      printf "v0.0.0-smoke\\n" > "$dest"',
            '    else',
            '      printf "v0.0.0-smoke\\n"',
            '    fi ;;',
            '  */releases/qwen-code/v0.0.0-smoke/qwen-code-linux-x64.tar.gz)',
            '    cp "$QWEN_FAKE_ARCHIVE" "$dest" ;;',
            '  */releases/qwen-code/v0.0.0-smoke/SHA256SUMS)',
            '    cp "$QWEN_FAKE_SHA256SUMS" "$dest" ;;',
            '  *)',
            '    echo "unexpected url: $url" >&2',
            '    exit 22 ;;',
            'esac',
            '',
          ].join('\n'),
        );
        chmodSync(path.join(fakeBin, 'uname'), 0o755);
        chmodSync(path.join(fakeBin, 'curl'), 0o755);

        const output = execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-standalone.sh',
            '--method',
            'standalone',
            '--mirror',
            'aliyun',
            '--source',
            'smoke',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH}`,
              QWEN_FAKE_ARCHIVE: archive,
              QWEN_FAKE_SHA256SUMS: checksumFile,
              QWEN_FAKE_CURL_LOG: curlLog,
              QWEN_INSTALL_ROOT: installRoot,
            },
            stdio: 'pipe',
          },
        ).toString();

        const curlUrls = readScript(curlLog);
        expect(curlUrls).toContain('/releases/qwen-code/latest/VERSION');
        expect(curlUrls).toContain(
          '/releases/qwen-code/v0.0.0-smoke/qwen-code-linux-x64.tar.gz',
        );
        expect(curlUrls).toContain(
          '/releases/qwen-code/v0.0.0-smoke/SHA256SUMS',
        );
        expect(curlUrls).not.toContain(
          '/releases/qwen-code/latest/qwen-code-linux-x64.tar.gz',
        );
        expect(output).toContain('Downloading qwen-code-linux-x64.tar.gz');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
    15000,
  );

  itOnUnix(
    'tries GitHub before npm when auto-selected Aliyun archive is unavailable',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const checksumFile = path.join(path.dirname(archive), 'SHA256SUMS');
        const fakeBin = path.join(tmpDir, 'bin');
        const curlLog = path.join(tmpDir, 'curl-urls.log');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');

        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(
          path.join(fakeBin, 'uname'),
          [
            '#!/usr/bin/env sh',
            'case "$1" in',
            '  -s) echo Linux ;;',
            '  -m) echo x86_64 ;;',
            '  *) /usr/bin/uname "$@" ;;',
            'esac',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'curl'),
          [
            '#!/usr/bin/env sh',
            'url=',
            'dest=',
            'is_head=0',
            'while [ "$#" -gt 0 ]; do',
            '  case "$1" in',
            '    -o) shift; dest="$1" ;;',
            '    -*) case "$1" in *I*) is_head=1 ;; esac ;;',
            '    http*) url="$1" ;;',
            '  esac',
            '  shift',
            'done',
            'printf "%s\\n" "$url" >> "$QWEN_FAKE_CURL_LOG"',
            'if [ "$is_head" = "1" ]; then',
            '  case "$url" in',
            '    */releases/qwen-code/latest/VERSION)',
            '      exit 0 ;;',
            '    */releases/latest/download/SHA256SUMS)',
            '      exit 22 ;;',
            '    */releases/qwen-code/v0.0.0-smoke/qwen-code-linux-x64.tar.gz)',
            '      exit 22 ;;',
            '    */releases/download/v0.0.0-smoke/qwen-code-linux-x64.tar.gz)',
            '      exit 0 ;;',
            '    *)',
            '      echo "unexpected HEAD url: $url" >&2',
            '      exit 22 ;;',
            '  esac',
            'fi',
            'case "$url" in',
            '  */releases/qwen-code/latest/VERSION)',
            '    printf "v0.0.0-smoke\\n" ;;',
            '  */releases/download/v0.0.0-smoke/qwen-code-linux-x64.tar.gz)',
            '    cp "$QWEN_FAKE_ARCHIVE" "$dest" ;;',
            '  */releases/download/v0.0.0-smoke/SHA256SUMS)',
            '    cp "$QWEN_FAKE_SHA256SUMS" "$dest" ;;',
            '  *)',
            '    echo "unexpected url: $url" >&2',
            '    exit 22 ;;',
            'esac',
            '',
          ].join('\n'),
        );
        chmodSync(path.join(fakeBin, 'uname'), 0o755);
        chmodSync(path.join(fakeBin, 'curl'), 0o755);

        const output = execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-standalone.sh',
            '--method',
            'detect',
            '--mirror',
            'auto',
            '--source',
            'smoke',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH}`,
              QWEN_FAKE_ARCHIVE: archive,
              QWEN_FAKE_SHA256SUMS: checksumFile,
              QWEN_FAKE_CURL_LOG: curlLog,
              QWEN_INSTALL_ROOT: installRoot,
            },
            stdio: 'pipe',
          },
        ).toString();

        const curlUrls = readScript(curlLog);
        expect(curlUrls).toContain('/releases/qwen-code/latest/VERSION');
        expect(curlUrls).toContain(
          '/releases/qwen-code/v0.0.0-smoke/qwen-code-linux-x64.tar.gz',
        );
        expect(curlUrls).toContain(
          '/releases/download/v0.0.0-smoke/qwen-code-linux-x64.tar.gz',
        );
        expect(curlUrls).toContain(
          '/releases/download/v0.0.0-smoke/SHA256SUMS',
        );
        expect(output).toContain(
          'Aliyun standalone archive not found; retrying GitHub mirror.',
        );
        expect(output).toContain('Downloading qwen-code-linux-x64.tar.gz');
        expect(output).not.toContain('Falling back to npm installation');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
    15000,
  );

  itOnUnix('uninstalls standalone files while preserving user config', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-uninstall-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const home = path.join(tmpDir, 'home');
      runUnixInstaller(archive, installRoot, home);

      const rcFile = path.join(home, '.zshrc');
      writeFileSync(
        rcFile,
        [
          'before',
          '# Qwen Code PATH block begin',
          `export PATH='${installRoot}/bin':$PATH`,
          '# Qwen Code PATH block end',
          'after',
        ].join('\n') + '\n',
      );
      const qwenDir = path.join(home, '.qwen');
      const sourceJson = path.join(qwenDir, 'source.json');
      const settingsJson = path.join(qwenDir, 'settings.json');
      writeFileSync(settingsJson, '{"theme":"dark"}\n');

      runUnixUninstaller(installRoot, home);

      expect(existsSync(path.join(installRoot, 'lib', 'qwen-code'))).toBe(
        false,
      );
      expect(existsSync(path.join(installRoot, 'bin', 'qwen'))).toBe(false);
      expect(readScript(rcFile)).toBe('before\nafter\n');
      expect(existsSync(sourceJson)).toBe(true);
      expect(existsSync(settingsJson)).toBe(true);

      runUnixUninstaller(installRoot, home, { QWEN_UNINSTALL_PURGE: '1' });

      expect(existsSync(sourceJson)).toBe(false);
      expect(existsSync(settingsJson)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
    }
  });

  itOnUnix(
    'removes only installer-owned shell rc PATH lines during uninstall',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-uninstall-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runUnixInstaller(archive, installRoot, home);

        const rcFile = path.join(home, '.zshrc');
        writeFileSync(
          rcFile,
          [
            'before',
            '# Added by qwen-code installer (multi-qwen shadow fix)   ',
            `export PATH='${installRoot}/bin':$PATH`,
            'middle',
            '# Added by qwen-code installer (multi-qwen shadow fix)',
            'echo keep-me',
            'after',
          ].join('\n') + '\n',
        );

        runUnixUninstaller(installRoot, home);

        expect(readScript(rcFile)).toBe(
          ['before', 'middle', 'echo keep-me', 'after'].join('\n') + '\n',
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix(
    'warns when an existing qwen could shadow the standalone install',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const fakeBin = path.join(tmpDir, 'old-bin');
        const existingQwen = path.join(fakeBin, 'qwen');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');

        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(existingQwen, '#!/usr/bin/env sh\necho old-qwen\n');
        chmodSync(existingQwen, 0o755);

        const output = runUnixInstaller(
          archive,
          installRoot,
          home,
          'standalone',
          {
            PATH: `${fakeBin}:${process.env.PATH}`,
            SHELL: '/bin/bash',
          },
        ).toString();

        const installedBin = path.join(installRoot, 'bin', 'qwen');
        const bashrc = readScript(path.join(home, '.bashrc'));

        expect(output).toContain('installed successfully, to start:');
        expect(output).toContain(
          'Other qwen executables were found and may shadow the new install',
        );
        expect(output).toContain(existingQwen);
        expect(output).toContain('source ~/.bashrc');
        expect(bashrc).toContain('# Qwen Code PATH block begin');
        expect(bashrc).toContain(
          `export PATH='${path.join(installRoot, 'bin')}':$PATH`,
        );

        const resolvedQwen = execFileSync(
          'bash',
          ['-c', 'source "${HOME}/.bashrc"; command -v qwen'],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH}`,
              SHELL: '/bin/bash',
            },
          },
        )
          .toString()
          .trim();
        expect(resolvedQwen).toBe(installedBin);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix(
    'prints a shell reload hint when the install dir is not on PATH yet',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');

        const output = runUnixInstaller(
          archive,
          installRoot,
          home,
          'standalone',
          // Minimal PATH keeps the fresh install dir off the invoking
          // shell's PATH so the reload hint is always printed. The shadow
          // warning is NOT asserted on either way: PRE_INSTALL_QWENS also
          // scans well-known absolute paths (/usr/local/bin etc.), so its
          // output depends on the host machine.
          { SHELL: '/bin/bash', PATH: '/usr/bin:/bin' },
        ).toString();

        expect(output).toContain('source ~/.bashrc');
        expect(output).toContain('Load new PATH');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix(
    'points the reload hint at ~/.bash_profile when it is the rc file written',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        const bashProfile = path.join(home, '.bash_profile');

        // Default macOS bash setup: ~/.bash_profile exists, ~/.bashrc does
        // not, so maybe_update_shell_path falls back to ~/.bash_profile.
        mkdirSync(home, { recursive: true });
        writeFileSync(bashProfile, '# existing profile\n');

        const output = runUnixInstaller(
          archive,
          installRoot,
          home,
          'standalone',
          { SHELL: '/bin/bash', PATH: '/usr/bin:/bin' },
        ).toString();

        expect(readFileSync(bashProfile, 'utf8')).toContain(
          '# Qwen Code PATH block begin',
        );
        // An ANSI reset sits between "in" and the rc name, so match the
        // success message and the reload hint on the rc name alone.
        expect(output).toContain('source ~/.bash_profile');
        expect(output).not.toContain('~/.bashrc');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix(
    'appends a fresh PATH block when an existing PATH line is not last',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const fakeBin = path.join(tmpDir, 'old-bin');
        const existingQwen = path.join(fakeBin, 'qwen');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        const installBinDir = path.join(installRoot, 'bin');
        const installedBin = path.join(installBinDir, 'qwen');
        const bashrc = path.join(home, '.bashrc');

        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(home, { recursive: true });
        writeFileSync(existingQwen, '#!/usr/bin/env sh\necho old-qwen\n');
        chmodSync(existingQwen, 0o755);
        writeFileSync(
          bashrc,
          [
            `export PATH='${installBinDir}':$PATH`,
            `export PATH='${fakeBin}':$PATH`,
          ].join('\n') + '\n',
        );

        runUnixInstaller(archive, installRoot, home, 'standalone', {
          PATH: `${fakeBin}:${process.env.PATH}`,
          SHELL: '/bin/bash',
        });

        const bashrcContents = readScript(bashrc);
        expect(bashrcContents).toContain('# Qwen Code PATH block begin');
        expect(
          bashrcContents.endsWith(
            [
              '# Qwen Code PATH block begin',
              `export PATH='${installBinDir}':$PATH`,
              '# Qwen Code PATH block end',
              '',
            ].join('\n'),
          ),
        ).toBe(true);

        const resolvedQwen = execFileSync(
          'bash',
          ['-c', 'source "${HOME}/.bashrc"; command -v qwen'],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH}`,
              SHELL: '/bin/bash',
            },
          },
        )
          .toString()
          .trim();
        expect(resolvedQwen).toBe(installedBin);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix(
    'removes installer-owned shell rc PATH blocks even when extra lines are inserted',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-uninstall-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runUnixInstaller(archive, installRoot, home);

        const rcFile = path.join(home, '.zshrc');
        writeFileSync(
          rcFile,
          [
            'before',
            '# Qwen Code PATH block begin',
            '# inserted by another tool',
            `export PATH='${installRoot}/bin':$PATH`,
            '# Qwen Code PATH block end',
            'after',
          ].join('\n') + '\n',
        );

        runUnixUninstaller(installRoot, home);

        expect(readScript(rcFile)).toBe('before\nafter\n');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix(
    'preserves malformed shell rc PATH blocks without an end marker',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-uninstall-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        runUnixInstaller(archive, installRoot, home);

        const rcFile = path.join(home, '.zshrc');
        writeFileSync(
          rcFile,
          [
            'before',
            '# Qwen Code PATH block begin',
            `export PATH='${installRoot}/bin':$PATH`,
            'user content that must stay',
            'after',
          ].join('\n') + '\n',
        );

        runUnixUninstaller(installRoot, home);

        expect(readScript(rcFile)).toBe(
          [
            'before',
            '# Qwen Code PATH block begin',
            `export PATH='${installRoot}/bin':$PATH`,
            'user content that must stay',
            'after',
          ].join('\n') + '\n',
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
  );

  itOnUnix('shell-quotes custom install paths in the generated wrapper', () => {
    const createdDist = ensureMinimalDist();
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
      restoreMinimalDist(createdDist);
    }
  });

  itOnUnix(
    'shell-quotes PATH updates written to shell rc files',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const fakeBin = path.join(tmpDir, 'shadow-bin');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        const marker = path.join(tmpDir, 'qwen-pwned');
        const unsafeBinDir = path.join(
          installRoot,
          'bin path $(touch qwen-pwned)',
        );

        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(path.join(fakeBin, 'qwen'), '#!/usr/bin/env sh\n');
        chmodSync(path.join(fakeBin, 'qwen'), 0o755);

        runUnixInstaller(archive, installRoot, home, 'standalone', {
          PATH: `${fakeBin}:${process.env.PATH}`,
          SHELL: '/bin/bash',
          QWEN_INSTALL_BIN_DIR: unsafeBinDir,
        });

        const bashrc = path.join(home, '.bashrc');
        expect(readScript(bashrc)).toContain(
          `export PATH='${unsafeBinDir}':$PATH`,
        );
        execFileSync('bash', ['-c', `source "${bashrc}"`], {
          cwd: tmpDir,
          stdio: 'pipe',
        });
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
    15000,
  );

  itOnUnix(
    'skips shell rc PATH updates for unsupported shells',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const fakeBin = path.join(tmpDir, 'shadow-bin');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');

        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(path.join(fakeBin, 'qwen'), '#!/usr/bin/env sh\n');
        chmodSync(path.join(fakeBin, 'qwen'), 0o755);

        const output = runUnixInstaller(
          archive,
          installRoot,
          home,
          'standalone',
          {
            PATH: `${fakeBin}:${process.env.PATH}`,
            SHELL: '/bin/tcsh',
          },
        ).toString();

        expect(output).toContain('Unsupported shell for automatic PATH update');
        expect(output).toContain(path.join(installRoot, 'bin'));
        expect(existsSync(path.join(home, '.profile'))).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
    15000,
  );

  itOnUnix(
    'uses ranged GET fallback when archive HEAD probes fail',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const checksumFile = path.join(path.dirname(archive), 'SHA256SUMS');
        const fakeBin = path.join(tmpDir, 'bin');
        const curlLog = path.join(tmpDir, 'curl-urls.log');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');

        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(
          path.join(fakeBin, 'uname'),
          [
            '#!/usr/bin/env sh',
            'case "$1" in',
            '  -s) echo Linux ;;',
            '  -m) echo x86_64 ;;',
            '  *) /usr/bin/uname "$@" ;;',
            'esac',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'curl'),
          [
            '#!/usr/bin/env sh',
            'url=',
            'dest=',
            'is_head=0',
            'is_range=0',
            'while [ "$#" -gt 0 ]; do',
            '  case "$1" in',
            '    -o) shift; dest="$1" ;;',
            '    --range|-r) is_range=1; shift ;;',
            '    -H) shift; case "$1" in Range:*) is_range=1 ;; esac ;;',
            '    -*) case "$1" in *I*) is_head=1 ;; esac ;;',
            '    http*) url="$1" ;;',
            '  esac',
            '  shift',
            'done',
            'printf "%s %s %s\\n" "$url" "$is_head" "$is_range" >> "$QWEN_FAKE_CURL_LOG"',
            'case "$url" in',
            '  */qwen-code-linux-x64.tar.gz)',
            '    if [ "$is_head" = "1" ]; then exit 22; fi',
            '    if [ "$is_range" = "1" ]; then : > "${dest:-/dev/null}"; exit 0; fi',
            '    cp "$QWEN_FAKE_ARCHIVE" "$dest"; exit 0 ;;',
            '  */SHA256SUMS)',
            '    cp "$QWEN_FAKE_SHA256SUMS" "$dest"; exit 0 ;;',
            '  *)',
            '    echo "unexpected url: $url" >&2',
            '    exit 22 ;;',
            'esac',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'node'),
          [
            '#!/usr/bin/env sh',
            'if [ "$1" = "-p" ]; then echo 22.0.0; exit 0; fi',
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          path.join(fakeBin, 'npm'),
          '#!/usr/bin/env sh\necho npm fallback should not run >&2\nexit 1\n',
        );
        for (const command of ['uname', 'curl', 'node', 'npm']) {
          chmodSync(path.join(fakeBin, command), 0o755);
        }

        const output = execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-standalone.sh',
            '--method',
            'detect',
            '--base-url',
            'https://example.com/qwen-code',
            '--source',
            'smoke',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${fakeBin}:${process.env.PATH}`,
              QWEN_FAKE_ARCHIVE: archive,
              QWEN_FAKE_SHA256SUMS: checksumFile,
              QWEN_FAKE_CURL_LOG: curlLog,
              QWEN_INSTALL_ROOT: installRoot,
            },
            stdio: 'pipe',
          },
        ).toString();

        const curlUrls = readScript(curlLog);
        expect(curlUrls).toContain('qwen-code-linux-x64.tar.gz 1 0');
        expect(curlUrls).toContain('qwen-code-linux-x64.tar.gz 0 1');
        expect(output).toContain('Downloading qwen-code-linux-x64.tar.gz');
        expect(output).not.toContain('Falling back to npm installation');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
    15000,
  );

  itOnUnix(
    'adds a new shell rc PATH entry when reinstalling with a different bin dir',
    () => {
      const createdDist = ensureMinimalDist();
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = packageFakeStandalone(tmpDir);
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');
        const firstBinDir = path.join(installRoot, 'bin-one');
        const secondBinDir = path.join(installRoot, 'bin-two');

        runUnixInstaller(archive, installRoot, home, 'standalone', {
          SHELL: '/bin/bash',
          QWEN_INSTALL_BIN_DIR: firstBinDir,
        });
        runUnixInstaller(archive, installRoot, home, 'standalone', {
          SHELL: '/bin/bash',
          QWEN_INSTALL_BIN_DIR: secondBinDir,
        });

        const bashrc = readScript(path.join(home, '.bashrc'));
        expect(bashrc).toContain(`export PATH='${firstBinDir}':$PATH`);
        expect(bashrc).toContain(`export PATH='${secondBinDir}':$PATH`);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreMinimalDist(createdDist);
      }
    },
    15000,
  );

  itOnUnix('rejects a tampered local archive', () => {
    const createdDist = ensureMinimalDist();
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
      ).toThrow(/Checksum mismatch/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
    }
  });

  itOnUnix('rejects a local archive when SHA256SUMS is missing', () => {
    const createdDist = ensureMinimalDist();
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
      restoreMinimalDist(createdDist);
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

  itOnUnix('rejects empty standalone archives', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = path.join(tmpDir, 'qwen-code-linux-x64.tar.gz');
      execFileSync('tar', ['-czf', archive, '-T', '/dev/null'], {
        stdio: 'ignore',
      });
      writeChecksumFile(tmpDir, path.basename(archive));

      expect(() =>
        runUnixInstaller(
          archive,
          path.join(tmpDir, 'install'),
          path.join(tmpDir, 'home'),
        ),
      ).toThrow(/Archive is empty/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
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

  itOnUnix('backs up and overwrites a non-managed install directory', () => {
    const createdDist = ensureMinimalDist();
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const archive = packageFakeStandalone(tmpDir);
      const installRoot = path.join(tmpDir, 'install');
      const installDir = path.join(installRoot, 'lib', 'qwen-code');
      mkdirSync(installDir, { recursive: true });
      writeFileSync(path.join(installDir, 'important.txt'), 'keep me\n');

      const output = runUnixInstaller(
        archive,
        installRoot,
        path.join(tmpDir, 'home'),
      ).toString();

      expect(output).toContain('not a Qwen Code standalone install');
      expect(output).toContain('Backing up to');

      // Original directory should be backed up, not destroyed
      const backups = readdirSync(path.join(installRoot, 'lib')).filter((e) =>
        e.startsWith('qwen-code.backup.'),
      );
      expect(backups.length).toBe(1);
      expect(
        readScript(path.join(installRoot, 'lib', backups[0], 'important.txt')),
      ).toBe('keep me\n');

      // New install should be at the original location
      expect(existsSync(path.join(installDir, 'manifest.json'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
    }
  });

  itOnUnix('does not fall back to npm when detect finds a bad archive', () => {
    const createdDist = ensureMinimalDist();
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

      expect(failureMessage).toContain('Checksum mismatch');
      expect(failureMessage).toContain('Standalone install failed');
      expect(failureMessage).not.toContain('Falling back to npm installation');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreMinimalDist(createdDist);
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
            'scripts/installation/install-qwen-standalone.sh',
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

  itOnUnix('passes pinned versions through to npm fallback', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const fakeBin = path.join(tmpDir, 'bin');
      const home = path.join(tmpDir, 'home');
      const npmLog = path.join(tmpDir, 'npm-args.txt');
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(home, { recursive: true });

      writeFileSync(path.join(fakeBin, 'curl'), '#!/usr/bin/env sh\nexit 22\n');
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
      for (const command of ['curl', 'node', 'npm']) {
        chmodSync(path.join(fakeBin, command), 0o755);
      }

      execFileSync(
        'bash',
        [
          'scripts/installation/install-qwen-standalone.sh',
          '--method',
          'detect',
          '--base-url',
          'https://example.invalid/qwen-code',
          '--version',
          'v0.15.10',
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
      );

      expect(readScript(npmLog)).toContain(
        'install -g @qwen-code/qwen-code@0.15.10 --registry',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnUnix('preserves context when npm fallback also fails', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const fakeBin = path.join(tmpDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(path.join(fakeBin, 'curl'), '#!/usr/bin/env sh\nexit 22\n');
      // Shadow any system Node on PATH (e.g. /usr/bin/node on self-hosted
      // runners) with a stub that fails version detection, so the npm fallback
      // deterministically fails with "Unable to determine Node.js version"
      // regardless of whether the host has Node installed in /usr/bin.
      writeFileSync(path.join(fakeBin, 'node'), '#!/usr/bin/env sh\nexit 1\n');
      chmodSync(path.join(fakeBin, 'curl'), 0o755);
      chmodSync(path.join(fakeBin, 'node'), 0o755);

      let failureMessage = '';
      try {
        execFileSync(
          'bash',
          [
            'scripts/installation/install-qwen-standalone.sh',
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

// Windows runners are slower at spawning cmd.exe + node.exe, so the
// default 5s vitest timeout is too tight for these end-to-end installs.
describe('Windows installer end-to-end', { timeout: 30000 }, () => {
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
  );

  itOnWindows('rejects a tampered local archive', () => {
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
      ).toThrow(/Checksum mismatch/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnWindows('rejects unsafe environment-derived install paths', () => {
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
  });

  itOnWindows(
    'resolves Aliyun latest through a single VERSION pointer before downloading archives',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const archive = createFakeWindowsStandaloneArchive(tmpDir);
        const checksumFile = path.join(path.dirname(archive), 'SHA256SUMS');
        const fakeBin = path.join(tmpDir, 'bin');
        const curlLog = path.join(tmpDir, 'curl-urls.log');
        const installRoot = path.join(tmpDir, 'install');
        const home = path.join(tmpDir, 'home');

        const fakeCurl = createFakeWindowsCurlCommand(fakeBin);

        const output = runWindowsCommand(
          [
            `call "${path.resolve('scripts/installation/install-qwen-standalone.bat')}"`,
            '--method',
            'standalone',
            '--mirror',
            'aliyun',
            '--source',
            'smoke',
          ].join(' '),
          {
            USERPROFILE: home,
            QWEN_INSTALL_ROOT: installRoot,
            QWEN_FAKE_ARCHIVE: archive,
            QWEN_FAKE_SHA256SUMS: checksumFile,
            QWEN_FAKE_CURL_LOG: curlLog,
            QWEN_INSTALL_CURL_EXE: fakeCurl,
            ...prependWindowsPath(fakeBin),
            PROCESSOR_ARCHITECTURE: 'AMD64',
            PROCESSOR_ARCHITEW6432: '',
          },
        ).toString();

        const curlUrls = readScript(curlLog);
        expect(curlUrls).toContain('/releases/qwen-code/latest/VERSION');
        expect(curlUrls).toContain(
          '/releases/qwen-code/v0.0.0/qwen-code-win-x64.zip',
        );
        expect(curlUrls).toContain('/releases/qwen-code/v0.0.0/SHA256SUMS');
        expect(curlUrls).not.toContain(
          '/releases/qwen-code/latest/qwen-code-win-x64.zip',
        );
        expect(output).toContain('Downloading qwen-code-win-x64.zip');
        expect(existsSync(path.join(installRoot, 'bin', 'qwen.cmd'))).toBe(
          true,
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itOnWindows(
    'falls back to npm in detect mode when archive is unavailable',
    () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

      try {
        const fakeBin = path.join(tmpDir, 'bin');
        const npmLog = path.join(tmpDir, 'npm-install.log');
        createFakeWindowsNpmTools(fakeBin);

        const output = runWindowsCommand(
          [
            `call "${path.resolve('scripts/installation/install-qwen-standalone.bat')}"`,
            '--method',
            'detect',
            '--source',
            'smoke',
          ].join(' '),
          {
            USERPROFILE: path.join(tmpDir, 'home'),
            QWEN_INSTALL_ROOT: path.join(tmpDir, 'install'),
            QWEN_FAKE_NPM_LOG: npmLog,
            QWEN_FAKE_NPM_PREFIX: path.join(tmpDir, 'npm-prefix'),
            ...prependWindowsPath(fakeBin),
            PROCESSOR_ARCHITECTURE: 'ARM64',
            PROCESSOR_ARCHITEW6432: '',
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

  itOnWindows('passes pinned versions through to npm fallback', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const fakeBin = path.join(tmpDir, 'bin');
      const npmLog = path.join(tmpDir, 'npm-install.log');
      createFakeWindowsNpmTools(fakeBin);

      runWindowsCommand(
        [
          `call "${path.resolve('scripts/installation/install-qwen-standalone.bat')}"`,
          '--method',
          'detect',
          '--source',
          'smoke',
          '--version',
          'v0.15.10',
        ].join(' '),
        {
          USERPROFILE: path.join(tmpDir, 'home'),
          QWEN_INSTALL_ROOT: path.join(tmpDir, 'install'),
          QWEN_FAKE_NPM_LOG: npmLog,
          QWEN_FAKE_NPM_PREFIX: path.join(tmpDir, 'npm-prefix'),
          ...prependWindowsPath(fakeBin),
          PROCESSOR_ARCHITECTURE: 'ARM64',
          PROCESSOR_ARCHITEW6432: '',
        },
      );

      expect(readScript(npmLog)).toContain(
        'install -g @qwen-code/qwen-code@0.15.10 --registry',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnWindows('preserves context when npm fallback also fails', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-install-test-'));

    try {
      const fakeBin = path.join(tmpDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        path.join(fakeBin, 'node.cmd'),
        ['@echo off', 'exit /b 1', ''].join('\r\n'),
      );

      let failureMessage = '';
      try {
        runWindowsCommand(
          [
            `call "${path.resolve('scripts/installation/install-qwen-standalone.bat')}"`,
            '--method',
            'detect',
            '--source',
            'smoke',
          ].join(' '),
          {
            USERPROFILE: path.join(tmpDir, 'home'),
            QWEN_INSTALL_ROOT: path.join(tmpDir, 'install'),
            ...prependWindowsPath(fakeBin),
            PROCESSOR_ARCHITECTURE: 'ARM64',
            PROCESSOR_ARCHITEW6432: '',
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
      expect(failureMessage).toContain('Unable to determine Node.js version');
      expect(failureMessage).toContain('npm fallback also failed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Windows PowerShell uninstaller end-to-end', () => {
  itOnWindows('prints help without deleting standalone files', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-uninstall-test-'));

    try {
      const installRoot = path.join(tmpDir, 'install');
      const installDir = path.join(installRoot, 'qwen-code');
      const home = path.join(tmpDir, 'home');
      createFakeWindowsStandaloneInstall(installRoot);

      const output = runWindowsPowerShellScript(
        'scripts/installation/uninstall-qwen-standalone.ps1',
        ['-Help'],
        {
          USERPROFILE: home,
          QWEN_INSTALL_ROOT: installRoot,
        },
      ).toString();

      expect(output).toContain('Usage:');
      expect(output).toContain('-Purge');
      expect(existsSync(installDir)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itOnWindows('purges the source marker while preserving other config', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-uninstall-test-'));

    try {
      const installRoot = path.join(tmpDir, 'install');
      const installDir = path.join(installRoot, 'qwen-code');
      const installBinDir = path.join(installRoot, 'bin');
      const home = path.join(tmpDir, 'home');
      const qwenConfigDir = path.join(home, '.qwen');
      const sourceMarker = path.join(qwenConfigDir, 'source.json');
      const settingsFile = path.join(qwenConfigDir, 'settings.json');

      createFakeWindowsStandaloneInstall(installRoot);
      mkdirSync(qwenConfigDir, { recursive: true });
      writeFileSync(sourceMarker, '{"source":"smoke"}\n');
      writeFileSync(settingsFile, '{"theme":"dark"}\n');

      const output = runWindowsPowerShellScript(
        'scripts/installation/uninstall-qwen-standalone.ps1',
        ['-Purge'],
        {
          USERPROFILE: home,
          QWEN_INSTALL_ROOT: installRoot,
        },
      ).toString();

      expect(output).toContain('Removed');
      expect(existsSync(installDir)).toBe(false);
      expect(existsSync(path.join(installBinDir, 'qwen.cmd'))).toBe(false);
      expect(existsSync(sourceMarker)).toBe(false);
      expect(readScript(settingsFile)).toContain('"theme":"dark"');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function ensureMinimalDist() {
  const distPath = path.resolve('dist');
  const backupPath = existsSync(distPath)
    ? path.join(
        path.dirname(distPath),
        `qwen-dist-backup-${process.pid}-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`,
      )
    : null;
  if (backupPath) {
    renameSync(distPath, backupPath);
  }

  mkdirSync(path.join(distPath, 'chunks'), { recursive: true });
  mkdirSync(path.join(distPath, 'vendor'), { recursive: true });
  mkdirSync(path.join(distPath, 'bundled/qc-helper/docs'), {
    recursive: true,
  });
  writeFileSync(path.join(distPath, 'cli.js'), 'console.log("qwen");\n');
  writeFileSync(path.join(distPath, 'chunks/index.js'), 'export {};\n');
  writeFileSync(
    path.join(distPath, 'package.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.0.0' }),
  );
  return { backupPath, distPath };
}

function restoreMinimalDist(state) {
  rmSync(state?.distPath || path.resolve('dist'), {
    recursive: true,
    force: true,
  });
  if (state?.backupPath) {
    renameSync(state.backupPath, state.distPath);
  }
}

function createFakeNodeArchive(tmpDir, options = {}) {
  const fakeNodeDir = path.join(tmpDir, 'node-v22.0.0-linux-x64');
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

  const archive = path.join(tmpDir, 'node-v22.0.0-linux-x64.tar.gz');
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
  const fakeNodeDir = path.join(tmpDir, 'node-v22.0.0-win-x64');
  mkdirSync(fakeNodeDir, { recursive: true });
  writeFileSync(path.join(fakeNodeDir, 'node.exe'), 'fake node.exe\n');

  const archive = path.join(tmpDir, 'node-v22.0.0-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(fakeNodeDir));
  return archive;
}

function createFakeWindowsStandaloneArchive(tmpDir) {
  const packageRoot = path.join(tmpDir, 'qwen-code');
  const outDir = path.join(tmpDir, 'out');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'node'), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    path.join(packageRoot, 'bin', 'qwen.cmd'),
    ['@echo off', 'echo 0.0.0-smoke', ''].join('\r\n'),
  );
  writeFileSync(path.join(packageRoot, 'node', 'node.exe'), 'fake node.exe\n');
  writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', target: 'win-x64' }),
  );

  const archive = path.join(outDir, 'qwen-code-win-x64.zip');
  createZipForTest(archive, tmpDir, path.basename(packageRoot));
  writeChecksumFile(outDir, path.basename(archive));
  return archive;
}

function createFakeWindowsStandaloneInstall(installRoot) {
  const installDir = path.join(installRoot, 'qwen-code');
  const installBinDir = path.join(installRoot, 'bin');
  mkdirSync(path.join(installDir, 'bin'), { recursive: true });
  mkdirSync(path.join(installDir, 'node'), { recursive: true });
  mkdirSync(installBinDir, { recursive: true });

  writeFileSync(
    path.join(installDir, 'manifest.json'),
    JSON.stringify({ name: '@qwen-code/qwen-code', target: 'win-x64' }),
  );
  writeFileSync(
    path.join(installDir, 'bin', 'qwen.cmd'),
    ['@echo off', 'echo 0.0.0-smoke', ''].join('\r\n'),
  );
  writeFileSync(path.join(installDir, 'node', 'node.exe'), 'fake node.exe\n');
  writeFileSync(
    path.join(installBinDir, 'qwen.cmd'),
    ['@echo off', `"${path.join(installDir, 'bin', 'qwen.cmd')}" %*`, ''].join(
      '\r\n',
    ),
  );
}

function createFakeWindowsNpmTools(fakeBin) {
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    path.join(fakeBin, 'node.cmd'),
    ['@echo off', 'if "%~1"=="-p" echo 22.0.0', 'exit /b 0', ''].join('\r\n'),
  );
  writeFileSync(
    path.join(fakeBin, 'npm.cmd'),
    [
      '@echo off',
      'if "%~1"=="-v" echo 10.0.0 & exit /b 0',
      'if "%~1"=="prefix" echo %QWEN_FAKE_NPM_PREFIX% & exit /b 0',
      'if "%~1"=="install" echo %* > "%QWEN_FAKE_NPM_LOG%" & exit /b 0',
      'exit /b 0',
      '',
    ].join('\r\n'),
  );
  writeFileSync(
    path.join(fakeBin, 'qwen.cmd'),
    ['@echo off', 'echo 0.0.0-npm', ''].join('\r\n'),
  );
}

function createFakeWindowsCurlCommand(fakeBin) {
  mkdirSync(fakeBin, { recursive: true });
  const outputPath = path.join(fakeBin, 'curl.cmd');
  writeFileSync(
    outputPath,
    [
      '@echo off',
      'setlocal EnableExtensions EnableDelayedExpansion',
      'set "destination="',
      'set "url="',
      ':parse_args',
      'if "%~1"=="" goto done_parse',
      'set "arg=%~1"',
      'if "!arg:~0,1!"=="-" (',
      '  if /i "!arg!"=="-o" (',
      '    set "destination=%~2"',
      '    shift',
      '    shift',
      '    goto parse_args',
      '  )',
      '  if /i "!arg!"=="--output" (',
      '    set "destination=%~2"',
      '    shift',
      '    shift',
      '    goto parse_args',
      '  )',
      '  if not "!arg:~0,2!"=="--" if /i "!arg:~-1!"=="o" (',
      '    set "destination=%~2"',
      '    shift',
      '    shift',
      '    goto parse_args',
      '  )',
      '  shift',
      '  goto parse_args',
      ')',
      'if /i "!arg:~0,4!"=="http" set "url=!arg!"',
      'shift',
      'goto parse_args',
      ':done_parse',
      '>>"%QWEN_FAKE_CURL_LOG%" echo(!url!',
      'if "!url!"=="" echo missing url or destination 1>&2 & exit /b 2',
      'if "!destination!"=="" echo missing url or destination 1>&2 & exit /b 2',
      'echo(!url! | findstr /I /C:"/releases/qwen-code/latest/VERSION" >nul && (',
      '  > "!destination!" echo 0.0.0',
      '  exit /b 0',
      ')',
      'echo(!url! | findstr /I /C:"/releases/qwen-code/v0.0.0/qwen-code-win-x64.zip" >nul && (',
      '  copy /Y "%QWEN_FAKE_ARCHIVE%" "!destination!" >nul',
      '  exit /b 0',
      ')',
      'echo(!url! | findstr /I /C:"/releases/qwen-code/v0.0.0/SHA256SUMS" >nul && (',
      '  copy /Y "%QWEN_FAKE_SHA256SUMS%" "!destination!" >nul',
      '  exit /b 0',
      ')',
      'echo unexpected url: !url! 1>&2',
      'exit /b 22',
      '',
    ].join('\r\n'),
  );
  return outputPath;
}

function prependWindowsPath(directory) {
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ||
    'Path';
  const value = `${directory};${process.env[pathKey] || ''}`;
  return {
    PATH: value,
    Path: value,
    [pathKey]: value,
  };
}

function createZipForTest(archive, cwd, entry) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Compress-Archive -LiteralPath $env:QWEN_TEST_ZIP_ENTRY -DestinationPath $env:QWEN_TEST_ZIP_ARCHIVE -Force',
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
        'scripts/installation/install-qwen-standalone.sh',
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

function runUnixUninstaller(installRoot, home, extraEnv = {}) {
  mkdirSync(home, { recursive: true });
  try {
    return execFileSync(
      'bash',
      ['scripts/installation/uninstall-qwen-standalone.sh'],
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
        `call "${path.resolve('scripts/installation/install-qwen-standalone.bat')}"`,
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
  const prepared = prepareWindowsCommand(command, env);
  try {
    return execFileSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/c', prepared.command],
      {
        env: {
          ...prepared.env,
        },
        stdio: 'pipe',
        // cmd.exe parses the command string itself; preserve quoted paths.
        windowsVerbatimArguments: true,
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

function runWindowsPowerShellScript(scriptPath, args = [], env = {}) {
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.resolve(scriptPath),
        ...args,
      ],
      {
        env: {
          ...process.env,
          ...env,
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

const WINDOWS_COMMAND_ENV_OVERRIDES = [
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
];

function prepareWindowsCommand(command, env = {}, baseEnv = process.env) {
  const commandEnv = { ...baseEnv, ...env };
  const commandPrefix = [];

  for (const key of WINDOWS_COMMAND_ENV_OVERRIDES) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      continue;
    }

    for (const existingKey of Object.keys(commandEnv)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) {
        delete commandEnv[existingKey];
      }
    }
    commandPrefix.push(`set "${key}=${env[key] ?? ''}"`);
  }

  return {
    command: [...commandPrefix, command].join(' && '),
    env: commandEnv,
  };
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
    JSON.stringify({ name: '@qwen-code/qwen-code', target: 'linux-x64' }),
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
    JSON.stringify({ name: '@qwen-code/qwen-code', target: 'linux-x64' }),
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
    const hash = existsSync(filePath)
      ? crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex')
      : 'a'.repeat(64);
    return `${hash}  ${assetName}`;
  });
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

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
