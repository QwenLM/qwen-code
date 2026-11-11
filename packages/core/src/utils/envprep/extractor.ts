/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 7-Zip archive extractor for environment preparation.
 *
 * Extracts `.7z` and `.exe` (including self-extracting `.7z.exe`) archives
 * using an external 7z/7zr tool. Includes retry logic with delays to cope
 * with Windows Defender scanning the downloaded archive.
 *
 * Modeled after the Go version's envprep/extract.go.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { delay } from '../delay.js';
import { runLogger } from '../runLogger.js';
import { runWindowsExecutableProbe } from '../windowsExecutableProbe.js';

/** Maximum retries for 7z extraction. */
const MAX_RETRIES = 3;
/** Delay between retries in ms. */
const RETRY_DELAY = 2000;
/** Initial wait for antivirus scan on Windows. */
const AV_SCAN_DELAY = 500;
/** Extraction command timeout in ms (10 min). */
const EXTRACT_TIMEOUT = 10 * 60 * 1000;

/**
 * Converts raw bytes to printable ASCII, stripping non-ASCII bytes.
 * Useful for debugging 7z output on Chinese Windows (GBK console encoding).
 */
function decodeToASCII(buf: Buffer): string {
  const result: number[] = [];
  for (const b of buf) {
    if (b >= 32 && b <= 126) {
      result.push(b);
    } else if (b === 10) {
      result.push(10); // LF
    } else if (b === 9) {
      result.push(32); // TAB → space
    }
    // CR and non-ASCII bytes are dropped
  }
  return Buffer.from(result).toString('ascii');
}

/**
 * Truncates a string to `maxLen` characters, appending "..." if truncated.
 */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '...';
}

/**
 * Resolves a path to its real path (resolving symlinks and Windows 8.3
 * short names). Falls back to `path.resolve` for non-existent paths.
 *
 * Equivalent to `getRealPath` in `utils/fileUtils.ts` — inlined here
 * to avoid pulling in heavy transitive dependencies (mime, genai, etc.).
 */
function getRealPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Checks common system paths and PATH for a 7z installation.
 * Returns the path to `7z.exe` if found, or `null`.
 *
 * Shared between `Extractor.find7zExecutable()` and
 * `SevenZrPreparer.isRequired()`.
 */
export async function findSystem7zPath(
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const systemPaths = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const p of systemPaths) {
    if (existsSync(p)) {
      runLogger.debug(`[envprep/extractor] Found system 7z: ${p}`);
      return p;
    }
  }

  try {
    const result = await runWindowsExecutableProbe('7z', signal);
    const first = result.split('\r\n')[0];
    if (first && existsSync(first)) {
      runLogger.debug(`[envprep/extractor] Found 7z from PATH: ${first}`);
      return first;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw error;
    }
    // 7z not in PATH
  }

  return null;
}

export class Extractor {
  constructor(private readonly sevenZrPath?: string) {}

  /**
   * Finds the best available 7z extraction tool.
   * Priority: system 7z.exe → prepared 7zr.exe.
   */
  private async find7zExecutable(signal?: AbortSignal): Promise<string | null> {
    // 1 & 2. System 7z (common paths + PATH)
    const system7z = await findSystem7zPath(signal);
    if (system7z) return system7z;

    // 3. Prepared 7zr.exe
    if (this.sevenZrPath && existsSync(this.sevenZrPath)) {
      runLogger.debug(
        `[envprep/extractor] Using prepared 7zr: ${this.sevenZrPath}`,
      );
      return this.sevenZrPath;
    }

    runLogger.warn('[envprep/extractor] No 7z extraction tool found');
    return null;
  }

  /**
   * Extracts a `.7z` or `.exe` archive to `destDir`.
   * Retries up to 3 times with a 2-second interval.
   */
  async extract(
    archivePath: string,
    destDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    // Validate archive format — .7z and .exe (including self-extracting .7z.exe)
    // are supported, matching Go's extract.go: case ".7z", ".exe"
    const name = path.basename(archivePath).toLowerCase();
    if (!name.endsWith('.7z') && !name.endsWith('.exe')) {
      const ext = path.extname(archivePath);
      throw new Error(
        `Unsupported archive format: ${ext} (only .7z and .exe are supported)`,
      );
    }

    // Normalize paths to resolve symlinks and Windows 8.3 short names
    const normalizedArchive = getRealPath(archivePath);
    const normalizedDest = getRealPath(destDir);

    runLogger.log(
      `[envprep/extractor] Extracting ${normalizedArchive} → ${normalizedDest}`,
    );

    mkdirSync(normalizedDest, { recursive: true });

    const stat = statSync(normalizedArchive);
    runLogger.debug(`[envprep/extractor] Archive size: ${stat.size} bytes`);

    const exePath = await this.find7zExecutable(signal);
    signal?.throwIfAborted();
    if (!exePath) {
      throw new Error(
        'No 7z extraction tool available. ' +
          'Please install 7-Zip from https://7-zip.org or try again later.',
      );
    }

    // Brief initial wait for antivirus scan
    await delay(AV_SCAN_DELAY, signal);

    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      runLogger.debug(`[envprep/extractor] Attempt ${attempt}/${MAX_RETRIES}`);

      try {
        await this.run7z(exePath, normalizedArchive, normalizedDest, signal);
        signal?.throwIfAborted();
        const entries = readdirSync(normalizedDest);
        runLogger.log(
          `[envprep/extractor] Success: ${entries.length} top-level entries`,
        );
        return;
      } catch (err) {
        signal?.throwIfAborted();
        lastErr = err instanceof Error ? err : new Error(String(err));
        runLogger.warn(
          `[envprep/extractor] Attempt ${attempt} failed: ${lastErr.message}`,
        );
        if (attempt < MAX_RETRIES) {
          await delay(RETRY_DELAY, signal);
        }
      }
    }

    throw new Error(
      `7z extraction failed after ${MAX_RETRIES} attempts: ${lastErr?.message}`,
    );
  }

  /**
   * Runs `7z x -y -o<destDir> <archivePath>` and throws on non-zero exit.
   */
  private run7z(
    exePath: string,
    archivePath: string,
    destDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const args = ['x', '-y', `-o${destDir}`, archivePath];
      runLogger.debug(
        `[envprep/extractor] Running: ${exePath} ${args.join(' ')}`,
      );
      const child = execFile(
        exePath,
        args,
        {
          timeout: EXTRACT_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          signal?.removeEventListener('abort', stop);
          if (error) {
            // Include both stdout and stderr for a richer error message
            const combined = [stdout, stderr].filter(Boolean).join('\n');
            const msg = combined
              ? truncate(decodeToASCII(Buffer.from(combined)), 500)
              : error.message;
            reject(new Error(`7z error: ${msg}`));
          } else {
            resolve();
          }
        },
      );
      // Wait for execFile's completion before the caller cleans staging and releases its lock.
      const stop = () => child.kill();
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
}
