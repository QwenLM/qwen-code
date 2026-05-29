/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The exact upstream `open-computer-use` version this release of
 * qwen-code is pinned to. Hardcoded `schemas.ts` is generated against
 * this version; bumping it requires re-running the sync script.
 *
 * To bump:
 *   1. Update this constant to the new version (e.g. '0.1.52').
 *   2. Run `npx tsx scripts/sync-computer-use-schemas.ts` from the
 *      repo root — it reads this constant by default.
 *   3. Verify the regenerated `schemas.ts` diff is what you expect
 *      (parameter types, required fields, descriptions).
 *   4. Manually smoke-test the e2e flow on macOS.
 *
 * Using an exact pin (NOT `^x.y.z` or `@latest`) is deliberate:
 * upstream is 0.x and may ship schema-affecting changes in a patch
 * release. Locking the version means users get the exact schema
 * surface we tested against; a new upstream release can't silently
 * drift our hardcoded schemas out of sync.
 */
export const PINNED_OPEN_COMPUTER_USE_VERSION = '0.1.51';

/**
 * Resolve the upstream open-computer-use package spec to use for
 * spawning the MCP server. Reads `QWEN_COMPUTER_USE_PACKAGE` env var
 * at call time so tests / power users can override the pinned version.
 */
export function resolveComputerUsePackageSpec(): string {
  return (
    process.env['QWEN_COMPUTER_USE_PACKAGE'] ??
    `open-computer-use@${PINNED_OPEN_COMPUTER_USE_VERSION}`
  );
}
