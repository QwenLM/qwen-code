/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ideContextStore, Storage } from '@qwen-code/qwen-code-core';
import { findEnvFiles, preResolveHomeEnvOverrides } from './environment.js';
import {
  getSystemDefaultsPath,
  getSystemSettingsPath,
  getUserSettingsPath,
  loadSettings,
} from './settings.js';
import type { LoadedSettings } from './settings.js';

/**
 * Process-level cache for `loadSettings()`, keyed by workspace directory.
 *
 * The ACP child under `qwen serve` is long-lived and serves many sessions
 * (often for the same cwd). A full `loadSettings()` runs on the shared event
 * loop for every `session/new` / `session/load`: four settings files read,
 * parsed, migration-checked and structuredClone'd, the `.env` tree walked,
 * home `.env` re-read, `${VAR}` references re-resolved, and all scopes merged.
 * This wrapper serves a previously loaded `LoadedSettings` instance while a
 * stat-based fingerprint of every filesystem input is unchanged.
 *
 * A cache hit still costs ~4 `statSync` + the `.env` discovery walk
 * (`existsSync` per directory level) + 1-2 `realpathSync` — deliberately so:
 * invalidation is deterministic (change a file, next call sees it) rather
 * than time-based. It just skips the much larger read/parse/clone/merge work.
 *
 * Known, accepted differences vs. calling `loadSettings()` every time:
 * 1. Mutating `process.env` directly (no file change) does not re-resolve
 *    `${VAR}` references baked into cached settings values.
 * 2. A `.env` file modified *while* the miss-path `loadSettings()` is running
 *    (and never again afterwards) can be served stale — the microsecond
 *    TOCTOU window shared by every mtime-based cache.
 * 3. An in-place overwrite preserving mtime, size *and* inode is invisible.
 *    Self-writes (`LoadedSettings.setValue`) go through temp-file + rename,
 *    which changes the inode; on filesystems reporting `ino` as 0 (some
 *    Windows setups) this degrades to mtime+size detection, same as tsc's
 *    incremental cache.
 */

const MAX_CACHE_ENTRIES = 64;

interface FileSig {
  filePath: string;
  sig: string;
}

interface CacheFingerprint {
  settingsFiles: FileSig[];
  envFiles: FileSig[];
  ideTrust: boolean | undefined;
  realCwd: string;
  homeDir: string;
}

interface CacheEntry {
  settings: LoadedSettings;
  fingerprint: CacheFingerprint;
}

const cache = new Map<string, CacheEntry>();

function statSig(filePath: string): string {
  const st = fs.statSync(filePath, { throwIfNoEntry: false });
  return st ? `${st.mtimeMs}:${st.size}:${st.ino}` : 'missing';
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Match loadSettings(): fall back to the resolved path.
    return path.resolve(p);
  }
}

/**
 * Paths are recomputed on every call (not stored once): they depend on
 * QWEN_HOME / HOME and the test-only system-path overrides, so a changed
 * environment shows up as a path mismatch and invalidates the entry.
 */
function settingsFileSigs(workspaceDir: string): FileSig[] {
  const filePaths = [
    getSystemSettingsPath(),
    getSystemDefaultsPath(),
    getUserSettingsPath(),
    new Storage(workspaceDir).getWorkspaceSettingsPath(),
  ];
  return filePaths.map((filePath) => ({ filePath, sig: statSig(filePath) }));
}

/**
 * Re-runs `.env` discovery and signs the result. Discovery only returns
 * files that exist, so a new `.env` appearing closer to the workspace (or a
 * discovered one disappearing) changes the path list itself, while edits to
 * a discovered file change its signature. Trust changes that would alter
 * discovery are covered by the settingsFiles / ideTrust components.
 */
function envFileSigs(
  settings: LoadedSettings,
  workspaceDir: string,
): FileSig[] {
  return findEnvFiles(settings.merged, workspaceDir).map((filePath) => ({
    filePath,
    sig: statSig(filePath),
  }));
}

function sameFileSigs(a: FileSig[], b: FileSig[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every(
    (sig, i) => sig.filePath === b[i]!.filePath && sig.sig === b[i]!.sig,
  );
}

function isEntryFresh(key: string, entry: CacheEntry): boolean {
  const fp = entry.fingerprint;
  return (
    ideContextStore.get()?.workspaceState?.isTrusted === fp.ideTrust &&
    realpathOr(key) === fp.realCwd &&
    // homeDir guards the corner where nothing else moves: QWEN_HOME set (so
    // settings paths don't follow HOME), no .env files anywhere, and the new
    // home equals the workspace dir — which flips workspaceSettingsActive.
    realpathOr(os.homedir()) === fp.homeDir &&
    sameFileSigs(settingsFileSigs(key), fp.settingsFiles) &&
    sameFileSigs(envFileSigs(entry.settings, key), fp.envFiles)
  );
}

/**
 * Drop-in replacement for `loadSettings(workspaceDir)` on hot paths that use
 * its default options. Callers needing `LoadSettingsOptions` must keep using
 * `loadSettings()` directly.
 */
export function loadSettingsCached(workspaceDir: string): LoadedSettings {
  // Idempotent process-level latch (loadSettings runs it internally too);
  // running it up front makes the QWEN_HOME-derived paths below stable from
  // the very first call instead of only after the first miss.
  preResolveHomeEnvOverrides();
  const key = path.resolve(workspaceDir);

  const entry = cache.get(key);
  if (entry) {
    let isFresh = false;
    try {
      isFresh = isEntryFresh(key, entry);
    } catch {
      // Fail open: any unexpected fingerprint error (EACCES, EIO, ...) is
      // treated as a miss so the cache never becomes a new failure source.
    }
    if (isFresh) {
      // Refresh LRU position (Map preserves insertion order).
      cache.delete(key);
      cache.set(key, entry);
      return entry.settings;
    }
    cache.delete(key);
  }

  // Sign the settings files BEFORE loading: if one changes while
  // loadSettings() runs, the stored signature is already stale and the next
  // call reloads. Conservative — may reload once too often, never serves
  // stale data.
  let preLoadSigs: FileSig[] | undefined;
  try {
    preLoadSigs = settingsFileSigs(key);
  } catch {
    // Fail open: cache nothing this round.
  }

  // Load errors (FatalConfigError etc.) propagate unchanged and uncached;
  // the stale entry was already dropped above.
  const settings = loadSettings(key);

  if (preLoadSigs) {
    try {
      cache.set(key, {
        settings,
        fingerprint: {
          settingsFiles: preLoadSigs,
          // .env discovery needs the merged settings (trust), so it can only
          // be signed after the load — see difference (2) in the module doc.
          envFiles: envFileSigs(settings, key),
          ideTrust: ideContextStore.get()?.workspaceState?.isTrusted,
          realCwd: realpathOr(key),
          homeDir: realpathOr(os.homedir()),
        },
      });
      if (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
    } catch {
      // Fail open: serve the freshly loaded settings uncached.
      cache.delete(key);
    }
  }

  return settings;
}

export function clearSettingsCacheForTesting(): void {
  cache.clear();
}
