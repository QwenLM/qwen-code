/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
export type ModPluginConfigs = Record<string, { options?: ModOptions }>;

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

export interface ModLog {
  text: string;
  to: 'debug' | 'transcript';
}

export type ModRequest =
  | { type: 'load'; source: ModSource; options: ModOptions; cwd: string }
  | { type: 'command'; command: string; args: string }
  | { type: 'end'; sessionId: string; reason: 'clear' | 'resume' | 'other' };

export type ModReply =
  | { type: 'result'; json: string }
  | { type: 'error'; message: string }
  | ({ type: 'log' } & ModLog);
