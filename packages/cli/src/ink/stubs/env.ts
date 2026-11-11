/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

export const env = {
  hasInternetAccess: async () => true,
  isCI: Boolean(process.env['CI']),
  platform: process.platform as 'win32' | 'darwin' | 'linux',
  arch: process.arch,
  nodeVersion: process.version,
  terminal: process.env['TERM_PROGRAM'] ?? null,
  isSSH: () => Boolean(process.env['SSH_CONNECTION'] || process.env['SSH_TTY']),
  isRunningWithBun: () => false,
  isWslEnvironment: () => false,
  isNpmFromWindowsPath: () => false,
  isConductor: () => false,
  detectDeploymentEnvironment: () => 'local',
};
