/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModToolCallInput,
  ModToolCheckInput,
  ModToolCheckResult,
  ModToolResult,
} from './tool-events.js';

export const MOD_MAX_BYTES = 262_144;
export const MOD_TIMEOUT_MS = 10_000;
export const MOD_END_TIMEOUT_MS = 1_500;

export interface ModSource {
  root: string;
  entry: string;
  source: string;
}

export type ModOption = string | number | boolean | string[];
export type ModOptions = Record<string, ModOption>;
export type ModToolDialect = 'native' | 'claude';
export type ModPluginConfigs = Record<
  string,
  { options?: ModOptions; toolDialect?: ModToolDialect }
>;

export interface ModDependency {
  name: string;
  marketplace?: string;
  version?: string;
}

export interface ModDefinition extends ModSource {
  userConfig?: unknown;
  dependencies: ModDependency[];
}

export interface ModCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface ModCommandPresentation {
  isFullscreen: boolean;
  columns: number;
}

export interface ModPlugin {
  id: string;
  name: string;
  source: ModSource;
  options: ModOptions;
  toolDialect?: ModToolDialect;
}

export interface ModLog {
  text: string;
  to: 'debug' | 'transcript';
}

export type ModRequest =
  | {
      type: 'load';
      plugins: ModPlugin[];
      cwd: string;
      surface: 'terminal' | null;
    }
  | {
      type: 'command';
      command: string;
      args: string;
      presentation?: ModCommandPresentation;
    }
  | { type: 'tool'; input: ModToolCallInput; builtinTool?: string }
  | { type: 'host-result'; id: number; result?: ModToolResult; error?: string }
  | {
      type: 'tool-check';
      id: number;
      operation: number;
      input: ModToolCheckInput;
      verdict: ModToolCheckResult;
    }
  | { type: 'end'; sessionId: string; reason: 'clear' | 'resume' | 'other' };

export type ModReply =
  | { type: 'result'; json: string }
  | { type: 'error'; message: string }
  | { type: 'host-call'; id: number; input: ModToolCallInput }
  | { type: 'host-cancel'; ids: number[] }
  | {
      type: 'check-result';
      id: number;
      result?: ModToolCheckResult;
      error?: string;
    }
  | ({ type: 'log'; plugin: string } & ModLog);
