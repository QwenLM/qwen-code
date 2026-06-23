/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as dotenv from 'dotenv';
import { getErrorMessage, QWEN_DIR, Storage } from '@qwen-code/qwen-code-core';
import { isWorkspaceTrusted } from './trustedFolders.js';
import {
  DEFAULT_EXCLUDED_ENV_VARS,
  HOME_ENV_BOOTSTRAP_KEYS,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
} from './shared-env-keys.js';
export {
  DEFAULT_EXCLUDED_ENV_VARS,
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
} from './shared-env-keys.js';
import type { Settings } from './settingsSchema.js';

export const SETTINGS_DIRECTORY_NAME = QWEN_DIR;

const RELOAD_EXCLUDED_KEYS = new Set([
  ...PROJECT_ENV_HARDCODED_EXCLUSIONS,
  'QWEN_SERVER_TOKEN',
  'QWEN_CLI_ENTRY',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
]);

const dotEnvSourcedKeys = new Set<string>();
const settingsEnvSourcedKeys = new Set<string>();
const lastReloadSnapshot = new Map<string, string>();
let lastReloadSnapshotSeeded = false;

/**
 * Returns the set of normalized .env file paths that count as user-level.
 *
 * User-level paths cover the home `.env` and the global Qwen config dir
 * `.env` (which respects `QWEN_HOME`). When `QWEN_HOME` redirects elsewhere,
 * the legacy `<homedir>/.qwen/.env` is also included so credentials users
 * left there continue to load (and the trust check in untrusted workspaces
 * still allows reading it).
 */
function getUserLevelEnvPaths(): Set<string> {
  const homeDir = os.homedir();
  const globalQwenDir = Storage.getGlobalQwenDir();
  const paths = new Set([
    path.normalize(path.join(homeDir, '.env')),
    path.normalize(path.join(globalQwenDir, '.env')),
  ]);
  const legacyQwenEnv = path.normalize(path.join(homeDir, QWEN_DIR, '.env'));
  paths.add(legacyQwenEnv);
  return paths;
}

/**
 * Pre-resolves QWEN_HOME and QWEN_RUNTIME_DIR from user-level `.env` files
 * before any settings or storage paths are read. Required because
 * module-load `Storage.getGlobalQwenDir()` would otherwise snapshot legacy
 * paths for settings.json, OAuth tokens, installation_id, etc., while the
 * regular `.env` load only runs later — splitting global state between
 * `~/.qwen/...` and `<QWEN_HOME>/...`.
 */
let homeEnvBootstrapped = false;
export function preResolveHomeEnvOverrides(): void {
  if (homeEnvBootstrapped) {
    return;
  }
  homeEnvBootstrapped = true;

  if (HOME_ENV_BOOTSTRAP_KEYS.every((key) => process.env[key])) {
    return;
  }

  // Storage.getGlobalQwenDir() shares the same homedir resolution as the
  // rest of the storage layer; when QWEN_HOME is unset it equals
  // `<homedir>/.qwen`, so path.dirname() recovers `<homedir>`.
  const initialQwenHome = process.env['QWEN_HOME'];
  const initialQwenDir = Storage.getGlobalQwenDir();
  const candidates: string[] = [path.join(initialQwenDir, '.env')];
  if (!initialQwenHome) {
    candidates.push(path.join(path.dirname(initialQwenDir), '.env'));
  }

  for (const candidate of candidates) {
    readHomeEnvInto(candidate);
  }

  // If QWEN_HOME was just discovered, also read <new QWEN_HOME>/.env so
  // QWEN_RUNTIME_DIR can be sourced from there.
  const discoveredQwenHome = process.env['QWEN_HOME'];
  if (discoveredQwenHome && discoveredQwenHome !== initialQwenHome) {
    const discoveredDir = Storage.getGlobalQwenDir();
    if (discoveredDir !== initialQwenDir) {
      readHomeEnvInto(path.join(discoveredDir, '.env'));
    }
  }
}

function readHomeEnvInto(file: string): void {
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    const parsed = dotenv.parse(fs.readFileSync(file, 'utf-8'));
    for (const key of PROJECT_ENV_HARDCODED_EXCLUSIONS) {
      if (parsed[key] && !Object.hasOwn(process.env, key)) {
        process.env[key] = parsed[key];
      }
    }
  } catch (_e) {
    // Match the dotenv quiet-mode behavior used by loadEnvironment below.
  }
}

/** Test-only: reset the home-env bootstrap latch. */
export function resetHomeEnvBootstrapForTesting(): void {
  homeEnvBootstrapped = false;
}

/**
 * Collects environment variables from user-level `.env` files and returns
 * them as a plain dictionary **without** mutating `process.env`.
 *
 * Candidates are iterated most-specific-first (`~/.qwen/.env` before
 * `~/.env`). `??=` ensures the first file to define a key wins, matching
 * dotenv's first-occurrence-wins semantics used elsewhere.
 */
export function getHomeEnvFallbackVars(
  onReadError?: (message: string) => void,
): Record<string, string> {
  const globalQwenDir = Storage.getGlobalQwenDir();
  const candidates = [path.join(globalQwenDir, '.env')];
  // When QWEN_HOME is set, skip ~/.env to avoid surprise cross-contamination
  // from a shared home .env. getUserLevelEnvPaths() always includes ~/.env
  // because loadEnvironment() populates process.env independently — the two
  // scopes are intentionally different.
  if (!process.env['QWEN_HOME']) {
    candidates.push(path.join(path.dirname(globalQwenDir), '.env'));
  }

  const result: Record<string, string> = {};
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = dotenv.parse(fs.readFileSync(candidate, 'utf-8'));
      for (const key in parsed) {
        if (Object.hasOwn(parsed, key) && !Object.hasOwn(process.env, key)) {
          result[key] ??= parsed[key]!;
        }
      }
    } catch (e) {
      onReadError?.(
        `Failed to read home .env candidate ${candidate}: ${getErrorMessage(e)}`,
      );
    }
  }
  return result;
}

/**
 * Finds the .env file to load, respecting workspace trust settings.
 *
 * When workspace is untrusted, only allow user-level .env files at:
 * - ~/.qwen/.env
 * - ~/.env
 * - <QWEN_HOME>/.env (when set)
 */
function findEnvFile(
  settings: Settings,
  startDir: string,
  userLevelPaths: Set<string> = getUserLevelEnvPaths(),
): string | null {
  const homeDir = os.homedir();
  let realStartDir = path.resolve(startDir);
  try {
    realStartDir = fs.realpathSync(realStartDir);
  } catch {
    // Match loadSettings(): use the resolved path when realpath is unavailable.
  }
  const isTrusted = isWorkspaceTrusted(
    settings,
    undefined,
    realStartDir,
  ).isTrusted;

  const globalQwenDir = Storage.getGlobalQwenDir();
  const legacyQwenDir = path.normalize(path.join(homeDir, QWEN_DIR));
  const hasCustomConfigDir = path.normalize(globalQwenDir) !== legacyQwenDir;

  const canUseEnvFile = (filePath: string): boolean =>
    isTrusted !== false || userLevelPaths.has(path.normalize(filePath));

  // Home-dir candidates in priority order: globalQwenDir/.env, then legacy
  // ~/.qwen/.env (only when QWEN_HOME redirects), then ~/.env.
  const findHomeCandidate = (): string | null => {
    const candidates = [path.join(globalQwenDir, '.env')];
    if (hasCustomConfigDir) {
      candidates.push(path.join(legacyQwenDir, '.env'));
    }
    candidates.push(path.join(homeDir, '.env'));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && canUseEnvFile(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  let currentDir = realStartDir;
  let visitedHomeDir = false;
  while (true) {
    if (currentDir === homeDir) {
      visitedHomeDir = true;
      const found = findHomeCandidate();
      if (found) return found;
    } else {
      // Workspace step: prefer .qwen/.env, then plain .env.
      const geminiEnvPath = path.join(currentDir, QWEN_DIR, '.env');
      if (fs.existsSync(geminiEnvPath) && canUseEnvFile(geminiEnvPath)) {
        return geminiEnvPath;
      }
      const envPath = path.join(currentDir, '.env');
      if (fs.existsSync(envPath) && canUseEnvFile(envPath)) {
        return envPath;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      return visitedHomeDir ? null : findHomeCandidate();
    }
    currentDir = parentDir;
  }
}

export function setUpCloudShellEnvironment(envFilePath: string | null): void {
  // Special handling for GOOGLE_CLOUD_PROJECT in Cloud Shell:
  // Because GOOGLE_CLOUD_PROJECT in Cloud Shell tracks the project
  // set by the user using "gcloud config set project" we do not want to
  // use its value. So, unless the user overrides GOOGLE_CLOUD_PROJECT in
  // one of the .env files, we set the Cloud Shell-specific default here.
  if (envFilePath && fs.existsSync(envFilePath)) {
    const envFileContent = fs.readFileSync(envFilePath);
    const parsedEnv = dotenv.parse(envFileContent);
    if (parsedEnv['GOOGLE_CLOUD_PROJECT']) {
      // .env file takes precedence in Cloud Shell
      process.env['GOOGLE_CLOUD_PROJECT'] = parsedEnv['GOOGLE_CLOUD_PROJECT'];
    } else {
      // If not in .env, set to default and override global
      process.env['GOOGLE_CLOUD_PROJECT'] = 'cloudshell-gca';
    }
  } else {
    // If no .env file, set to default and override global
    process.env['GOOGLE_CLOUD_PROJECT'] = 'cloudshell-gca';
  }
}

/**
 * Loads environment variables from .env files and settings.env.
 *
 * Priority order (highest to lowest):
 * 1. CLI flags
 * 2. process.env (system/export/inline environment variables)
 * 3. .env files (no-override mode)
 * 4. settings.env (no-override mode)
 * 5. defaults
 */
export function loadEnvironment(
  settings: Settings,
  startDir: string = process.cwd(),
): void {
  const userLevelPaths = getUserLevelEnvPaths();
  const envFilePath = findEnvFile(settings, startDir, userLevelPaths);

  // Cloud Shell environment variable handling
  if (process.env['CLOUD_SHELL'] === 'true') {
    setUpCloudShellEnvironment(envFilePath);
  }

  // Step 1: Load from .env files (higher priority than settings.env)
  // Only set if not already present in process.env (no-override mode)
  if (envFilePath) {
    try {
      const envFileContent = fs.readFileSync(envFilePath, 'utf-8');
      const parsedEnv = dotenv.parse(envFileContent);

      const excludedVars =
        settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
      const normalizedEnvFilePath = path.normalize(envFilePath);
      // homeScoped: `.env` lives under the user's home Qwen dir or `~/.env` —
      //   only these may set QWEN_HOME / QWEN_RUNTIME_DIR.
      // qwenScoped: any `.env` whose immediate parent is `.qwen` (including
      //   `<repo>/.qwen/.env`) — exempt from the user `excludedEnvVars` list.
      const isHomeScopedEnvFile = userLevelPaths.has(normalizedEnvFilePath);
      const isQwenScopedEnvFile =
        isHomeScopedEnvFile ||
        path.basename(path.dirname(normalizedEnvFilePath)) === QWEN_DIR;

      for (const key in parsedEnv) {
        if (Object.hasOwn(parsedEnv, key)) {
          if (
            !isHomeScopedEnvFile &&
            PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)
          ) {
            continue;
          }
          if (!isQwenScopedEnvFile && excludedVars.includes(key)) {
            continue;
          }

          if (!Object.hasOwn(process.env, key)) {
            process.env[key] = parsedEnv[key];
            dotEnvSourcedKeys.add(key);
          }
          // Seed snapshot with ALL parsed keys (not just written ones)
          // so child processes can detect deletions on first reload.
          if (!lastReloadSnapshotSeeded) {
            lastReloadSnapshot.set(key, parsedEnv[key]!);
          }
        }
      }
    } catch (_e) {
      // Errors are ignored to match the behavior of `dotenv.config({ quiet: true })`.
    }
  }

  // Step 2: settings.env fallback (lowest priority, no-override).
  // Storage-routing vars must never come from settings.json — a workspace
  // settings.json could otherwise redirect global state after path bootstrap.
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)) {
        continue;
      }
      if (!Object.hasOwn(process.env, key) && typeof value === 'string') {
        process.env[key] = value;
        settingsEnvSourcedKeys.add(key);
      }
      if (
        !lastReloadSnapshotSeeded &&
        typeof value === 'string' &&
        !lastReloadSnapshot.has(key)
      ) {
        lastReloadSnapshot.set(key, value);
      }
    }
  }
  lastReloadSnapshotSeeded = true;
}

export interface EnvReloadResult {
  updatedKeys: string[];
  removedKeys: string[];
}

/**
 * Only keys previously set by loadEnvironment() are overwritten;
 * shell-exported variables are never touched.
 * Fully synchronous — no TOCTOU window between delete and re-add.
 */
export function reloadEnvironment(
  settings: Settings,
  workspaceCwd: string,
): EnvReloadResult {
  const userLevelPaths = getUserLevelEnvPaths();
  const envFilePath = findEnvFile(settings, workspaceCwd, userLevelPaths);

  if (process.env['CLOUD_SHELL'] === 'true') {
    setUpCloudShellEnvironment(envFilePath);
  }

  // Build the set of new keys from .env (higher priority) + settings.env
  let dotEnvReadFailed = false;
  const newDotEnvKeys = new Map<string, string>();
  const newSettingsEnvKeys = new Map<string, string>();

  if (envFilePath) {
    try {
      const envFileContent = fs.readFileSync(envFilePath, 'utf-8');
      const parsedEnv = dotenv.parse(envFileContent);
      const excludedVars =
        settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
      const normalizedEnvFilePath = path.normalize(envFilePath);
      const isHomeScopedEnvFile = userLevelPaths.has(normalizedEnvFilePath);
      const isQwenScopedEnvFile =
        isHomeScopedEnvFile ||
        path.basename(path.dirname(normalizedEnvFilePath)) === QWEN_DIR;

      for (const key in parsedEnv) {
        if (!Object.hasOwn(parsedEnv, key)) continue;
        if (RELOAD_EXCLUDED_KEYS.has(key)) continue;
        if (
          !isHomeScopedEnvFile &&
          PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)
        ) {
          continue;
        }
        if (!isQwenScopedEnvFile && excludedVars.includes(key)) continue;
        newDotEnvKeys.set(key, parsedEnv[key]!);
      }
    } catch {
      dotEnvReadFailed = true;
    }
  }

  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (RELOAD_EXCLUDED_KEYS.has(key)) continue;
      if (PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)) continue;
      if (typeof value !== 'string') continue;
      if (newDotEnvKeys.has(key)) continue;
      // When .env read failed, use the snapshot as the shadow set so
      // settings.env keys that were previously shadowed by .env don't
      // accidentally overwrite the still-live .env values in process.env.
      if (dotEnvReadFailed && lastReloadSnapshot.has(key)) continue;
      newSettingsEnvKeys.set(key, value);
    }
  }

  // Union of all new keys
  const allNewKeys = new Set([
    ...newDotEnvKeys.keys(),
    ...newSettingsEnvKeys.keys(),
  ]);

  const updatedKeys: string[] = [];
  const removedKeys: string[] = [];

  // Delete keys previously known (from tracking Sets OR the boot snapshot)
  // that are no longer in any source file. The snapshot covers keys that
  // ACP children inherited from the daemon without tracking.
  // Skip deletion entirely if the .env file became unreadable — treat as
  // transient I/O failure rather than intentional key removal.
  if (!dotEnvReadFailed) {
    const previouslyKnown = new Set([
      ...lastReloadSnapshot.keys(),
      ...dotEnvSourcedKeys,
      ...settingsEnvSourcedKeys,
    ]);
    for (const key of previouslyKnown) {
      if (!allNewKeys.has(key) && !RELOAD_EXCLUDED_KEYS.has(key)) {
        delete process.env[key];
        removedKeys.push(key);
      }
    }
  }

  // Force-write all source keys. RELOAD_EXCLUDED_KEYS are already filtered
  // at parse time so dangerous keys (PATH, HOME, etc.) never reach here.
  // This unconditional write is necessary because ACP children inherit
  // daemon env without tracking, so the tracking-based guard would miss them.
  for (const [key, value] of newDotEnvKeys) {
    if (process.env[key] !== value) {
      updatedKeys.push(key);
    }
    process.env[key] = value;
  }
  for (const [key, value] of newSettingsEnvKeys) {
    if (process.env[key] !== value) {
      updatedKeys.push(key);
    }
    process.env[key] = value;
  }

  // Update tracking sets and snapshot only when the .env file was readable.
  // A transient read failure must not wipe provenance — the stale tracking
  // state is needed so the next successful reload can still detect deletions.
  if (!dotEnvReadFailed) {
    dotEnvSourcedKeys.clear();
    for (const key of newDotEnvKeys.keys()) {
      dotEnvSourcedKeys.add(key);
    }
    lastReloadSnapshot.clear();
    for (const [key, value] of newDotEnvKeys) {
      lastReloadSnapshot.set(key, value);
    }
    for (const [key, value] of newSettingsEnvKeys) {
      lastReloadSnapshot.set(key, value);
    }
  }
  // settings.env is always readable (from settings.json, not a file),
  // so its tracking set is always updated.
  settingsEnvSourcedKeys.clear();
  for (const key of newSettingsEnvKeys.keys()) {
    settingsEnvSourcedKeys.add(key);
  }

  return { updatedKeys, removedKeys };
}
