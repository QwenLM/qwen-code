/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Flags forwarded to a spawned `qwen --acp` child. Shared by `runQwenServe`
 * (injected channel factory) and `createServeApp`'s default bridge spawn.
 */
export function acpChildExtraArgs(opts: {
  managedExtensions?: string;
  experimentalLsp?: boolean;
  restoreAskUserQuestion?: boolean;
}): string[] | undefined {
  const extraArgs = [
    ...(opts.managedExtensions !== undefined
      ? ['--managed-extensions', opts.managedExtensions]
      : []),
    ...(opts.experimentalLsp === true ? ['--experimental-lsp'] : []),
    ...(opts.restoreAskUserQuestion === true
      ? ['--restore-ask-user-question']
      : []),
  ];
  return extraArgs.length > 0 ? extraArgs : undefined;
}
