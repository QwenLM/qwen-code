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
import type { ModRenderInput, ModRenderSite } from './render-tree.js';

export const MOD_MAX_BYTES = 262_144;
export const MOD_MAX_DEPTH = 512;
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
export type ModUnsupportedEvents = 'skip' | 'reject';
export type ModPluginConfigs = Record<
  string,
  {
    options?: ModOptions;
    toolDialect?: ModToolDialect;
    unsupportedEvents?: ModUnsupportedEvents;
  }
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
  unsupportedEvents?: ModUnsupportedEvents;
}

export interface ModLog {
  text: string;
  to: 'debug' | 'transcript';
}

export interface ModSessionUsage {
  startedAt: number;
  // Claude Code declares `tokens` optional; Qwen Code always reports it.
  context: { tokens?: number; window: number; percent?: number };
  rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>;
}

/** Read on the main thread when a dispatch starts; `$.session` answers from it. */
export interface ModSessionFacts {
  id: string;
  cwd: string;
  root: string;
  model: string;
  turns: number;
  usage: ModSessionUsage;
}

/** What a main-loop turn cost, in the API's spelling, and the last model. */
export interface ModTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  model: string;
}

export interface ModTurnStart {
  text: string;
  turnId: string;
  /** Set when `text` kept only its head and tail to fit the Mod payload. */
  isTextTruncated?: true;
}

/** Where a submitted prompt came from, in Claude Code's `PromptOrigin`. */
export type ModPromptOrigin = { kind: 'composer' } | { kind: 'sdk' };

export interface ModPromptSubmit {
  text: string;
  wait: boolean;
  origin: ModPromptOrigin;
}

/**
 * How a submitted prompt fared: what arrived beneath the hooks, or why it
 * did not enter. `byHook` tells a hook's own drop from one that answered
 * without passing the prompt on.
 */
export type ModPromptSubmitted =
  | { text: string; context?: string[] }
  | { drop: string; byHook: boolean };

export interface ModTurnComplete {
  answer: string;
  durationMs: number;
  isAborted: boolean;
  turnId: string;
  reason: 'answer' | 'aborted' | 'error';
  usage?: ModTurnUsage;
  /** Set when `answer` kept only its head and tail to fit the Mod payload. */
  isAnswerTruncated?: true;
}

export type ModRequest =
  | {
      type: 'load';
      plugins: ModPlugin[];
      cwd: string;
      surface: 'terminal' | null;
      version: string;
      /** The render sites this host draws; `ui.render` runs only where one is offered. */
      sites?: readonly ModRenderSite[];
      /** Whether the host raises `prompt.submit`; its hooks are skipped otherwise. */
      prompts?: boolean;
    }
  | {
      type: 'command';
      command: string;
      args: string;
      presentation?: ModCommandPresentation;
    }
  | { type: 'tool'; input: ModToolCallInput; builtinTool?: string }
  | { type: 'native'; id: number }
  | { type: 'host-result'; id: number; result?: ModToolResult; error?: string }
  | {
      type: 'tool-check';
      id: number;
      operation: number;
      input: ModToolCheckInput;
      verdict: ModToolCheckResult;
    }
  | { type: 'end'; sessionId: string; reason: 'clear' | 'resume' | 'other' }
  | { type: 'turn-start'; input: ModTurnStart }
  | { type: 'prompt-submit'; input: ModPromptSubmit }
  | { type: 'turn-complete'; input: ModTurnComplete }
  | { type: 'render'; input: ModRenderInput }
  | { type: 'turn-abort-result'; id: number; error?: string };

export type ModReply =
  | { type: 'result'; json: string }
  | { type: 'error'; message: string }
  | { type: 'host-call'; id: number; input: ModToolCallInput }
  | { type: 'host-cancel'; ids: number[] }
  | { type: 'activity'; revision: number; operation?: number }
  | {
      type: 'check-result';
      id: number;
      result?: ModToolCheckResult;
      error?: string;
    }
  | { type: 'turn-abort'; id: number; turnId: string }
  | { type: 'invalidate'; plugin: string; event: string }
  | ({ type: 'log'; plugin: string } & ModLog);

export type ModWorkerRequest = ModRequest & {
  root: number;
  phase: number;
  facts?: ModSessionFacts;
};
export type ModWorkerReply = ModReply & { root: number; phase: number };
