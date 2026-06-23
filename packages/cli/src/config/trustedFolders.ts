/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  atomicWriteFileSync,
  FatalConfigError,
  getErrorMessage,
  isWithinRoot,
  ideContextStore,
  Storage,
} from '@qwen-code/qwen-code-core';
import type { Settings } from './settings.js';
import { parse, stringify } from 'comment-json';
import stripJsonComments from 'strip-json-comments';
import { applyUpdates } from '../utils/commentJson.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export const TRUSTED_FOLDERS_FILENAME = 'trustedFolders.json';

export function getTrustedFoldersPath(): string {
  if (process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH']) {
    return process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  }
  // Resolve lazily on every call: see settings.ts:getUserSettingsPath for why
  // a top-level const would be stale after `preResolveHomeEnvOverrides()`.
  return path.join(Storage.getGlobalQwenDir(), TRUSTED_FOLDERS_FILENAME);
}

export enum TrustLevel {
  TRUST_FOLDER = 'TRUST_FOLDER',
  TRUST_PARENT = 'TRUST_PARENT',
  DO_NOT_TRUST = 'DO_NOT_TRUST',
}

export interface TrustRule {
  path: string;
  trustLevel: TrustLevel;
}

export interface TrustedFoldersError {
  message: string;
  path: string;
}

export interface TrustedFoldersFile {
  config: Record<string, TrustLevel>;
  path: string;
}

export interface TrustResult {
  isTrusted: boolean | undefined;
  source: 'ide' | 'file' | undefined;
}

export class LoadedTrustedFolders {
  constructor(
    readonly user: TrustedFoldersFile,
    readonly errors: TrustedFoldersError[],
  ) {}

  get rules(): TrustRule[] {
    return Object.entries(this.user.config).map(([path, trustLevel]) => ({
      path,
      trustLevel,
    }));
  }

  /**
   * Returns true or false if the path should be "trusted". This function
   * should only be invoked when the folder trust setting is active.
   *
   * @param location path
   * @returns
   */
  isPathTrusted(location: string): boolean | undefined {
    const trustedPaths: string[] = [];
    const untrustedPaths: string[] = [];

    for (const rule of this.rules) {
      switch (rule.trustLevel) {
        case TrustLevel.TRUST_FOLDER:
          trustedPaths.push(rule.path);
          break;
        case TrustLevel.TRUST_PARENT:
          trustedPaths.push(path.dirname(rule.path));
          break;
        case TrustLevel.DO_NOT_TRUST:
          untrustedPaths.push(rule.path);
          break;
        default:
          // Do nothing for unknown trust levels.
          break;
      }
    }

    const locationVariants = getPathComparisonVariants(location);
    for (const trustedPath of trustedPaths) {
      for (const locationVariant of locationVariants) {
        for (const trustedVariant of getPathComparisonVariants(trustedPath)) {
          if (isWithinRoot(locationVariant, trustedVariant)) {
            return true;
          }
        }
      }
    }

    for (const untrustedPath of untrustedPaths) {
      for (const locationVariant of locationVariants) {
        for (const untrustedVariant of getPathComparisonVariants(
          untrustedPath,
        )) {
          if (locationVariant === untrustedVariant) {
            return false;
          }
        }
      }
    }

    return undefined;
  }

  setValue(path: string, trustLevel: TrustLevel): void {
    this.user.config[path] = trustLevel;
    saveTrustedFolders(this.user);
  }
}

function getPathComparisonVariants(rawPath: string): Set<string> {
  const variants = new Set<string>([path.normalize(path.resolve(rawPath))]);
  try {
    variants.add(path.normalize(fs.realpathSync(rawPath)));
  } catch {
    // Non-existent paths still compare by their resolved lexical form.
  }
  return variants;
}

function arePathsEquivalent(left: string, right: string): boolean {
  const rightVariants = getPathComparisonVariants(right);
  for (const leftVariant of getPathComparisonVariants(left)) {
    if (rightVariants.has(leftVariant)) {
      return true;
    }
  }
  return false;
}

let loadedTrustedFolders: LoadedTrustedFolders | undefined;

/**
 * FOR TESTING PURPOSES ONLY.
 * Resets the in-memory cache of the trusted folders configuration.
 */
export function resetTrustedFoldersForTesting(): void {
  loadedTrustedFolders = undefined;
}

export function loadTrustedFolders(): LoadedTrustedFolders {
  if (loadedTrustedFolders) {
    return loadedTrustedFolders;
  }

  const errors: TrustedFoldersError[] = [];
  let userConfig: Record<string, TrustLevel> = {};

  const userPath = getTrustedFoldersPath();

  // Load user trusted folders
  try {
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf-8');
      const parsed: unknown = JSON.parse(stripJsonComments(content));

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        errors.push({
          message: 'Trusted folders file is not a valid JSON object.',
          path: userPath,
        });
      } else {
        userConfig = parsed as Record<string, TrustLevel>;
      }
    }
  } catch (error: unknown) {
    errors.push({
      message: getErrorMessage(error),
      path: userPath,
    });
  }

  loadedTrustedFolders = new LoadedTrustedFolders(
    { path: userPath, config: userConfig },
    errors,
  );
  return loadedTrustedFolders;
}

export function saveTrustedFolders(
  trustedFoldersFile: TrustedFoldersFile,
): void {
  try {
    // Ensure the directory exists
    const dirPath = path.dirname(trustedFoldersFile.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    let content = stringify(trustedFoldersFile.config, null, 2);
    if (fs.existsSync(trustedFoldersFile.path)) {
      try {
        // Intentionally keep the comment-preserving round-trip local here
        // instead of reusing updateSettingsFilePreservingFormat(), because
        // trustedFolders.json must continue to use atomicWriteFileSync with
        // noFollow:true when it is finally written to disk.
        const originalContent = fs.readFileSync(
          trustedFoldersFile.path,
          'utf-8',
        );
        const parsed = parse(originalContent);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          parsed instanceof String ||
          parsed instanceof Number ||
          parsed instanceof Boolean
        ) {
          throw new Error('trusted folders file is not a JSON object');
        }
        const updated = applyUpdates(
          parsed as Record<string, unknown>,
          trustedFoldersFile.config as Record<string, unknown>,
          true,
        );
        const preservedContent = stringify(updated, null, 2);

        // Validate the serialized output before writing. If the round-trip
        // fails at any point, fall back to writing a clean normalized file so
        // a corrupted trustedFolders.json can still self-heal on save.
        parse(preservedContent);
        content = preservedContent;
      } catch (error) {
        // Fall back to a clean rewrite when comment-preserving round-trip fails.
        writeStderrLine(
          `Falling back to clean rewrite for trusted folders: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    atomicWriteFileSync(
      trustedFoldersFile.path,
      content,
      // noFollow: refuse to follow any pre-placed symlink at the
      // config path — a redirected write could either leak the
      // trusted-folder list to an attacker target or leave the user's
      // real config silently stale. Matches the credential write
      // sites' security posture (sharedTokenManager, oauth-token-storage,
      // file-token-storage all use noFollow:true).
      { encoding: 'utf-8', mode: 0o600, forceMode: true, noFollow: true },
    );
  } catch (error) {
    writeStderrLine('Error saving trusted folders file.');
    writeStderrLine(error instanceof Error ? error.message : String(error));
  }
}

/** Is folder trust feature enabled per the current applied settings */
export function isFolderTrustEnabled(settings: Settings): boolean {
  const folderTrustSetting = settings.security?.folderTrust?.enabled ?? false;
  return folderTrustSetting;
}

function getWorkspaceTrustFromLocalConfig(
  trustConfig?: Record<string, TrustLevel>,
  workspacePath: string = process.cwd(),
): TrustResult {
  const folders = loadTrustedFolders();

  if (trustConfig) {
    folders.user.config = trustConfig;
  }

  if (folders.errors.length > 0) {
    const errorMessages = folders.errors.map(
      (error) => `Error in ${error.path}: ${error.message}`,
    );
    throw new FatalConfigError(
      `${errorMessages.join('\n')}\nPlease fix the configuration file and try again.`,
    );
  }

  const isTrusted = folders.isPathTrusted(workspacePath);
  return {
    isTrusted,
    source: isTrusted !== undefined ? 'file' : undefined,
  };
}

export function isWorkspaceTrusted(
  settings: Settings,
  trustConfig?: Record<string, TrustLevel>,
  workspacePath?: string,
): TrustResult {
  if (!isFolderTrustEnabled(settings)) {
    return { isTrusted: true, source: undefined };
  }

  const ideTrust = ideContextStore.get()?.workspaceState?.isTrusted;
  if (
    ideTrust !== undefined &&
    (workspacePath === undefined ||
      arePathsEquivalent(workspacePath, process.cwd()))
  ) {
    return { isTrusted: ideTrust, source: 'ide' };
  }

  // Fall back to the local user configuration
  return getWorkspaceTrustFromLocalConfig(trustConfig, workspacePath);
}
