/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Private, non-secret activation marker passed only from `qwen serve` to its
 * authenticated ACP child. The child consumes and deletes it before any tool,
 * hook, MCP server, or sub-agent can inherit the process environment.
 */
export const PRIVATE_EXTERNAL_TOOL_GUARD_ENV =
  'QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD';

/**
 * Private, non-secret marker passed from `qwen serve` to its ACP child only
 * when a real external tool guard provider is attached. Without it the child
 * still installs the managed guard plumbing (the daemon's built-in policy
 * needs it), but resolves every non-shell tool locally and keeps `/fork` and
 * agent-backed workspace memory available: those features are only disabled
 * for the external provider's v1 contract, which cannot observe hidden-agent
 * execution.
 */
export const PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV =
  'QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER';

/**
 * ACP initialize-response metadata proving that the child consumed the
 * private activation marker and installed the required executor callback.
 */
export const EXTERNAL_TOOL_GUARD_READY_META_KEY =
  'qwen-code/external-tool-guard-ready';

/**
 * The guard acknowledgment value the ACP child returns for
 * `EXTERNAL_TOOL_GUARD_READY_META_KEY`, and the private activation marker
 * value `qwen serve` passes to the child, when the guard is required.
 */
export const EXTERNAL_TOOL_GUARD_REQUIRED_VALUE = 'required-v1';

/**
 * The provider-attached marker value `qwen serve` passes to the child when a
 * real external tool guard provider is configured.
 */
export const EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE = 'attached-v1';

/**
 * Tools whose arguments carry a shell command line the host runs on the
 * session's behalf. The daemon's built-in policy inspects exactly these, and
 * the ACP child resolves every other tool locally when no external provider
 * is attached. Pinned to `ToolNames.SHELL`/`ToolNames.MONITOR` in
 * `@qwen-code/qwen-code-core`, which this package deliberately does not
 * depend on; `daemon-git-worktree-guard.test.ts` asserts the values still
 * match so a rename cannot silently unhook a tool from the guard.
 */
export const SHELL_EXECUTING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'monitor',
  'run_shell_command',
]);

/** Daemon-local bearer token for the loopback external Tool Guard provider. */
export const EXTERNAL_TOOL_GUARD_TOKEN_ENV =
  'QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN';

/** Maximum length of an external tool guard denial reason. */
export const EXTERNAL_TOOL_GUARD_MAX_DENIAL_REASON_CHARS = 500;

/**
 * Control characters that could forge log lines or break rendering when a
 * token or denial reason is displayed.
 */
export function containsUnsafeExternalToolGuardControlCharacter(
  value: string,
): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}

/** Validates a denial reason returned by an external tool guard provider. */
export function isValidExternalToolGuardDenialReason(
  reason: unknown,
): reason is string {
  return (
    typeof reason === 'string' &&
    reason.trim().length > 0 &&
    reason.length <= EXTERNAL_TOOL_GUARD_MAX_DENIAL_REASON_CHARS &&
    !containsUnsafeExternalToolGuardControlCharacter(reason)
  );
}
