/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Marker prefixes for the insight slash-command ACP notification protocol.
 * Used by CLI (producer) and vscode-ide-companion (consumer) to exchange
 * structured progress / ready signals over plain-text message strings.
 */
export const INSIGHT_PROGRESS_MARKER = '__QWEN_INSIGHT_PROGRESS__:';
export const INSIGHT_READY_MARKER = '__QWEN_INSIGHT_READY__:';
