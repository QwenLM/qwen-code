/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Completion item types for autocomplete menus
 */

import type { ReactNode } from 'react';

/**
 * Completion item type categories
 */
export type CompletionItemType =
  | 'file'
  | 'folder'
  | 'symbol'
  | 'command'
  | 'variable'
  | 'info';

/**
 * Completion item for autocomplete menus
 */
export interface CompletionItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional description shown below label */
  description?: string;
  /** Optional icon to display */
  icon?: ReactNode;
  /** Type of completion item */
  type: CompletionItemType;
  /** Value inserted into the input when selected (e.g., filename or command) */
  value?: string;
  /** Optional full path for files (used to build @filename -> full path mapping) */
  path?: string;
  /** Optional group name for grouping items in the completion menu */
  group?: string;
}
