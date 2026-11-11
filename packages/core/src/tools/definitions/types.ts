/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type FunctionDeclaration } from '@google/genai';

/**
 * Explicit mapping of all core tools.
 */
export interface CoreToolSet {
  Read: FunctionDeclaration;
  Write: FunctionDeclaration;
  Grep: FunctionDeclaration;
  GrepRipgrep: FunctionDeclaration;
  Glob: FunctionDeclaration;
  Bash: (enableBashPtyTools?: boolean) => FunctionDeclaration;
  Edit: FunctionDeclaration;
  WebFetch: FunctionDeclaration;
  TodoWrite: FunctionDeclaration;
  AskUserQuestion: FunctionDeclaration;
  EnterPlanMode: FunctionDeclaration;
  ExitPlanMode: () => FunctionDeclaration;
  Skill: () => FunctionDeclaration;
}
