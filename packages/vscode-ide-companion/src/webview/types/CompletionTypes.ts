/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';

// Shared type for completion items used by the input completion system
export interface CompletionItem {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  type: 'file' | 'folder' | 'symbol' | 'command' | 'variable' | 'info';
  // Value inserted into the input when selected (e.g., filename or command)
  value?: string;
  // Optional full path for files (used to build @filename -> full path mapping)
  path?: string;
}
