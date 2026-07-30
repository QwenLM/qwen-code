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
 * ACP initialize-response metadata proving that the child consumed the
 * private activation marker and installed the required executor callback.
 */
export const EXTERNAL_TOOL_GUARD_READY_META_KEY =
  'qwen-code/external-tool-guard-ready';

/** Daemon-local bearer token for the loopback external Tool Guard provider. */
export const EXTERNAL_TOOL_GUARD_TOKEN_ENV =
  'QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN';
