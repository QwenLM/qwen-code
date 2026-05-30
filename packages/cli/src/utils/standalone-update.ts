import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
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

async function tryFetch(url: string): Promise<UndiciResponse | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) return res;
  } catch (err) {
    debugLogger.debug(`Fetch failed for ${url}: ${err}`);
  }
  return null;
}

async function downloadWithFallback(
  versionPath: string,
  filename: string,
): Promise<UndiciResponse> {
  const ossUrl = `${OSS_BASE}/${versionPath}/${filename}`;
  const ossRes = await tryFetch(ossUrl);
  if (ossRes) return ossRes;

  const ghUrl = `${GITHUB_BASE}/${versionPath}/${filename}`;
  const ghRes = await tryFetch(ghUrl);
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

  // Verify Ed25519 signature of SHA256SUMS if available (try OSS then GitHub)
  const requireSig = process.env.QWEN_REQUIRE_SIGNATURE === '1';
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
    debugLogger.debug(
      'SHA256SUMS.sig not available — skipping signature verification.',
    );
  }

  const expectedLine = text.split('\n').find((line) => {
    const parts = line.trim().split(/\s+/);
    return parts.length >= 2 && parts[parts.length - 1] === filename;
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

async function downloadToFile(
  versionPath: string,
  filename: string,
  destPath: string,
): Promise<void> {
  const response = await downloadWithFallback(versionPath, filename);
  const body = response.body;
  if (!body) throw new Error('Empty response body');
  const dest = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(body), dest);
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
      filter: (p) => !p.startsWith('/') && !p.includes('..'),
    });
  }
}

/**
 * Runs a command and captures stdout/exit code.
 */
function spawnAndCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs },
      (err, out) => {
        if (err && 'killed' in err && err.killed) {
          reject(new Error('Smoke test timed out'));
          return;
        }
        const exitCode =
          err && 'code' in err && typeof err.code === 'number' ? err.code : 0;
        resolve({ exitCode, stdout: out || '' });
      },
    );
    child.on('error', reject);
  });
}

/**
 * Verifies the new installation can actually run by invoking --version.
 * Prevents replacing a working install with a broken binary.
 */
async function smokeTest(newInstallDir: string, target: string): Promise<void> {
  const nodeBin = target.startsWith('win')
    ? path.join(newInstallDir, 'node', 'node.exe')
    : path.join(newInstallDir, 'node', 'bin', 'node');
  const cliBin = path.join(newInstallDir, 'lib', 'cli.js');

  if (!fs.existsSync(nodeBin)) {
    throw new Error(`Smoke test failed: node binary not found at ${nodeBin}`);
  }
  if (!fs.existsSync(cliBin)) {
    throw new Error(`Smoke test failed: cli.js not found at ${cliBin}`);
  }

  const { exitCode, stdout } = await spawnAndCapture(
    nodeBin,
    [cliBin, '--version'],
    10_000,
  );
  if (exitCode !== 0) {
    throw new Error(
      `Smoke test failed: new binary exited with code ${exitCode}`,
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
      if (pid && !isProcessAlive(pid)) {
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

    const script = [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 >nul & goto wait)`,
      `move /Y "${standaloneDir}" "${oldDir}"`,
      `move /Y "${pendingDir}" "${standaloneDir}"`,
      'rem Keep .old for rollback',
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
    } catch (err) {
      fs.renameSync(oldDir, standaloneDir);
      throw err;
    }
    // Keep .old for rollback instead of deleting immediately
    return 'done';
  }
}

export async function performStandaloneUpdate(
  standaloneDir: string,
  newVersion: string,
): Promise<'done' | 'deferred'> {
  const versionPath = normalizeVersion(newVersion);

  const manifestRaw = fs.readFileSync(
    path.join(standaloneDir, 'manifest.json'),
    'utf-8',
  );
  const manifest = JSON.parse(manifestRaw) as { target?: string };
  const target = manifest.target;
  if (!target) {
    throw new Error('manifest.json missing target field');
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-code-update-'));
  const extractDir = path.join(parentDir, '.qwen-code-update-staging');

  try {
    const archivePath = path.join(tempDir, filename);
    debugLogger.info(`Downloading ${filename} (${versionPath})...`);
    await downloadToFile(versionPath, filename, archivePath);

    debugLogger.info('Verifying checksum...');
    await verifyChecksum(archivePath, filename, versionPath);

    debugLogger.info('Extracting archive...');
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
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
    const result = atomicReplace(standaloneDir, newInstallDir);

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

    debugLogger.info('Standalone update complete.');
    return result;
  } finally {
    releaseLock(lockPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

/**
 * Rolls back a standalone installation to the previous version (.old directory).
 * Returns true if rollback succeeded, false if no rollback available.
 */
export function rollbackStandaloneUpdate(standaloneDir: string): boolean {
  const oldDir = `${standaloneDir}.old`;

  if (!fs.existsSync(oldDir)) {
    return false;
  }

  const oldManifest = path.join(oldDir, 'manifest.json');
  if (!fs.existsSync(oldManifest)) {
    debugLogger.error('Rollback failed: .old directory has no manifest.json');
    return false;
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
    return true;
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
    return false;
  }
}
