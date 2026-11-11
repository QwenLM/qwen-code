/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for the `qwen install` self-installation subsystem.
 */

// ---------------------------------------------------------------------------
// Command options
// ---------------------------------------------------------------------------

/**
 * Parsed CLI flags for `qwen install`.
 */
export interface InstallOptions {
  /** Overwrite existing installation without version check */
  force: boolean;
  /** Suppress non-error output (for script invocation) */
  quiet: boolean;
  /** Skip PATH configuration */
  skipPath: boolean;
  /** Compatibility no-op retained for older install scripts */
  skipVerify: boolean;
  /** Target version to install (defaults to latest from manifest) */
  version?: string;
}

// ---------------------------------------------------------------------------
// System information
// ---------------------------------------------------------------------------

/**
 * Comprehensive system/environment information collected during installation.
 * Used for install diagnostics and troubleshooting.
 */
export interface SystemInfo {
  /** Operating system: darwin | linux | win32 */
  os: string;
  /** OS version: e.g. "14.2" (macOS), "22.04" (Ubuntu), "10.0.22631" (Win11) */
  osVersion: string;
  /** CPU architecture: arm64 | x64 */
  arch: string;
  /** Whether AVX2 instruction set is available when the platform probe supports it. */
  hasAvx2: boolean;
  /** Number of logical CPU cores */
  cpuCores: number;
  /** Total system memory in MB */
  totalMemMb: number;
  /** Detected shell: bash | zsh | fish | sh | powershell | cmd */
  shell: string;
  /** Terminal emulator program if detectable */
  termProgram?: string;
  /** Running under Rosetta 2 translation (macOS x64 on ARM) */
  isRosetta: boolean;
  /** Running inside Windows Subsystem for Linux */
  isWsl: boolean;
  /** Running inside a Docker/container environment */
  isDocker: boolean;
  /** Running in a CI/CD environment */
  isCi: boolean;
  /** Running over SSH */
  isSsh: boolean;
  /** Running as root/administrator */
  isRoot: boolean;
  /** System locale (e.g. "en_US.UTF-8") */
  locale?: string;
  /** Timezone (e.g. "Asia/Shanghai") */
  timezone?: string;
  /** Whether a previous qwen binary exists */
  hasExistingBinary: boolean;
  /** Version of previously installed binary if any */
  existingVersion?: string;
  /** Whether using musl libc (Alpine/container environments) */
  isMusl: boolean;
  /** Available disk space in MB on the target volume */
  diskSpaceMb?: number;
  /** Node.js version (e.g. "22.0.0") */
  nodeVersion?: string;
  /** Bun version if running under Bun */
  bunVersion?: string;
}

// ---------------------------------------------------------------------------
// PATH configuration result
// ---------------------------------------------------------------------------

/**
 * Result of attempting to configure the system PATH.
 */
export interface PathConfigResult {
  /** Whether the PATH was actually modified */
  modified: boolean;
  /** Reason PATH modification was skipped (if not modified) */
  skipReason?:
    | 'runtime_path_exists'
    | 'rc_file_configured'
    | 'user_skip'
    | 'error';
  /** Detected user shell */
  detectedShell: string;
  /** Configuration file that was modified (if any) */
  configFile?: string;
  /** Method used: RC file append (Unix) or Registry (Windows) */
  method?: 'rc_append' | 'registry';
  /** Error message if modification failed */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Install step tracking
// ---------------------------------------------------------------------------

/**
 * Each discrete step in the installation flow, used for step-timing and
 * error-stage attribution.
 */
export type InstallStep =
  | 'resolve_dirs'
  | 'acquire_lock'
  | 'collect_system_info'
  | 'fetch_manifest'
  | 'pick_platform'
  | 'download_archive'
  | 'verify_checksum'
  | 'extract_archive'
  | 'detect_current_version'
  | 'check_already_installed'
  | 'install_versioned_binary'
  | 'write_marker'
  | 'create_entry_point'
  | 'install_dispatcher'
  | 'configure_path'
  | 'cleanup_old_versions'
  | 'cleanup_stale_files'
  | 'cleanup_temp_downloads'
  | 'print_result';

/**
 * What an install did relative to the versioned binaries already in the
 * install dir: `noop` when the target was installed and the run only relinked.
 */
export type InstallPathKind =
  | 'noop'
  | 'fresh'
  | 'upgrade'
  | 'downgrade'
  | 'reinstall';

// ---------------------------------------------------------------------------
// Error classification (avoids raw error strings / PII)
// ---------------------------------------------------------------------------

/**
 * Categorized error types.
 * Used instead of raw error messages to prevent PII leakage and enable
 * structured analysis.
 */
export type InstallErrorCategory =
  | 'network'
  | 'checksum'
  | 'permission'
  | 'timeout'
  | 'disk_space'
  | 'extract'
  | 'lock_conflict'
  | 'platform_unsupported'
  | 'unknown';

/**
 * Classify an error into a safe category.
 * Inspects error codes and message patterns — never exposes raw strings.
 */
export function classifyError(err: unknown): InstallErrorCategory {
  if (!(err instanceof Error)) return 'unknown';

  const msg = err.message.toLowerCase();
  // Child-process errors (execSync/spawn) carry a numeric exit status as
  // `code`; only string codes participate in errno-style classification.
  const rawCode = (err as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? rawCode.toLowerCase() : undefined;

  // Permission errors
  if (
    code === 'eacces' ||
    code === 'eperm' ||
    msg.includes('permission denied')
  ) {
    return 'permission';
  }

  // Disk space errors
  if (
    code === 'enospc' ||
    msg.includes('no space') ||
    msg.includes('disk full')
  ) {
    return 'disk_space';
  }

  // Network / download errors
  if (
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'etimedout' ||
    code === 'epipe' ||
    code === 'enotfound' ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('download failed') ||
    msg.includes('download stalled') ||
    msg.includes('manifest fetch failed')
  ) {
    return 'network';
  }

  // Timeout (non-network)
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    code === 'abort_err'
  ) {
    return 'timeout';
  }

  // Checksum mismatch
  if (
    msg.includes('sha256') ||
    msg.includes('checksum') ||
    msg.includes('hash mismatch')
  ) {
    return 'checksum';
  }

  // Extraction failures
  if (
    msg.includes('extract') ||
    msg.includes('tar') ||
    msg.includes('unzip') ||
    msg.includes('archive')
  ) {
    return 'extract';
  }

  // Lock conflicts
  if (
    msg.includes('another update process') ||
    msg.includes('lock') ||
    code === 'eexist'
  ) {
    return 'lock_conflict';
  }

  // Platform unsupported
  if (
    msg.includes('no compatible binary') ||
    msg.includes('unsupported platform')
  ) {
    return 'platform_unsupported';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Error detail capture (message + code)
// ---------------------------------------------------------------------------

/** Max reported length of an install error message. */
export const INSTALL_ERROR_MESSAGE_MAX_LENGTH = 512;

export interface InstallErrorInfo {
  /**
   * Truncated raw error message, paired with errorCode so consumers that
   * spread `...extractErrorInfo(err)` keep both fields: returning
   * {message, code} here silently dropped both (object-spread bypasses
   * excess-property checks).
   */
  errorMessage?: string;
  /** Node/system error code (e.g. EACCES, UNABLE_TO_VERIFY_LEAF_SIGNATURE) */
  errorCode?: string;
}

/**
 * Extract safe error detail from an unknown thrown value.
 * The `code` is an enum-like identifier and never carries user data; the
 * message is truncated to bound payload size.
 */
export function extractErrorInfo(err: unknown): InstallErrorInfo {
  if (!(err instanceof Error)) {
    return {};
  }
  const code = (err as NodeJS.ErrnoException).code;
  return {
    errorMessage: err.message
      ? err.message.slice(0, INSTALL_ERROR_MESSAGE_MAX_LENGTH)
      : undefined,
    errorCode: typeof code === 'string' && code ? code : undefined,
  };
}
