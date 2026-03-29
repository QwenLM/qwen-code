/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Subpath Entry
 *
 * Separated from the root entry to avoid forcing all @qwen-code/webui
 * consumers to install @qwen-code/qwen-code-core as a dependency.
 *
 * Usage: import { useFollowupSuggestions } from '@qwen-code/webui/followup';
 */

export { useFollowupSuggestions } from './hooks/useFollowupSuggestions';
export type {
  FollowupSuggestion,
  FollowupState,
  UseFollowupSuggestionsOptions,
  UseFollowupSuggestionsReturn,
} from './hooks/useFollowupSuggestions';
