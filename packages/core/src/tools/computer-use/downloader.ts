/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Downloads + installs the pinned cua-driver binary into
 * `~/.qwen/computer-use/`.
 *
 * Source order is OSS mirror → GitHub (see constants.resolveAssetUrls); the
 * first reachable source wins. The asset's sha256 is verified against the
 * release `checksums.txt` before extraction — this guards against truncation
 * and corruption in transit. It does NOT defend against a compromised mirror:
 * `checksums.txt` is fetched from the same source order, so whichever source
 * wins controls both the asset and its expected hash. The real second factor
 * on macOS is signing — the binaries are Developer-ID-signed + Apple-notarized
 * by Cua AI, Inc., so they pass Gatekeeper; Linux/Windows have no equivalent
 * signature check.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { x as tarExtract } from 'tar';
import {
  CUA_DRIVER_VERSION,
  binaryPath,
  resolveAssetTarget,
  resolveAssetUrls,
  resolveChecksumUrls,
  versionDir,
} from './constants.js';

export interface InstallOptions {
  home: string;
  platform?: NodeJS.Platform;
  arch?: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  /** Progress hook for the bootstrap UI ("Downloading… (~Xs)"). */
  onProgress?: (message: string) => void;
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Injection point for unzipping Windows `.zip` assets; defaults to OS tools
   * (bsdtar, then PowerShell). Tests and non-bsdtar hosts can override it.
   */
  unzipImpl?: (zipPath: string, destDir: string) => Promise<void>;
}

/**
 * Parse a release `checksums.txt` body into a `{ filename -> sha256 }` map.
 * Each line is `<hex-sha256>␠␠<filename>` (sha256sum format).
 */
export function parseChecksums(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of body.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

/** Returns the installed binary path if already present, else undefined. */
export async function findInstalled(
  home: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = CUA_DRIVER_VERSION,
): Promise<string | undefined> {
  const p = binaryPath(home, platform, arch, version);
  try {
    const s = await stat(p);
    if (s.isFile()) return p;
  } catch {
    // not installed
  }
  return undefined;
}

/** Fetch the first reachable URL from `urls`, returning the Response body bytes. */
async function fetchFirst(
  urls: string[],
  fetchImpl: typeof fetch,
  onProgress?: (m: string) => void,
): Promise<{ url: string; res: Response }> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      // 30s timeout on obtaining the RESPONSE/headers only — a stalled mirror
      // (TCP connects but never responds) fails over in ~30s. Cleared the
      // moment headers arrive so the body download is NOT capped: a ~20MB
      // binary over a slow/throttled CN→GitHub link routinely needs more than
      // 30s, and capping the whole transfer would abort it mid-stream — the
      // exact failure the mirror + fallback exist to avoid. (review round 2)
      const controller = new AbortController();
      const headersTimeout = setTimeout(() => {
        controller.abort(new Error(`headers timeout after 30s for ${url}`));
      }, 30_000);
      try {
        const res = await fetchImpl(url, {
          redirect: 'follow',
          signal: controller.signal,
        });
        if (res.ok && res.body) return { url, res };
        await res.body?.cancel();
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
      } finally {
        clearTimeout(headersTimeout);
      }
    } catch (err) {
      lastErr = err;
      onProgress?.(`Source unreachable, trying fallback…`);
    }
  }
  throw new Error(
    `Computer Use: all download sources failed. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Ensure the pinned cua-driver binary is installed, downloading +
 * verifying + extracting it if necessary. Returns the binary path.
 * Idempotent: a no-op (fast stat) when already installed.
 */
export async function ensureInstalled(opts: InstallOptions): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const version = opts.version ?? CUA_DRIVER_VERSION;
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const onProgress = opts.onProgress;

  const existing = await findInstalled(opts.home, platform, arch, version);
  if (existing) return existing;

  const target = resolveAssetTarget(platform, arch, version);
  onProgress?.('Downloading Computer Use driver (~20MB, one time)...');

  // 1. Resolve expected sha256 from checksums.txt (first reachable source).
  const { res: sumRes } = await fetchFirst(
    resolveChecksumUrls(env, version),
    fetchImpl,
  );
  const checksums = parseChecksums(await sumRes.text());
  const expectedSha = checksums.get(target.asset);
  if (!expectedSha) {
    throw new Error(
      `Computer Use: ${target.asset} missing from checksums.txt.`,
    );
  }

  // 2. Download the asset to a temp file, hashing as we stream.
  const { res } = await fetchFirst(
    resolveAssetUrls(target.asset, env, version),
    fetchImpl,
    onProgress,
  );
  await mkdir(computerUseTmp(opts.home), { recursive: true });
  // Name the temp file with the asset's real extension (no `.part`): Windows
  // unzip tools key off it — Expand-Archive accepts only `.zip`, and bsdtar
  // likewise. A stale half-download is overwritten + re-verified next run.
  const tmpFile = join(computerUseTmp(opts.home), target.asset);
  const hash = createHash('sha256');
  const nodeStream = Readable.fromWeb(res.body as never);
  // Body-level idle watchdog. The headers timeout (fetchFirst) is cleared once
  // headers arrive, so without this a source that sends headers then stalls
  // mid-stream would hang the install forever. Reset on each chunk — slow but
  // progressing is fine; 60s with no bytes means stalled → abort. (review #3)
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      nodeStream.destroy(new Error('download stalled: no data for 60s'));
    }, 60_000);
  };
  nodeStream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    armIdle();
  });
  armIdle();
  try {
    await pipeline(nodeStream, createWriteStream(tmpFile));
  } finally {
    clearTimeout(idleTimer);
  }

  // 3. Verify sha256 before trusting the bytes.
  const actualSha = hash.digest('hex');
  if (actualSha !== expectedSha) {
    await rm(tmpFile, { force: true });
    throw new Error(
      `Computer Use: checksum mismatch for ${target.asset} ` +
        `(expected ${expectedSha.slice(0, 12)}…, got ${actualSha.slice(0, 12)}…).`,
    );
  }

  // 4. Extract into the version dir, then atomically expose it. macOS/Linux
  //    ship .tar.gz (node `tar`); Windows ships .zip (OS unzip — see
  //    extractArchive, which pulls in no new dependency).
  const dir = versionDir(opts.home, version);
  const stagingDir = `${dir}.staging`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  await extractArchive(tmpFile, stagingDir, target.asset, opts.unzipImpl);
  await rm(tmpFile, { force: true });
  await rm(dir, { recursive: true, force: true });
  await rename(stagingDir, dir);

  // 5. Make the binary executable (macOS/Linux only; the exec bit is
  //    meaningless on Windows and `chmod` there is a no-op at best).
  const bin = binaryPath(opts.home, platform, arch, version);
  if (platform !== 'win32') {
    await chmod(bin, 0o755);
  }

  // 6. macOS: prepare CuaDriver.app for the TCC auto-relaunch path.
  if (platform === 'darwin' && target.hasApp) {
    const extractRoot = join(dir, target.extractDir);
    const appDir = join(extractRoot, 'CuaDriver.app');
    // Strip quarantine so the notarized app launches without a Gatekeeper
    // prompt (best-effort; notarized binaries pass regardless).
    await stripQuarantine(extractRoot);
    // Register with LaunchServices so cua-driver's `open -a CuaDriver serve`
    // relaunch resolves THIS copy under ~/.qwen — that relaunch is what makes
    // TCC attribute Accessibility / Screen Recording to com.trycua.driver
    // instead of the launching terminal (iTerm/Terminal/VS Code). Without it
    // the auto-relaunch can't find our app and falls back to the terminal's
    // TCC identity. Best-effort; non-fatal.
    await registerLaunchServices(appDir);
  }

  onProgress?.('Computer Use driver ready.');
  return bin;
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/' +
  'Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

/** Register a `.app` with LaunchServices so `open -a <Name>` resolves it. */
async function registerLaunchServices(appPath: string): Promise<void> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(LSREGISTER, ['-f', appPath], { timeout: 15_000 });
  } catch {
    // Non-fatal: if registration fails the relaunch may resolve a different
    // CuaDriver.app or stay in-process. The driver still works; only the TCC
    // identity attribution is affected.
  }
}

function computerUseTmp(home: string): string {
  // Keep temp downloads off the user's TMPDIR so a half-download never
  // collides with another tool; scope under the install root's parent.
  return join(
    tmpdir(),
    'qwen-computer-use-dl',
    Buffer.from(home).toString('hex').slice(0, 8),
  );
}

/** Best-effort `xattr -dr com.apple.quarantine` so the notarized app launches clean. */
async function stripQuarantine(path: string): Promise<void> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('xattr', ['-dr', 'com.apple.quarantine', path], {
      timeout: 10_000,
    });
  } catch {
    // Notarized binaries pass Gatekeeper regardless; quarantine strip is a
    // belt-and-suspenders nicety. Never fatal.
  }
}

/**
 * Extract a downloaded asset into `destDir`. macOS/Linux ship `.tar.gz`
 * (handled by the `tar` dep); Windows ships `.zip`, which `tar` cannot read —
 * there we shell out to OS unzip tools so we add no new dependency.
 */
async function extractArchive(
  archivePath: string,
  destDir: string,
  asset: string,
  unzipImpl?: (zipPath: string, destDir: string) => Promise<void>,
): Promise<void> {
  if (asset.endsWith('.zip')) {
    await (unzipImpl ?? extractZipWindows)(archivePath, destDir);
  } else {
    await tarExtract({ file: archivePath, cwd: destDir });
  }
}

/**
 * Unzip a `.zip` on Windows with no new dependency, trying OS tools in order:
 *   1. `tar -xf` (no flags) — Windows 10 1803+ ships bsdtar (libarchive) as
 *      `tar.exe`; it reads zip AND handles `C:\…` paths natively. Most hosts.
 *   2. `tar --force-local -xf` — if GNU tar shadows bsdtar on PATH (e.g. Git
 *      for Windows), it otherwise reads `C:\…` as a remote `host:path`; the
 *      flag forces a local path. bsdtar REJECTS `--force-local`, which is why
 *      it must be the SECOND attempt, not the first. (review round 1 — the
 *      earlier code put `--force-local` first, so bsdtar always failed and
 *      every install silently leaned on the PowerShell fallback.)
 *   3. PowerShell `Expand-Archive` — last resort.
 * Surfaces all failures if none succeed.
 */
async function extractZipWindows(
  zipPath: string,
  destDir: string,
): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const psCommand =
    `Expand-Archive -LiteralPath ${psSingleQuote(zipPath)} ` +
    `-DestinationPath ${psSingleQuote(destDir)} -Force`;
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'tar', args: ['-xf', zipPath, '-C', destDir] },
    { cmd: 'tar', args: ['--force-local', '-xf', zipPath, '-C', destDir] },
    {
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    },
  ];
  const errors: string[] = [];
  for (const { cmd, args } of attempts) {
    try {
      await run(cmd, args, { timeout: 180_000 });
      return;
    } catch (err) {
      errors.push(`${cmd} ${args[0]}: ${errMsg(err)}`);
    }
  }
  throw new Error(
    `Computer Use: failed to unzip ${zipPath} on Windows (${errors.join('; ')}).`,
  );
}

/** Quote a string as a PowerShell single-quoted literal (`'` → `''`). */
function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
