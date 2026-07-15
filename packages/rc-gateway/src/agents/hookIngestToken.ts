/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Load (or mint exactly once) the dedicated hook-ingest token (design:
 * "minted once on first startup and persisted — regenerating per start
 * would invalidate existing hook config — written 0600"). The docs snippet
 * that configures core's HTTP hook runner interpolates this value; it is
 * NOT a TokenStore token and grants nothing beyond POST /rc/hooks/ingest.
 */
export async function loadOrCreateHookIngestToken(
  filePath: string,
): Promise<string> {
  try {
    const existing = (await readFile(filePath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Missing file → mint below.
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, token + '\n', { mode: 0o600 });
  return token;
}
