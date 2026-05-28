/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve the upstream open-computer-use package spec to use for
 * spawning the MCP server. Reads `QWEN_COMPUTER_USE_PACKAGE` env var
 * at call time so tests can mutate it.
 *
 * Defaults to `open-computer-use@latest` for the runtime; the
 * `scripts/sync-computer-use-schemas.ts` script pins this during
 * release prep.
 */
export function resolveComputerUsePackageSpec(): string {
  return process.env['QWEN_COMPUTER_USE_PACKAGE'] ?? 'open-computer-use@latest';
}
