/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fetch } from 'undici';
import * as tar from 'tar';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { verifySignature } from './standalone-update-verify.js';

const debugLogger = createDebugLogger('STANDALONE_UPDATE');

const OSS_BASE =
  'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code';
const GITHUB_BASE = 'https://github.com/QwenLM/qwen-code/releases/download';
const FETCH_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 300_000; // 5 min — archives are 50–150 MB

const VALID_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win-x64',
]);

const SEMVER_RE = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

type UndiciResponse = Awaited<ReturnType<typeof fetch>>;

function normalizeVersion(version: string): string {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return version.startsWith('v') ? version : `v${version}`;
}

function validateTarget(target: string): void {
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`Unknown target: ${target}`);
  }
}

function archiveFilename(target: string): string {
  const ext = target.startsWith('win') ? 'zip' : 'tar.gz';
  return `qwen-code-${target}.${ext}`;
}

function escapePS(s: string): string {
  return s.replace(/'/g, "''");
}

async function tryFetch(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<UndiciResponse | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res;
    // Consume body to release the socket back to the connection pool
    await res.body?.cancel().catch(() => {});
  } catch (err) {
    debugLogger.debug(`Fetch failed for ${url}: ${err}`);
  }
  return null;
}

async function downloadWithFallback(
  versionPath: string,
  filename: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<UndiciResponse> {
  const ossUrl = `${OSS_BASE}/${versionPath}/${filename}`;
  const ossRes = await tryFetch(ossUrl, timeoutMs);
  if (ossRes) return ossRes;

  const ghUrl = `${GITHUB_BASE}/${versionPath}/${filename}`;
  const ghRes = await tryFetch(ghUrl, timeoutMs);
  if (ghRes) return ghRes;

  throw new Error(
    `Failed to download ${filename} from both OSS and GitHub mirrors`,
  );
}

async function verifyChecksum(
  filePath: string,
  filename: string,
  versionPath: string,
): Promise<void> {
  const response = await downloadWithFallback(versionPath, 'SHA256SUMS');
  const text = await response.text();

  // Ed25519 signature verification of SHA256SUMS.
  // NOTE: Currently uses a test key. Once release CI signs with the production
  // key and publishes SHA256SUMS.sig, set QWEN_REQUIRE_SIGNATURE=1 to enforce.
  // Until then, verification is best-effort (passes when .sig exists, warns when not).
  const requireSig = process.env['QWEN_REQUIRE_SIGNATURE'] === '1';
  let sigResponse = await tryFetch(`${OSS_BASE}/${versionPath}/SHA256SUMS.sig`);
  if (!sigResponse) {
    sigResponse = await tryFetch(
      `${GITHUB_BASE}/${versionPath}/SHA256SUMS.sig`,
    );
  }
  if (sigResponse) {
    const sigContent = await sigResponse.text();
    verifySignature(text, sigContent.trim());
    debugLogger.info('SHA256SUMS signature verified.');
  } else if (requireSig) {
    throw new Error(
      'SHA256SUMS.sig not found and QWEN_REQUIRE_SIGNATURE=1 is set',
    );
  } else {
    debugLogger.info(
      'SHA256SUMS.sig not available — update integrity relies on SHA256 checksum only.',
    );
  }

  const expectedLine = text.split('\n').find((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) return false;
    // Handle GNU coreutils binary-mode prefix: "hash *filename"
    const name = parts[parts.length - 1]!.replace(/^\*/, '');
    return name === filename;
  });
  if (!expectedLine) {
    throw new Error(`No checksum found for ${filename} in SHA256SUMS`);
  }
  const expectedHash = expectedLine.trim().split(/\s+/)[0]!;

  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  const actualHash = hash.digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch: expected ${expectedHash}, got ${actualHash}`,
    );
  }
}

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024; // 512 MB

async function downloadToFile(
  versionPath: string,
  filename: string,
  destPath: string,
): Promise<void> {
  const response = await downloadWithFallback(
    versionPath,
    filename,
    ARCHIVE_TIMEOUT_MS,
  );
  const body = response.body;
  if (!body) throw new Error('Empty response body');

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    await body.cancel().catch(() => {});
    throw new Error(
      `Download too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES} limit`,
    );
  }

  let bytesWritten = 0;
  const dest = fs.createWriteStream(destPath);
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_DOWNLOAD_BYTES) {
        callback(
          new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} byte limit`),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
  await pipeline(Readable.fromWeb(body), sizeGuard, dest);
}

async function extractArchive(
  archivePath: string,
  destDir: string,
  target: string,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  if (target.startsWith('win')) {
    await new Promise<void>((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${escapePS(archivePath)}' -DestinationPath '${escapePS(destDir)}' -Force`,
        ],
        { stdio: 'ignore' },
      );
      ps.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Expand-Archive exited with code ${code}`)),
      );
      ps.on('error', reject);
    });
  } else {
    await tar.extract({
      file: archivePath,
      cwd: destDir,
      preservePaths: false,
      filter: (p) => !p.startsWith('/') && !p.includes('..'),
    });
  }
}

/**
 * Runs a command and captures stdout, stderr, and exit code.
 */
function spawnAndCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs },
      (err, out, stderr) => {
        if (settled) return;
        settled = true;
        if (
          err &&
          (('killed' in err && err.killed) || ('signal' in err && err.signal))
        ) {
          reject(new Error('Smoke test timed out'));
          return;
        }
        const exitCode =
          err && 'code' in err && typeof err.code === 'number' ? err.code : 0;
        resolve({ exitCode, stdout: out || '', stderr: stderr || '' });
      },
    );
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * Verifies the new installation can actually run by invoking --version.
 * Prevents replacing a working install with a broken binary.
 */
async function smokeTest(newInstallDir: string, target: string): Promise<void> {
  const resolvedInstallDir = path.resolve(newInstallDir);
  const nodeBin = target.startsWith('win')
    ? path.join(resolvedInstallDir, 'node', 'node.exe')
    : path.join(resolvedInstallDir, 'node', 'bin', 'node');
  const cliBin = path.join(resolvedInstallDir, 'lib', 'cli.js');

  if (!fs.existsSync(nodeBin)) {
    throw new Error(`Smoke test failed: node binary not found at ${nodeBin}`);
  }
  if (!fs.existsSync(cliBin)) {
    throw new Error(`Smoke test failed: cli.js not found at ${cliBin}`);
  }

  const { exitCode, stdout, stderr } = await spawnAndCapture(
    nodeBin,
    [cliBin, '--version'],
    10_000,
  );
  if (exitCode !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
    throw new Error(
      `Smoke test failed: new binary exited with code ${exitCode}${detail}`,
    );
  }
  const version = stdout.trim();
  if (!SEMVER_RE.test(version)) {
    throw new Error(
      `Smoke test failed: unexpected version output "${version}"`,
    );
  }
  debugLogger.info(`Smoke test passed: ${version}`);
}

function acquireLock(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      const pidStr = fs.readFileSync(lockPath, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (Number.isNaN(pid) || !isProcessAlive(pid)) {
        fs.unlinkSync(lockPath);
        try {
          fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      // lock is held by another live process
    }
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function atomicReplace(
  standaloneDir: string,
  newDir: string,
  lockPath: string,
): 'done' | 'deferred' {
  const oldDir = `${standaloneDir}.old`;
  const pendingDir = `${standaloneDir}.new`;

  if (fs.existsSync(oldDir)) {
    fs.rmSync(oldDir, { recursive: true, force: true });
  }

  if (os.platform() === 'win32') {
    // On Windows, the running node.exe holds file locks. Stage the new dir
    // as a sibling, then spawn a helper script that waits for this process
    // to exit before completing the swap.
    if (fs.existsSync(pendingDir)) {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    }
    fs.renameSync(newDir, pendingDir);

    // Validate paths don't contain cmd.exe metacharacters that could break the script
    const unsafeCmdChars = /[&|<>^%!"`\n\r]/;
    if (
      unsafeCmdChars.test(standaloneDir) ||
      unsafeCmdChars.test(oldDir) ||
      unsafeCmdChars.test(pendingDir)
    ) {
      throw new Error(
        'Installation path contains characters unsafe for deferred update script',
      );
    }

    const lockFile = lockPath;
    const logFile = path.join(path.dirname(standaloneDir), 'qwen-update.log');
    // Bat script runs detached after Node exits. It must:
    // 1. Wait for this Node process to release file locks (<= 30s).
    // 2. Run both moves with errorlevel checks; if move #2 fails, roll back
    //    move #1 so the user is never left without a working install.
    // 3. Log success/failure to qwen-update.log for post-mortem (the bat
    //    runs with stdio:ignore — the log is the only diagnostic surface).
    const script = [
      '@echo off',
      'set /a TRIES=0',
      ':wait',
      'set /a TRIES+=1',
      'if %TRIES% GTR 30 goto proceed',
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 >nul & goto wait)`,
      ':proceed',
      `echo [%DATE% %TIME%] starting swap >> "${logFile}"`,
      `move /Y "${standaloneDir}" "${oldDir}"`,
      'if errorlevel 1 goto move1_failed',
      `move /Y "${pendingDir}" "${standaloneDir}"`,
      'if errorlevel 1 goto move2_failed',
      `echo [%DATE% %TIME%] swap completed >> "${logFile}"`,
      'goto cleanup',
      ':move1_failed',
      `echo [%DATE% %TIME%] ERROR: failed to rename install to .old (errorlevel %errorlevel%) >> "${logFile}"`,
      'goto cleanup',
      ':move2_failed',
      `echo [%DATE% %TIME%] ERROR: failed to promote .new; rolling back >> "${logFile}"`,
      `move /Y "${oldDir}" "${standaloneDir}"`,
      'if errorlevel 1 (',
      `  echo [%DATE% %TIME%] CRITICAL: rollback also failed; manual recovery: move "${oldDir}" "${standaloneDir}" >> "${logFile}"`,
      ') else (',
      `  echo [%DATE% %TIME%] rollback succeeded >> "${logFile}"`,
      ')',
      ':cleanup',
      `del /F /Q "${lockFile}" 2>nul`,
      `del "%~f0"`,
    ].join('\r\n');
    const scriptPath = path.join(
      path.dirname(standaloneDir),
      'qwen-update.bat',
    );
    fs.writeFileSync(scriptPath, script);
    spawn('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return 'deferred';
  } else {
    // Unix: rename is atomic on same filesystem. newDir is a sibling of
    // standaloneDir (same parent), so EXDEV won't happen.
    fs.renameSync(standaloneDir, oldDir);
    try {
      fs.renameSync(newDir, standaloneDir);
    } catch (promoteErr) {
      // Recovery rename can also fail (e.g. FS hiccup, oldDir grabbed by
      // another process). Surface BOTH errors with manual-recovery steps so
      // the user is never silently left with a missing install.
      try {
        fs.renameSync(oldDir, standaloneDir);
      } catch (rollbackErr) {
        const detail =
          `Standalone update failed AND rollback failed.\n` +
          `Original error: ${(promoteErr as Error).message}\n` +
          `Rollback error: ${(rollbackErr as Error).message}\n` +
          `Manual recovery: mv "${oldDir}" "${standaloneDir}"`;
        throw new Error(detail);
      }
      throw promoteErr;
    }
    // Keep .old for rollback instead of deleting immediately
    return 'done';
  }
}

/**
 * Ensures ~/.local/bin/qwen exists and points to the standalone install.
 * Required for npm→standalone migration so the new binary is on PATH.
 */
export function ensureBinWrapper(standaloneDir: string, target: string): void {
  const binDir = path.join(path.dirname(standaloneDir), '..', 'bin');

  try {
    fs.mkdirSync(binDir, { recursive: true });
    if (target.startsWith('win')) {
      const wrapperPath = path.join(binDir, 'qwen.cmd');
      if (!fs.existsSync(wrapperPath)) {
        const content = `@echo off\r\ncall "${standaloneDir}\\bin\\qwen.cmd" %*\r\n`;
        fs.writeFileSync(wrapperPath, content);
      }
    } else {
      const wrapperPath = path.join(binDir, 'qwen');
      if (!fs.existsSync(wrapperPath)) {
        const content = `#!/bin/sh\nexec "${standaloneDir}/bin/qwen" "$@"\n`;
        fs.writeFileSync(wrapperPath, content, { mode: 0o755 });
      }
      ensurePathInShellRc(binDir);
    }
  } catch (err) {
    debugLogger.debug('Failed to create bin wrapper:', err);
  }
}

/**
 * Appends binDir to the user's shell rc file if not already present.
 * Mirrors the logic in install-qwen-standalone.sh maybe_update_shell_path.
 */
export function ensurePathInShellRc(binDir: string): void {
  const shell = process.env['SHELL'] || '';
  let rcFile: string | null = null;
  const home = process.env['HOME'] || os.homedir();

  if (shell.endsWith('/zsh')) {
    rcFile = path.join(home, '.zshrc');
  } else if (shell.endsWith('/bash')) {
    // Prefer .bashrc; fall back to .bash_profile on macOS
    const bashrc = path.join(home, '.bashrc');
    const profile = path.join(home, '.bash_profile');
    rcFile = fs.existsSync(bashrc) ? bashrc : profile;
  } else if (shell.endsWith('/fish')) {
    rcFile = path.join(home, '.config', 'fish', 'config.fish');
  }

  if (!rcFile) return;

  try {
    const content = fs.existsSync(rcFile)
      ? fs.readFileSync(rcFile, 'utf-8')
      : '';
    // Use a marker to detect our managed PATH entry precisely,
    // avoiding false positives from comments or $PATH-appended entries
    const marker = '# Added by Qwen Code standalone installer';
    if (content.includes(marker)) return;

    const exportLine = shell.endsWith('/fish')
      ? `\n${marker}\nfish_add_path "${binDir}"\n`
      : `\n${marker}\nexport PATH="${binDir}:$PATH"\n`;
    fs.appendFileSync(rcFile, exportLine);
    debugLogger.info(`Added ${binDir} to ${rcFile}`);
  } catch (err) {
    debugLogger.debug('Failed to update shell rc:', err);
  }
}

/**
 * Detect the current platform target string for standalone archives.
 */
function detectTarget(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin')
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'win32') return 'win-x64';
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

export async function performStandaloneUpdate(
  standaloneDir: string,
  newVersion: string,
): Promise<'done' | 'deferred'> {
  const versionPath = normalizeVersion(newVersion);

  let target: string;
  const manifestPath = path.join(standaloneDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as { target?: string };
    target = manifest.target || detectTarget();
  } else if (fs.existsSync(standaloneDir)) {
    // Directory exists but has no manifest — not a managed Qwen install.
    // Refuse to overwrite to avoid data loss.
    throw new Error(
      `${standaloneDir} exists but is not a Qwen Code standalone install. Remove it manually to proceed.`,
    );
  } else {
    // First-time migration from npm — directory does not exist yet
    target = detectTarget();
    fs.mkdirSync(standaloneDir, { recursive: true });
  }
  validateTarget(target);

  const filename = archiveFilename(target);
  const parentDir = path.dirname(standaloneDir);

  // Use a lockfile to prevent concurrent updates
  const lockPath = path.join(parentDir, '.qwen-update.lock');
  if (!acquireLock(lockPath)) {
    throw new Error('Another update is already in progress');
  }

  // Download to a temp dir in os.tmpdir(), then extract to a sibling dir
  // of standaloneDir to avoid EXDEV (cross-device rename).
  // extractDir uses mkdtempSync (random suffix) to prevent symlink
  // pre-creation attacks on predictable directory names.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-code-update-'));
  let extractDir: string;
  try {
    extractDir = fs.mkdtempSync(path.join(parentDir, '.qwen-code-update-'));
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  try {
    const archivePath = path.join(tempDir, filename);
    debugLogger.info(`Downloading ${filename} (${versionPath})...`);
    await downloadToFile(versionPath, filename, archivePath);

    debugLogger.info('Verifying checksum...');
    await verifyChecksum(archivePath, filename, versionPath);

    debugLogger.info('Extracting archive...');
    await extractArchive(archivePath, extractDir, target);

    const newInstallDir = path.join(extractDir, 'qwen-code');
    if (!fs.existsSync(path.join(newInstallDir, 'manifest.json'))) {
      throw new Error(
        'Extracted archive does not contain expected qwen-code directory',
      );
    }

    debugLogger.info('Running smoke test...');
    await smokeTest(newInstallDir, target);

    debugLogger.info('Replacing installation...');
    const result = atomicReplace(standaloneDir, newInstallDir, lockPath);

    // Write rollback metadata so /doctor rollback knows what version is preserved
    const oldDir = `${standaloneDir}.old`;
    if (fs.existsSync(oldDir)) {
      try {
        // Read the old manifest to capture its version
        const oldManifestPath = path.join(oldDir, 'manifest.json');
        let oldVersion = 'unknown';
        if (fs.existsSync(oldManifestPath)) {
          const oldManifest = JSON.parse(
            fs.readFileSync(oldManifestPath, 'utf-8'),
          ) as { version?: string };
          oldVersion = oldManifest.version || 'unknown';
        }
        const rollbackInfo = {
          preservedVersion: oldVersion,
          updatedTo: versionPath,
          timestamp: new Date().toISOString(),
          reason: 'auto-update',
        };
        fs.writeFileSync(
          path.join(oldDir, '.qwen-rollback-info.json'),
          JSON.stringify(rollbackInfo, null, 2),
        );
      } catch {
        // Non-critical — rollback still works without metadata
      }
    }

    // Ensure bin wrapper exists (critical for npm→standalone migration)
    ensureBinWrapper(standaloneDir, target);

    debugLogger.info('Standalone update complete.');
    return result;
  } catch (err) {
    // On error: clean orphaned pendingDir (only safe when NOT a successful deferred update)
    const pendingDir = `${standaloneDir}.new`;
    if (fs.existsSync(pendingDir)) {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    }
    throw err;
  } finally {
    // On Windows deferred updates, keep the lock alive until the bat script
    // finishes the swap — it will be cleaned up by the next successful update.
    // On Unix (immediate), release the lock now.
    if (os.platform() !== 'win32') {
      releaseLock(lockPath);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

export type RollbackResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'no-old' | 'no-manifest' | 'rename-failed';
      detail: string;
    };

/**
 * Rolls back a standalone installation to the previous version (.old directory).
 */
export function rollbackStandaloneUpdate(
  standaloneDir: string,
): RollbackResult {
  const oldDir = `${standaloneDir}.old`;

  if (!fs.existsSync(oldDir)) {
    return { ok: false, reason: 'no-old', detail: `${oldDir} does not exist` };
  }

  const oldManifest = path.join(oldDir, 'manifest.json');
  if (!fs.existsSync(oldManifest)) {
    debugLogger.error('Rollback failed: .old directory has no manifest.json');
    return {
      ok: false,
      reason: 'no-manifest',
      detail: `${oldDir}/manifest.json missing — .old may be corrupt`,
    };
  }

  const failedDir = `${standaloneDir}.failed`;
  try {
    if (fs.existsSync(failedDir)) {
      fs.rmSync(failedDir, { recursive: true, force: true });
    }
    fs.renameSync(standaloneDir, failedDir);
    fs.renameSync(oldDir, standaloneDir);
    fs.rmSync(failedDir, { recursive: true, force: true });
    debugLogger.info('Rollback successful.');
    return { ok: true };
  } catch (err) {
    debugLogger.error('Rollback failed:', err);
    // Attempt to restore current if we moved it
    if (!fs.existsSync(standaloneDir) && fs.existsSync(failedDir)) {
      try {
        fs.renameSync(failedDir, standaloneDir);
      } catch {
        // Critical failure — both dirs are in bad state
      }
    }
    return {
      ok: false,
      reason: 'rename-failed',
      detail: `Filesystem error: ${(err as Error).message}. Manual recovery: mv "${oldDir}" "${standaloneDir}"`,
    };
  }
}
