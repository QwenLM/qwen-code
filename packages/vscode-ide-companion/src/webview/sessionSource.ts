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
 * otherwise records `'default'` for every surface. Without a distinct value the
 * VS Code channel is indistinguishable from a terminal or browser session, so
 * the panel's history would list conversations the user never started here.
 */
export const VSCODE_SESSION_SOURCE_TYPE = 'vscode';
