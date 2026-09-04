/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Private provenance marker for ACP children hosted by the daemon's
 * Conversations runtime.
 *
 * The marker forces the session writer lease for every writer that runtime
 * hosts, independent of the experimental user setting. It is enable-only,
 * captured and deleted by the CLI entry point before any environment-file
 * load, excluded from project `.env` files, and never a user-facing setting.
 *
 * Kept in its own leaf module — and exported through a package subpath — so
 * serve fast-path modules can read the constant without pulling the core
 * barrel into their static import closure.
 */
export const PRIVATE_CONVERSATIONS_RUNTIME_ENV =
  'QWEN_CODE_PRIVATE_CONVERSATIONS_RUNTIME';
export const PRIVATE_CONVERSATIONS_RUNTIME_ENABLE = '1';
