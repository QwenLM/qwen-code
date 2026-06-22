/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { DISPLAY_MODE } from './types.js';
export type {
  Backend,
  DisplayMode,
  AgentSpawnConfig,
  AgentExitCallback,
  TmuxBackendOptions,
  InProcessSpawnConfig,
} from './types.js';
export { TmuxBackend } from './TmuxBackend.js';
export { ITermBackend } from './ITermBackend.js';
export { InProcessBackend } from './InProcessBackend.js';
export { detectBackend, type DetectBackendResult } from './detect.js';
