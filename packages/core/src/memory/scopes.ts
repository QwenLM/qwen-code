/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Valid project-memory partitioning modes. Exported so CLI yargs choices,
 * type declarations, and runtime guards share one source of truth.
 *
 * This module intentionally has NO imports of its own so it can be
 * subpath-imported (`@qwen-code/qwen-code-core/memoryScopes`) without
 * pulling the core barrel — and its 5 MB+ settings/TOML/glob transitive
 * closure — into bundle-critical paths such as the serve pre-listen root.
 */
export const MEMORY_PROJECT_SCOPES = ['git-root', 'workspace'] as const;
export type MemoryProjectScope = (typeof MEMORY_PROJECT_SCOPES)[number];
