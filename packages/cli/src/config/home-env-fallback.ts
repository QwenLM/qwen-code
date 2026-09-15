/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';
import { getErrorMessage, Storage } from '@qwen-code/qwen-code-core';

/**
 * Collects environment variables from user-level `.env` files and returns
 * them as a plain dictionary **without** mutating `process.env`.
 *
 * Standalone copy of the resolution `environment.ts` exports, kept here so
 * importing `.mcp.json` loading does not pull the settings-environment
 * module graph (which evaluates `QWEN_DIR` at module scope) into every
 * consumer of `loadProjectMcpServers` — test suites that mock the core
 * package with an explicit allow-list and never touch settings would
 * otherwise fail at collection time. Candidates are iterated
 * most-specific-first (`~/.qwen/.env` before `~/.env`); `??=` ensures the
 * first file to define a key wins, matching dotenv's first-occurrence-wins
 * semantics used elsewhere.
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
