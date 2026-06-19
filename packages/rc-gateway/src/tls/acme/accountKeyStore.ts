/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Load the ACME account key from `<baseDir>/account.key`, or create it once via
 * `generate` and persist it 0600 under a 0700 dir. The account key is reused
 * across all renewals — re-registering an account per issuance is wasteful and
 * risks ACME account rate limits. The key is security-sensitive (it authenticates
 * every order), hence the strict mode.
 */
export async function loadOrCreateAccountKey(
  baseDir: string,
  generate: () => Promise<string>,
): Promise<string> {
  const path = join(baseDir, 'account.key');
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = await generate();
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  await chmod(baseDir, 0o700);
  await writeFile(path, key, { mode: 0o600 });
  await chmod(path, 0o600);
  return key;
}
