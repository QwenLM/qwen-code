/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type { DreamConfig } from './config.js';
export { resolveDreamConfig } from './config.js';
export {
  initAutoDream,
  executeAutoDream,
  drainAutoDream,
  type AutoDreamCallbacks,
  type AutoDreamTurnContext,
} from './autoDreamService.js';
