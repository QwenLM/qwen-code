/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ZodError, ZodIssue } from 'zod';
import {
  originalHookSettingsPath,
  rememberHookArrayRemoval,
} from '@qwen-code/resource';
import { validateSettings } from './settings-validation.js';

export interface SettingsCompatibilityChange {
  path: string;
  oldType: string;
  action: 'converted';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Normalize settings shapes that older CLI versions accepted before
 * validating against the current schema.
 */
export function normalizeLegacySettingsShape(
  settings: Record<string, unknown>,
): SettingsCompatibilityChange[] {
  const changes: SettingsCompatibilityChange[] = [];
  const model = settings['model'];

  if (isString(model)) {
    settings['model'] = { name: model };
    changes.push({
      path: 'model',
      oldType: 'string',
      action: 'converted',
    });
  }

  return changes;
}

export interface SkippedMcpServerConfig {
  serverName: string;
  reason: string;
}

export interface IgnoredSettingsValidationIssue {
  path: string;
  reason: string;
}

export interface RecoverableSettingsValidationResult {
  ignoredIssues: IgnoredSettingsValidationIssue[];
  validationResult: ReturnType<typeof validateSettings>;
}

const MAX_RECOVERABLE_SETTINGS_VALIDATION_PASSES = 20;

function formatMcpValidationReason(
  serverName: string,
  error: ZodError,
): string {
  const MAX_ISSUES = 3;
  const issues = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const rawPath = Array.isArray(issue.path) ? issue.path : [];
    const relativePath = rawPath.slice(2);
    const path =
      relativePath.length > 0
        ? relativePath
            .map((part) => (typeof part === 'number' ? `[${part}]` : part))
            .join('.')
            .replace('.[', '[')
        : '(root)';
    return `${path}: ${issue.message}`;
  });

  if (error.issues.length > MAX_ISSUES) {
    issues.push(`...and ${error.issues.length - MAX_ISSUES} more errors`);
  }

  return `Skipped invalid MCP server "${serverName}": ${issues.join('; ')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string | number): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function formatSettingsIssuePath(path: ReadonlyArray<string | number>): string {
  const rendered = path.reduce<string>((acc, part) => {
    if (typeof part === 'number') {
      return `${acc}[${part}]`;
    }
    return acc ? `${acc}.${part}` : part;
  }, '');
  return rendered || '(root)';
}

function getValueAtPath(
  root: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current) || part < 0 || part >= current.length) {
        return undefined;
      }
      current = current[part];
      continue;
    }
    if (!isRecord(current) || !hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function deleteAtPath(
  root: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
): boolean {
  if (path.length === 0) {
    return false;
  }

  const parent = getValueAtPath(root, path.slice(0, -1));
  const key = path[path.length - 1];

  if (typeof key === 'number') {
    if (!Array.isArray(parent) || key < 0 || key >= parent.length) {
      return false;
    }
    rememberHookArrayRemoval(parent, key, path);
    parent.splice(key, 1);
    return true;
  }

  if (!isRecord(parent) || !hasOwn(parent, key)) {
    return false;
  }
  delete parent[key];
  return true;
}

function isMissingRequiredIssue(issue: ZodIssue): boolean {
  if (issue.code !== 'invalid_type') {
    return false;
  }
  return (
    'received' in issue &&
    (issue as { received?: unknown }).received === 'undefined'
  );
}

function getDeletionPathForIssue(
  issue: ZodIssue,
): Array<string | number> | undefined {
  const path = [...issue.path];
  if (path.length === 0) {
    return undefined;
  }

  const firstArrayIndex = path.findIndex((part) => typeof part === 'number');
  if (firstArrayIndex >= 0) {
    return path.slice(0, firstArrayIndex + 1);
  }

  if (isMissingRequiredIssue(issue) && path.length > 1) {
    return path.slice(0, -1);
  }

  return path;
}

function removeUnrecognizedKeysForIssue(
  settings: Record<string, unknown>,
  issue: ZodIssue,
): { changed: boolean; path: string } {
  if (issue.code !== 'unrecognized_keys') {
    return { changed: false, path: formatSettingsIssuePath(issue.path) };
  }

  const target = getValueAtPath(settings, issue.path);
  if (!isRecord(target)) {
    return { changed: false, path: formatSettingsIssuePath(issue.path) };
  }

  let changed = false;
  for (const key of issue.keys) {
    if (hasOwn(target, key)) {
      delete target[key];
      changed = true;
    }
  }

  const issuePath = formatSettingsIssuePath(issue.path);
  return {
    changed,
    path: issue.keys.length === 1 ? `${issuePath}.${issue.keys[0]}` : issuePath,
  };
}

function pruneRecoverableSettingsIssue(
  settings: Record<string, unknown>,
  issue: ZodIssue,
): { changed: boolean; path: string } {
  const issuePath = formatSettingsIssuePath(issue.path);
  const ui = settings['ui'];
  if (issuePath === 'ui.language' && isRecord(ui)) {
    // Keep the invalid value in originalSettings, but use the required English
    // fallback in the sanitized runtime view.
    ui['language'] = 'en';
    return { changed: true, path: issuePath };
  }

  const unrecognized = removeUnrecognizedKeysForIssue(settings, issue);
  if (unrecognized.changed) {
    return unrecognized;
  }

  const deletionPath = getDeletionPathForIssue(issue);
  if (!deletionPath) {
    return { changed: false, path: formatSettingsIssuePath(issue.path) };
  }

  return {
    changed: deleteAtPath(settings, deletionPath),
    path: formatSettingsIssuePath(deletionPath),
  };
}

function isRecoverableSettingsIssue(issue: ZodIssue): boolean {
  const root = issue.path[0];
  return typeof root === 'string';
}

export function sanitizeRecoverableSettingsValidationIssues(
  settings: Record<string, unknown>,
  validate: typeof validateSettings = validateSettings,
): RecoverableSettingsValidationResult {
  const ignoredIssues: IgnoredSettingsValidationIssue[] = [];
  const seenWarnings = new Set<string>();

  for (
    let pass = 0;
    pass < MAX_RECOVERABLE_SETTINGS_VALIDATION_PASSES;
    pass++
  ) {
    const validationResult = validate(settings);
    if (validationResult.success || !validationResult.error) {
      return { ignoredIssues, validationResult };
    }

    let changed = false;
    for (const issue of validationResult.error.issues) {
      if (!isRecoverableSettingsIssue(issue)) {
        continue;
      }

      // Capture before pruning: this pass may remove the group itself.
      const originalPath = originalHookSettingsPath(settings, issue.path);
      const pruned = pruneRecoverableSettingsIssue(settings, issue);
      if (!pruned.changed) {
        continue;
      }

      changed = true;
      const issuePath = formatSettingsIssuePath(originalPath);
      const warningKey = `${issuePath}:${issue.message}:${pruned.path}`;
      if (!seenWarnings.has(warningKey)) {
        seenWarnings.add(warningKey);
        ignoredIssues.push({
          path: pruned.path,
          reason: `Ignored invalid setting "${issuePath}": ${issue.message}`,
        });
      }
      break;
    }

    if (!changed) {
      return {
        ignoredIssues,
        validationResult: validate(settings),
      };
    }
  }

  return {
    ignoredIssues,
    validationResult: validate(settings),
  };
}

export function skipInvalidMcpServerConfigs(
  settings: Record<string, unknown>,
  validate: typeof validateSettings = validateSettings,
): SkippedMcpServerConfig[] {
  const skipped: SkippedMcpServerConfig[] = [];
  const servers = settings['mcpServers'];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return skipped;
  }

  const serverMap = servers as Record<string, unknown>;
  for (const [name, raw] of Object.entries(serverMap)) {
    const result = validate({ mcpServers: { [name]: raw } });
    if (result.success) {
      const parsedSettings = result.data as {
        mcpServers?: Record<string, unknown>;
      };
      const parsedServer = parsedSettings.mcpServers?.[name];
      if (parsedServer !== undefined) {
        serverMap[name] = parsedServer;
      }
      continue;
    }

    if (!result.error) continue;

    delete serverMap[name];
    skipped.push({
      serverName: name,
      reason: formatMcpValidationReason(name, result.error),
    });
  }

  return skipped;
}
