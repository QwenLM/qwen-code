/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Creator attribution the companion stamps on every session it starts.
 *
 * The daemon is shared: the CLI, the browser Web Shell, and this extension all
 * talk to the same `qwen serve` instance for a workspace. The stamp is *not*
 * inert even though this panel's history list no longer filters on it: the
 * browser Web Shell's `'default'`-scoped session lists (`useScopedSessions`,
 * `sessionSearch`) match only `sourceType === undefined` or `'default'`, so a
 * panel-created `'vscode'` session stays out of those lists. Keeping the stamp
 * preserves that boundary; a future change that wants companion sessions to
 * appear in the browser Web Shell must drop this stamp deliberately, not
 * incidentally.
 */
export const VSCODE_SESSION_SOURCE_TYPE = 'vscode';
