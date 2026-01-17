/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PermissionOption {
  name: string;
  kind: string;
  optionId: string;
}

export interface ToolCall {
  title?: string;
  kind?: string;
  toolCallId?: string;
  rawInput?: {
    command?: string;
    description?: string;
    [key: string]: unknown;
  };
  content?: Array<{
    type: string;
    [key: string]: unknown;
  }>;
  locations?: Array<{
    path: string;
    line?: number | null;
  }>;
  status?: string;
}

export interface PermissionRequestProps {
  options: PermissionOption[];
  toolCall: ToolCall;
  onResponse: (optionId: string) => void;
}
