/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auto mode: the host implementation behind `PermissionModes.Auto`.
 *
 * Verdicts come from a process-wide LLM classifier; each session/agent uses a
 * `(sessionId, agentId)` view. `auto-classifier` owns the views and state,
 * `classifier` assembles and calls the prompt, `denial-tracking` holds the
 * breaker, `denials` feeds `/permissions`.
 *
 * The barrel exports only `SessionPermissionManager` and `config-checker-deps`.
 */

export {
  AutoClassifier,
  AutoClassifierView,
  SESSION_AUTO_KEY,
  type AutoClassifierSession,
  type AutoClassifierShadowComparison,
  type AutoClassifierShadowContext,
} from './auto-classifier.js';

export {
  buildClassifierToolLookup,
  toClassifierMessages,
} from './classifier.js';
