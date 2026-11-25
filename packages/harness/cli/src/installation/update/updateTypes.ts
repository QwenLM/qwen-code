/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Update subsystem type definitions.
 *
 * Aligned with Go source: cmd/update/common.go (ManifestJSON, UpdateInfo, lockInfo)
 */

// ---------------------------------------------------------------------------
// Manifest (CDN/OSS release metadata)
// ---------------------------------------------------------------------------

/**
 * Release manifest served from CDN/OSS.
 * Aligned with Go `ManifestJSON` struct.
 *
 * URL pattern: `{baseURL}/channels/manifest.json` (latest)
 *              `{baseURL}/channels/{version}/manifest.json` (specific version)
 */
export interface ManifestJSON {
  /** Latest available version */
  latest: string;
  /** Publish timestamp (ISO 8601) */
  published_at: string;
  /** Per-platform binary files */
  files: ManifestFile[];
  /** Versions available for rollback (server-populated) */
  rollback_versions?: string[];
}

export type BinaryRuntime = 'bun' | 'node-sea';

/**
 * A single platform binary entry in the manifest.
 */
export interface ManifestFile {
  /** Target OS: "darwin" | "linux" | "windows" */
  os: string;
  /** Target arch: "arm64" | "x64" | "x64-musl" | "arm64-musl" */
  arch: string;
  /** Binary runtime, e.g. "bun" or "node-sea". */
  runtime?: BinaryRuntime;
  /** Optional distribution variant, e.g. "standard" or "legacy". */
  variant?: string;
  /** Minimum supported Windows build number, e.g. 17763 for Windows 10 1809. */
  min_windows_build?: number;
  /** Maximum supported Windows build number. */
  max_windows_build?: number;
  /** Download URL */
  url: string;
  /** Expected SHA256 hex digest */
  sha256: string;
}

// ---------------------------------------------------------------------------
// Update check result
// ---------------------------------------------------------------------------

/**
 * Result of checking for a binary update.
 * Aligned with Go `UpdateInfo` struct.
 */
export interface BinaryUpdateInfo {
  /** Whether a newer version is available */
  available: boolean;
  /** Currently running version */
  currentVersion: string;
  /** Latest version from manifest */
  latestVersion: string;
  /** Matching file for the current OS/Arch (undefined if no match) */
  file?: ManifestFile;
}

// ---------------------------------------------------------------------------
// File lock
// ---------------------------------------------------------------------------

/**
 * JSON content of the update lock in the selected user data directory.
 * Aligned with Go `lockInfo` struct.
 */
export interface LockInfo {
  /** PID of the process holding the lock */
  pid: number;
  /** Lock acquisition time (ISO 8601) */
  timestamp: string;
  /** Hostname of the machine holding the lock */
  hostname: string;
}

// ---------------------------------------------------------------------------
// Version management
// ---------------------------------------------------------------------------

/** A locally installed version entry */
export interface VersionEntry {
  /** Semver version string */
  version: string;
  /** Absolute path to the binary */
  binaryPath: string;
  /** When this version was installed */
  installedAt: Date;
  /** Binary file size in bytes */
  size: number;
}

/** Persistent version change history in the selected user data directory. */
export interface VersionHistory {
  /** Ordered list of version changes (newest first) */
  entries: VersionHistoryEntry[];
  /** Currently active version */
  currentVersion: string;
  /** The hardcoded safe rollback version */
  safeRollbackVersion: string;
}

export interface VersionHistoryEntry {
  /** Target version */
  version: string;
  /** When the change occurred (ISO 8601) */
  installedAt: string;
  /** Previous version before this change */
  fromVersion: string;
  /** What triggered this change */
  action: 'upgrade' | 'rollback' | 'install';
}

// ---------------------------------------------------------------------------
// Update trigger
// ---------------------------------------------------------------------------

/** How the update was triggered */
export type UpdateType = 'manual' | 'auto' | 'rollback';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lock file timeout: 1 minute (aligned with Go LOCK_TIMEOUT) */
export const LOCK_TIMEOUT_MS = 60_000;

/** Stale lock threshold: treat unparseable lock files older than this as stale */
export const LOCK_STALE_THRESHOLD_MS = 30_000;

/** Auto-update delay after CLI startup: 8 seconds */
export const AUTO_UPDATE_DELAY_MS = 8_000;

/** Maximum versions to keep locally (excluding safe rollback version) */
export const MAX_KEPT_VERSIONS = 3;

/** Manifest fetch timeout */
export const MANIFEST_FETCH_TIMEOUT_MS = 20_000;

/** File download timeout: 5 minutes */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Auto-update pause duration after rollback: 24 hours */
export const AUTO_UPDATE_PAUSE_DURATION_MS = 24 * 3600_000;

/** Download stall timeout: abort if no data received for 60 seconds */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

/** Maximum number of download retry attempts */
export const DOWNLOAD_MAX_RETRIES = 3;

/** Remote latest version file (plain text, no 'v' prefix) */
export const LATEST_VERSION_FILENAME = 'latest.txt';

/** Local installed version file (plain text, no 'v' prefix) */
export const LOCAL_VERSION_FILENAME = 'version.txt';
