/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function isInteractiveInvocation(
  args: {
    promptInteractive?: string;
    query?: string;
    prompt?: string;
  },
  stdinIsTTY = process.stdin.isTTY ?? false,
): boolean {
  return Boolean(
    args.promptInteractive || (!args.query && !args.prompt && stdinIsTTY),
  );
}
