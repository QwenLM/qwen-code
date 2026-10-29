/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Dependency-free on purpose: the managed-tool wire protocol caps snapshot
// arrays with this value and is loaded on paths that must not pull in the
// file history service (and its `diff`/git utilities). The service re-exports
// it, so the retention cap and the wire cap stay one definition.
export const MAX_SNAPSHOTS = 100;
