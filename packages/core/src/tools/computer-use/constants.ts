/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The npm package that provides the Computer Use MCP server.
 *
 * This is the QwenLM fork (`@qwen-code/open-computer-use`), not upstream
 * `open-computer-use`. The fork rebrands the macOS bundle id, adds the
 * `OPEN_COMPUTER_USE_IMAGE_*` screenshot env overrides, and strips
 * Codex-specific install paths. Source:
 * https://github.com/QwenLM/open-computer-use
 *
 * NOTE: only the npm *package* name is scoped. The CLI binary the
 * package installs is still named `open-computer-use`, and the binary's
 * own error strings (e.g. "Run `open-computer-use doctor`") use that
 * binary name — `permission-detector.ts` matches against those and must
 * NOT be re-scoped.
 */
export const PINNED_OPEN_COMPUTER_USE_PACKAGE_NAME =
  '@qwen-code/open-computer-use';

/**
 * The exact `@qwen-code/open-computer-use` version this release of
 * qwen-code is pinned to. Hardcoded `schemas.ts` is generated against
 * this version; bumping it requires re-running the sync script.
 *
 * To bump:
 *   1. Update this constant to the new version (e.g. '0.2.1').
 *   2. Run `npx tsx scripts/sync-computer-use-schemas.ts` from the
 *      repo root — it reads this constant by default.
 *   3. Verify the regenerated `schemas.ts` diff is what you expect
 *      (parameter types, required fields, descriptions).
 *   4. Manually smoke-test the e2e flow on macOS.
 *
 * Using an exact pin (NOT `^x.y.z` or `@latest`) is deliberate:
 * the fork is 0.x and may ship schema-affecting changes in a patch
 * release. Locking the version means users get the exact schema
 * surface we tested against; a new release can't silently drift our
 * hardcoded schemas out of sync.
 */
export const PINNED_OPEN_COMPUTER_USE_VERSION = '0.2.2';

/**
 * Resolve the package spec to `npx` for spawning the MCP server. Reads
 * `QWEN_COMPUTER_USE_PACKAGE` env var at call time so tests / power
 * users can override the pinned package or version.
 */
export function resolveComputerUsePackageSpec(): string {
  return (
    process.env['QWEN_COMPUTER_USE_PACKAGE'] ??
    `${PINNED_OPEN_COMPUTER_USE_PACKAGE_NAME}@${PINNED_OPEN_COMPUTER_USE_VERSION}`
  );
}
