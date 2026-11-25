/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import stripJsonComments from 'strip-json-comments';
import type { FlagSettingsInput } from '../../config/settings.js';

/**
 * flag settings 的产品错误。文案是 wire 契约的一部分（宿主会把它编进错误帧），
 * 与源实现的 stderr 文案保持同义，但**不带** ANSI 颜色与 `Error:` 前缀——那是终端渲染，
 * 不是协议内容。
 */
export class SessionFlagSettingsError extends Error {}

/**
 * Parse the current session's --settings value. Paths are relative to the
 * session cwd, and the host reports parse failures as session errors.
 */
export function resolveSessionFlagSettings(
  flagValue: string,
  cwd: string,
): FlagSettingsInput {
  const trimmed = flagValue.trim();
  const looksLikeJson = trimmed.startsWith('{') && trimmed.endsWith('}');
  if (looksLikeJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(trimmed));
    } catch (e) {
      throw new SessionFlagSettingsError(
        `Invalid JSON provided to --settings: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new SessionFlagSettingsError(
        '--settings JSON must be an object literal',
      );
    }
    return parsed as Record<string, unknown>;
  }
  const resolvedPath = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(cwd, trimmed);
  if (!fs.existsSync(resolvedPath)) {
    throw new SessionFlagSettingsError(
      `Settings file not found: ${resolvedPath}`,
    );
  }
  try {
    fs.readFileSync(resolvedPath, 'utf8');
  } catch (e) {
    throw new SessionFlagSettingsError(
      `Cannot read settings file ${resolvedPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return resolvedPath;
}
