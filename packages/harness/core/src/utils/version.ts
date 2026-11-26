/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CLI_VERSION as GENERATED_CLI_VERSION } from '../generated/git-commit.js';
import { getPackageJson } from './package.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let versionPromise: Promise<string> | undefined;

/**
 * Synchronous CLI version, covering the two sources that need no I/O.
 *
 * Primary source: the literal string baked in at build time by
 * scripts/generate-git-commit-info.js (runs during `npm run generate` and
 * reads package.json — which update_package_version stamps to the real
 * release version before build). Using a literal string import avoids the
 * bundler's env-var substitution quirk where `process.env.CLI_VERSION`
 * (dot) gets replaced but `process.env['CLI_VERSION']` (bracket) does
 * not, which silently shipped 'unknown' in the bun binary.
 *
 * Falls back to the runtime env exported by the dev and Node SEA launchers.
 * Returns undefined when neither is populated, so callers that cannot await
 * the package.json fallback can omit the value instead of reporting a
 * placeholder.
 */
export function getVersionSync(): string | undefined {
  // Cast to string: TS narrows the imported constant to its literal type,
  // which makes the 'UNKNOWN' comparison unreachable in the eyes of the
  // type checker even though at runtime it is reachable when
  // generate-git-commit-info.js couldn't read package.json.
  const generated = GENERATED_CLI_VERSION as string;
  if (generated && generated !== 'UNKNOWN') {
    return generated;
  }
  return process.env['CLI_VERSION'] || undefined;
}

export function getVersion(): Promise<string> {
  if (versionPromise) {
    return versionPromise;
  }
  versionPromise = (async () => {
    const sync = getVersionSync();
    if (sync) return sync;
    const pkgJson = await getPackageJson(__dirname);
    return pkgJson?.version || 'unknown';
  })();
  return versionPromise;
}

/** For testing purposes only */
export function resetVersionCache(): void {
  versionPromise = undefined;
}
