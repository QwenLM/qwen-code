/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import stripJsonComments from 'strip-json-comments';
import chalk from 'chalk';
import { writeToStderr, sessionLogger } from '@qwen-code/core';
import {
  setFlagSettingsInput,
  type SettingSource,
} from './settings.js';

function formatFlagError(message: string): string {
  return `${chalk.red(chalk.bold('Error:'))} ${message}\n`;
}

/**
 * Process a `--settings` CLI flag value and register it as the active flag
 * settings source. Accepts either:
 *
 *   - A filesystem path (absolute or relative to `cwd`).
 *   - An inline JSON object (starts with `{` and ends with `}`).
 *
 * On invalid input (bad JSON, missing file) writes an error to stderr and
 * exits with code 1 — a malformed settings flag at startup is unrecoverable.
 */
export function loadSettingsFromFlag(flagValue: string): void {
  const trimmed = flagValue.trim();
  const looksLikeJson = trimmed.startsWith('{') && trimmed.endsWith('}');

  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(stripJsonComments(trimmed));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        writeToStderr(
          formatFlagError('--settings JSON must be an object literal'),
        );
        sessionLogger.setExitContext({
          reason: 'config_error',
          exit_code: 1,
          message: '--settings JSON must be an object literal',
          source: 'flagSettings.validate',
        });
        process.exit(1);
      }
      setFlagSettingsInput(parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeToStderr(
        formatFlagError(`Invalid JSON provided to --settings: ${msg}`),
      );
      sessionLogger.setExitContext({
        reason: 'config_error',
        exit_code: 1,
        message: `Invalid JSON provided to --settings: ${msg}`,
        source: 'flagSettings.validate',
        error_name: e instanceof Error ? e.name : undefined,
        error_stack: e instanceof Error ? e.stack : undefined,
      });
      process.exit(1);
    }
  } else {
    const resolvedPath = path.isAbsolute(flagValue)
      ? flagValue
      : path.resolve(process.cwd(), flagValue);
    if (!fs.existsSync(resolvedPath)) {
      writeToStderr(
        formatFlagError(`Settings file not found: ${resolvedPath}`),
      );
      sessionLogger.setExitContext({
        reason: 'config_error',
        exit_code: 1,
        message: `Settings file not found: ${resolvedPath}`,
        source: 'flagSettings.validate',
      });
      process.exit(1);
    }
    try {
      // Validate the file is readable now so we fail fast with a clear error
      // instead of later during loadSettings().
      fs.readFileSync(resolvedPath, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeToStderr(
        formatFlagError(`Cannot read settings file ${resolvedPath}: ${msg}`),
      );
      sessionLogger.setExitContext({
        reason: 'config_error',
        exit_code: 1,
        message: `Cannot read settings file ${resolvedPath}: ${msg}`,
        source: 'flagSettings.validate',
        error_name: e instanceof Error ? e.name : undefined,
        error_stack: e instanceof Error ? e.stack : undefined,
      });
      process.exit(1);
    }
    setFlagSettingsInput(resolvedPath);
  }
}

/**
 * Scan process.argv for `--settings <value>` or `--settings=<value>`.
 *
 * This runs eagerly — before yargs parses the full argument list — because
 * loadSettings() is invoked early in main() (the TUI entry module) before yargs runs.
 * Without an early parse, the first loadSettings() call would cache a result
 * that does not include the flag source.
 */
export function eagerParseSettingsFlag(
  argv: string[] = process.argv,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--settings') {
      return argv[i + 1];
    }
    if (arg.startsWith('--settings=')) {
      return arg.slice('--settings='.length);
    }
  }
  return undefined;
}

/**
 * Scan argv before the full command parser runs so startup settings loading
 * honors --setting-sources on its first (cached) read.
 */
export function eagerParseSettingSourcesFlag(
  argv: string[] = process.argv,
): SettingSource[] | undefined {
  const values: string[] = [];
  let found = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      break;
    }
    if (arg === '--setting-sources') {
      found = true;
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        values.push(value);
        i++;
      }
    } else if (arg.startsWith('--setting-sources=')) {
      found = true;
      values.push(arg.slice('--setting-sources='.length));
    }
  }

  if (!found) {
    return undefined;
  }

  const validSources = new Set<SettingSource>(['user', 'project', 'local']);
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value): value is SettingSource =>
      validSources.has(value as SettingSource),
    );
}
