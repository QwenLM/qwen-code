/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Creator attribution the companion stamps on every session it starts.
 *
 * The daemon is shared: the CLI, the browser Web Shell, and this extension all
 * talk to the same `qwen serve` instance for a workspace, and Web Shell
 * otherwise records `'default'` for every surface. The stamp only records
 * where a session was created; the history list deliberately does not filter
 * on it, so CLI, browser, and pre-attribution conversations stay visible
 * here (#11574).
 */
export const VSCODE_SESSION_SOURCE_TYPE = 'vscode';
