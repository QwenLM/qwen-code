import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fetch } from 'undici';
import * as tar from 'tar';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

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
      `rmdir /s /q "${oldDir}" 2>nul`,
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
    fs.rmSync(oldDir, { recursive: true, force: true });
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

    debugLogger.info('Replacing installation...');
    const result = atomicReplace(standaloneDir, newInstallDir);
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
