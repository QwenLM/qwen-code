/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const TOP_LEVEL_VERSION = /^( {2}"version": )"[^"]*"/m;

/**
 * Carry the version `pnpm version` wrote into the manifest text as it was
 * before, so a release bump changes the version and nothing else.
 *
 * `pnpm version` re-serializes every manifest it touches: it sorts dependency
 * blocks and drops empty ones. The v0.24.4 bump moved
 * `@modelcontextprotocol/sdk` inside the VS Code companion's dependencies,
 * which reordered its generated NOTICES.txt and failed main CI (#12486).
 *
 * @param {string} original - Manifest text before `pnpm version` ran
 * @param {string} updated - Manifest text after `pnpm version` ran
 * @returns {string} `original` with its top-level version replaced, or
 *   `updated` when the version cannot be located in `original`
 */
export function keepManifestLayout(original, updated) {
  const { version } = JSON.parse(updated);
  if (typeof version !== 'string' || !TOP_LEVEL_VERSION.test(original)) {
    return updated;
  }
  return original.replace(
    TOP_LEVEL_VERSION,
    (_, prefix) => `${prefix}${JSON.stringify(version)}`,
  );
}
