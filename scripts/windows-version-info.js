/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build the argv list for `scripts/patch_windows_version_info.ts`.
 *
 * @param {object} brand - product identity supplied by the build entry
 * @param {string} version - package.json version (e.g. "1.0.16")
 * @param {string} exePath - path to the .exe to patch
 * @returns {string[]} argv to pass to the patcher script (after `bun run <script>`)
 */
export function buildWindowsVersionInfoArgs(brand, version, exePath) {
  return [
    exePath,
    '--product-name',
    brand.productName,
    '--file-description',
    brand.productName,
    '--company-name',
    brand.companyName,
    '--product-version',
    version,
    '--file-version',
    version,
    '--internal-name',
    brand.cliBin,
    '--original-filename',
    `${brand.cliBin}.exe`,
    '--legal-copyright',
    brand.legalCopyright,
  ];
}
