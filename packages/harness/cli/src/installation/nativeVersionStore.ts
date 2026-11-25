/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  copyFile,
  mkdir,
  symlink,
  unlink,
  readlink,
  realpath,
  lstat,
  stat,
  readdir,
  rename,
  chmod,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runLogger } from '@qwen-code/core';
import type { ManifestFile } from './update/updateTypes.js';
import { LOCAL_VERSION_FILENAME } from './update/updateTypes.js';
import { withErrorContext } from './update/updateErrors.js';
import { compareVersions } from './versions.js';

export interface NativePaths {
  readonly binaryName: string;
  readonly binDir: string;
  readonly linkPath: string;
}

/** @internal Native execution primitives for the CLI installation service.
 * Product-independent native filesystem operations. Constructed explicitly, with no global owner. */
export function createNativeVersionStore(paths: NativePaths) {
  const BRAND_CLI_BIN = paths.binaryName;
  const BIN_DIR = paths.binDir;
  const LINK_PATH = paths.linkPath;
  const execFileAsync = promisify(execFile);
  const STDERR_CLIP_CHARS = 200;

  /**
   * Archive-tool failures are only attributable through the exit code and stderr
   * (corrupt archive vs missing tool vs unwritable target). Both usually already
   * sit in the message, so append only what is missing — and bounded, because
   * log output truncates long messages.
   */
  function annotateExecError(error: unknown, command: string): Error {
    const base = error instanceof Error ? error : new Error(String(error));
    const parts: string[] = [];

    const exitCode = (base as { code?: unknown }).code;
    if (typeof exitCode === 'number') parts.push(`exit ${exitCode}`);

    const stderr = String((base as { stderr?: unknown }).stderr ?? '').trim();
    if (!base.message.includes(stderr.slice(0, 60))) {
      const clipped = stderr.slice(0, STDERR_CLIP_CHARS);
      parts.push(
        `stderr: ${clipped.replace(/\s*\n\s*/g, ' | ')}${
          stderr.length > clipped.length ? '…' : ''
        }`,
      );
    }

    return parts.length
      ? withErrorContext(base, `${command}: ${parts.join(', ')}`)
      : base;
  }

  async function writeLocalVersion(version: string): Promise<void> {
    await mkdir(BIN_DIR, { recursive: true });
    await writeFile(join(BIN_DIR, LOCAL_VERSION_FILENAME), `${version}\n`, {
      mode: 0o644,
    });
  }

  async function installVersionBinary(src: string, dst: string): Promise<void> {
    const tmpPath = `${dst}.tmp.${process.pid}.${Date.now()}`;
    try {
      await copyFile(src, tmpPath);
      await chmod(tmpPath, 0o755);
      await renameWithRetry(tmpPath, dst);
    } catch (err) {
      // Cleanup temp file on failure
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async function renameWithRetry(src: string, dst: string): Promise<void> {
    if (process.platform !== 'win32') {
      await rename(src, dst);
      return;
    }
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await rename(src, dst);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EBUSY') && attempt < maxAttempts) {
          runLogger.debug(
            `[BinaryUpdater] rename attempt ${attempt} failed with ${code}, retrying...`,
          );
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Create/update a symlink from linkPath to target.
   *
   * Aligned with Go `UpdateLink()`:
   *   - Prefer symlink
   *   - If symlink fails (e.g. Windows, permission), fallback to file copy
   *   - On Windows, rename existing file before replacing
   */
  async function updateLink(target: string, linkPath: string): Promise<void> {
    // Ensure parent directory exists
    const parentDir = join(linkPath, '..');
    await mkdir(parentDir, { recursive: true });

    try {
      // Remove existing symlink/file first
      await removeOrRename(linkPath);
      await symlink(target, linkPath);
      runLogger.debug(
        `[BinaryUpdater] Symlink created: ${linkPath} -> ${target}`,
      );
    } catch {
      // Fallback: file copy (Windows or permission issues)
      runLogger.debug(
        '[BinaryUpdater] Symlink failed, falling back to file copy',
      );
      try {
        await removeOrRename(linkPath);
        await copyFile(target, linkPath);
        await chmod(linkPath, 0o755);

        // Copy install source marker to entry point directory (for Windows hardcopy scenario).
        // Without this, DetectSource cannot identify the installation method from the
        // entry point directory after a file-copy update on Windows.
        await copyInstallMarker(join(target, '..'), join(linkPath, '..'));
      } catch (copyErr) {
        throw new Error(
          `Failed to update link at ${linkPath}: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
        );
      }
    }
  }

  /**
   * Remove a file, or on Windows rename it to .old.{timestamp} if busy.
   *
   * Aligned with Go `removeOrRename()`.
   */
  async function removeOrRename(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') return; // Already gone

      // Windows: file may be locked by a running process
      if (
        process.platform === 'win32' &&
        (code === 'EBUSY' || code === 'EPERM')
      ) {
        const oldPath = `${filePath}.old.${Date.now()}`;
        await rename(filePath, oldPath);
        runLogger.debug(
          `[BinaryUpdater] Renamed busy file: ${filePath} -> ${oldPath}`,
        );
        return;
      }

      throw err;
    }
  }

  /**
   * Copy the install source marker file from srcDir to dstDir.
   *
   * This is needed for Windows where symlinks require admin privileges, so updateLink
   * falls back to file copy. Without copying the marker, readInstallSourceMarker()
   * cannot identify the installation method from the entry point directory.
   */
  async function copyInstallMarker(
    srcDir: string,
    dstDir: string,
  ): Promise<void> {
    const markerName = `.${BRAND_CLI_BIN}-install-resource`;
    const srcMarker = join(srcDir, markerName);
    const dstMarker = join(dstDir, markerName);

    try {
      await copyFile(srcMarker, dstMarker);
      runLogger.debug(
        `[BinaryUpdater] Copied install marker: ${srcMarker} -> ${dstMarker}`,
      );
    } catch {
      // Source marker doesn't exist or copy failed — non-critical, skip silently
    }
  }

  /**
   * Extract a single binary from an archive.
   * Returns the path to the extracted binary.
   *
   * Supports .tar.gz and .zip (aligned with Go Extract / Unzip functions).
   */
  async function extractArchive(
    archivePath: string,
    extractDir: string,
    file: ManifestFile,
  ): Promise<string> {
    const ext = getArchiveExtension(file.url);

    if (ext === '.tar.gz' || ext === '.tgz') {
      return extractTarGz(archivePath, extractDir);
    } else if (ext === '.zip') {
      return extractZip(archivePath, extractDir);
    }

    // If not an archive, treat the downloaded file as the binary itself
    return archivePath;
  }

  /**
   * Extract a .tar.gz archive and return the path to the extracted binary.
   *
   * Aligned with Go `ExtractTarGzSingleBinary()`.
   * Uses the system `tar` command for simplicity and broad compatibility.
   */
  async function extractTarGz(
    archivePath: string,
    extractDir: string,
  ): Promise<string> {
    try {
      await execFileAsync('tar', ['xzf', archivePath, '-C', extractDir], {
        windowsHide: true,
      });
    } catch (error) {
      throw annotateExecError(error, 'tar xzf');
    }
    return findExtractedBinary(extractDir);
  }

  /**
   * Extract a .zip archive and return the path to the extracted binary.
   *
   * Aligned with Go `UnzipSingleBinary()`.
   * On Windows: uses built-in tar.exe (available since Windows 10 1803) which
   * handles zip natively. Falls back to PowerShell Expand-Archive if tar fails.
   * On other platforms: uses system `unzip`.
   */
  async function extractZip(
    archivePath: string,
    extractDir: string,
  ): Promise<string> {
    if (process.platform === 'win32') {
      let extracted = false;

      // Primary: Windows built-in tar.exe (more reliable with Bun's child_process)
      try {
        await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir], {
          windowsHide: true,
        });
        extracted = true;
      } catch (tarErr) {
        runLogger.debug(
          `[BinaryUpdater] tar.exe failed, falling back to PowerShell: ${tarErr instanceof Error ? tarErr.message : String(tarErr)}`,
        );
      }

      // Fallback: PowerShell Expand-Archive
      if (!extracted) {
        try {
          const { stderr } = await execFileAsync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `$ErrorActionPreference='Stop'; Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`,
            ],
            { windowsHide: true },
          );
          if (stderr) {
            runLogger.debug(`[BinaryUpdater] Expand-Archive stderr: ${stderr}`);
          }
        } catch (error) {
          throw annotateExecError(error, 'Expand-Archive');
        }
      }

      // Verify extraction produced files
      const postEntries = await readdir(extractDir);
      if (postEntries.length === 0) {
        throw new Error(
          `Zip extraction produced no files. Archive: ${archivePath}, extractDir: ${extractDir}`,
        );
      }
    } else {
      try {
        await execFileAsync('unzip', ['-o', archivePath, '-d', extractDir], {
          windowsHide: true,
        });
      } catch (error) {
        throw annotateExecError(error, 'unzip');
      }
    }
    return findExtractedBinary(extractDir);
  }

  /**
   * Find the main binary in an extraction directory.
   * Looks for a file matching BRAND_CLI_BIN (with or without extension).
   */
  async function findExtractedBinary(extractDir: string): Promise<string> {
    // Fast path: try the expected filename directly (avoids readdir issues on Windows/Bun)
    const suffixes = process.platform === 'win32' ? ['.exe', ''] : ['', '.bin'];
    for (const suffix of suffixes) {
      const candidate = join(extractDir, `${BRAND_CLI_BIN}${suffix}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    // Fallback: scan directory without recursive (covers flat archives)
    let entries = await readdir(extractDir);

    for (const entry of entries) {
      const name = basename(entry.toString());
      const nameNoExt = name.replace(/\.(exe|bin)$/, '');
      if (nameNoExt === BRAND_CLI_BIN) {
        return join(extractDir, entry.toString());
      }
    }

    if (entries.length === 1) {
      return join(extractDir, entries[0].toString());
    }

    // Last resort: recursive scan for nested archives
    if (entries.length === 0) {
      entries = await readdir(extractDir, { recursive: true });
      for (const entry of entries) {
        const name = basename(entry.toString());
        const nameNoExt = name.replace(/\.(exe|bin)$/, '');
        if (nameNoExt === BRAND_CLI_BIN) {
          return join(extractDir, entry.toString());
        }
      }
      if (entries.length === 1) {
        return join(extractDir, entries[0].toString());
      }
    }

    // Diagnostic: check if directory itself exists
    const dirExists = existsSync(extractDir);
    throw new Error(
      `Could not find ${BRAND_CLI_BIN} binary in extracted archive. ` +
        `Dir exists: ${dirExists}, files: [${entries.join(', ')}]`,
    );
  }

  /**
   * Cleanup old version binaries, keeping the most recent N versions.
   * Additionally, always preserves the SAFE_ROLLBACK_VERSION (imported at Phase 3).
   *
   * Aligned with Go `CleanupOldVersions()`.
   */
  async function cleanupOldVersions(
    binDir: string,
    keep: number,
    activeVersion?: string,
    previousVersion?: string,
  ): Promise<void> {
    try {
      const entries = await readdir(binDir);
      const prefix = `${BRAND_CLI_BIN}-`;

      // Filter for versioned binaries
      const versionFiles: Array<{
        name: string;
        path: string;
        version: string;
      }> = [];

      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const fullPath = join(binDir, entry);
        const version = parseVersionFromFilename(entry);
        if (!version) continue;
        try {
          const s = await stat(fullPath);
          if (s.isFile()) {
            versionFiles.push({ name: entry, path: fullPath, version });
          }
        } catch {
          // skip unreadable entries
        }
      }

      // Sort by semantic version, newest first (not mtime which can be unreliable
      // when files are copied or restored from backup).
      versionFiles.sort((a, b) => compareVersions(b.version, a.version));

      // Remove beyond keep count, but never remove the active version that
      // the symlink currently points to — it may sort lower than expected
      // when a nightly/prerelease is installed over a higher-numbered beta.
      const toRemove = versionFiles
        .slice(keep)
        .filter(
          (f) => f.version !== activeVersion && f.version !== previousVersion,
        );
      for (const file of toRemove) {
        try {
          await unlink(file.path);
          runLogger.debug(`[BinaryUpdater] Removed old version: ${file.name}`);
        } catch {
          // best-effort cleanup
        }
      }

      // Also clean up Windows .old.* files
      if (process.platform === 'win32') {
        for (const entry of entries) {
          if (entry.includes('.old.')) {
            try {
              await unlink(join(binDir, entry));
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // Cleanup is best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-rollback helpers (aligned with Go cmd/install/install.go)
  // ---------------------------------------------------------------------------

  /**
   * Rollback to the most recent previous version by switching the symlink.
   * Sorts candidate binaries by version (descending) and picks the first
   * one that isn't the failed version.
   *
   * Aligned with Go `rollbackToPreviousVersion()`.
   */
  async function rollbackToPreviousVersion(
    binDir: string,
    linkPath: string,
    failedVersion: string,
  ): Promise<boolean> {
    try {
      const entries = await readdir(binDir);
      const prefix = `${BRAND_CLI_BIN}-`;

      const candidates: Array<{ version: string; path: string }> = [];
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const version = parseVersionFromFilename(entry);
        if (!version || version === failedVersion) continue;
        const fullPath = join(binDir, entry);
        const s = await stat(fullPath);
        if (s.isFile()) {
          candidates.push({ version, path: fullPath });
        }
      }

      if (candidates.length === 0) {
        runLogger.debug(
          '[BinaryUpdater] No previous version available for rollback',
        );
        return false;
      }

      // Sort by version descending, pick newest
      candidates.sort((a, b) => compareVersions(b.version, a.version));
      const best = candidates[0];

      runLogger.debug(`[BinaryUpdater] Rolling back to ${best.version}`);
      await updateLink(best.path, linkPath);
      return true;
    } catch (err) {
      runLogger.debug(
        `[BinaryUpdater] Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine archive extension from URL.
   */
  function getArchiveExtension(url: string): string {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith('.tar.gz')) return '.tar.gz';
    if (lowerUrl.endsWith('.tgz')) return '.tgz';
    if (lowerUrl.endsWith('.zip')) return '.zip';
    // Default to .tar.gz for unknown extensions
    return extname(url) || '.tar.gz';
  }

  /**
   * Ensure all required directories exist.
   */
  async function ensureDirectories(): Promise<void> {
    await mkdir(BIN_DIR, { recursive: true });
    // Ensure symlink parent directory exists
    const linkParent = join(LINK_PATH, '..');
    await mkdir(linkParent, { recursive: true });
  }

  /**
   * Cleanup temporary download/extract files.
   */
  async function cleanupTemp(...paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        await rm(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Parse version from a versioned binary filename.
   * e.g. "qwen-0.2.0" → "0.2.0"
   */
  function parseVersionFromFilename(filename: string): string | null {
    const prefix = `${BRAND_CLI_BIN}-`;
    const name = basename(filename).replace(/\.(exe|bin)$/, '');
    if (!name.startsWith(prefix)) return null;
    return name.slice(prefix.length);
  }

  /**
   * Get the version that the current symlink/binary points to.
   */
  async function getActiveLinkedVersion(): Promise<string | null> {
    try {
      const target = await readlink(LINK_PATH);
      return parseVersionFromFilename(target);
    } catch {
      return null;
    }
  }

  async function getActiveVersion(): Promise<string | undefined> {
    try {
      const entry = await lstat(LINK_PATH);
      if (entry.isSymbolicLink()) {
        const target = await realpath(LINK_PATH);
        if (dirname(target) === (await realpath(BIN_DIR)))
          return parseVersionFromFilename(target) ?? undefined;
      } else if (entry.isFile()) {
        // The entry can be a copy, so its filename carries no version.
        const { stdout } = await execFileAsync(LINK_PATH, ['--version'], {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        });
        return stdout.trim() || undefined;
      }
    } catch {
      // An unreadable entry cannot establish rollback history.
    }
    return undefined;
  }

  async function findLocalVersion(targetVersion: string): Promise<string | null> {
    try {
      if (!existsSync(BIN_DIR)) return null;
      for (const entry of await readdir(BIN_DIR)) {
        if (parseVersionFromFilename(entry) !== targetVersion) continue;
        const path = join(BIN_DIR, entry);
        if ((await stat(path)).isFile()) return path;
      }
    } catch { /* unavailable local version falls back to the selected artifact */ }
    return null;
  }

  return {
    findLocalVersion,
    installVersionBinary,
    updateLink,
    extractArchive,
    cleanupOldVersions,
    rollbackToPreviousVersion,
    getArchiveExtension,
    cleanupTemp,
    parseVersionFromFilename,
    getActiveLinkedVersion,
    getActiveVersion,
    writeLocalVersion,
    ensureDirectories,
    copyInstallMarker,
  };
}
