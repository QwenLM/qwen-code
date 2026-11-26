/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Critical files that must exist for a complete Portable Git installation.
 * If any file is missing after extraction, the installation is considered
 * incomplete or corrupt.
 *
 * Exported so that both gitBashPreparer and the shell detection logic
 * (findPreparedGitPath) can share the same validation list.
 */
export const CRITICAL_GIT_FILES = [
  'bin/bash.exe',
  'usr/bin/msys-2.0.dll',
  'usr/bin/msys-intl-8.dll',
  'cmd/git.exe',
] as const;

/**
 * Well-known absolute paths to bash.exe in standard Git for Windows
 * installations. Shared between `hasSystemShell()` (download suppression)
 * and `resolveGitBashPathFromSystem()` (shell resolution).
 */
export const WELL_KNOWN_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
] as const;

/** Metadata describing a prepared environment component. */
export interface PrepEnvironment {
  /** Component identifier (e.g. "git-bash", "7zr") */
  name: string;
  /** Version string (e.g. "2.52.0") */
  version: string;
  /** Human-readable description */
  description: string;
  /** Target platform (e.g. "windows") */
  platform: string;
  /** Target architecture (e.g. "amd64") */
  arch: string;
  /** Root installation directory */
  installPath: string;
  /** Path to the primary executable */
  binaryPath: string;
}

/**
 * Interface for environment preparers.
 *
 * Each preparer is responsible for one component (e.g. 7zr.exe, Git Bash).
 * The PrepareManager calls preparers in registration order, so dependencies
 * must be registered first (7zr before git-bash).
 */
export interface EnvironmentPreparer {
  /** Returns the component name used for locking and logging. */
  name(): string;

  /** Whether this component is needed on the current system. */
  isRequired(signal?: AbortSignal): boolean | Promise<boolean>;

  /** Whether the component is already installed and valid. */
  isInstalled(): boolean;

  /** Download and install the component. May throw on failure. */
  prepare(signal?: AbortSignal): Promise<void>;

  /** Returns metadata about this component. */
  getEnvironment(): PrepEnvironment;
}

/** Download sources supplied by an application, defaulting to Qwen OSS. */
export interface WindowsEnvironmentUrls {
  gitBashPrimaryUrl: string;
  gitBashFallbackUrl: string;
  sevenZrPrimaryUrl: string;
  sevenZrFallbackUrl: string;
}
