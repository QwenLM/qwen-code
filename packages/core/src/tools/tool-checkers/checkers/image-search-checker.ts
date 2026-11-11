/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for searching for images.
 *
 * Reaches outside the session and has no finer key than its own name: asks
 * once, and the prompt offers to allow the tool from then on.
 */

import {
  askWithSelfAllowChecker,
  type HostToolChecker,
} from '../rule-precedence.js';

export function createImageSearchToolChecker(
  toolName: string,
): HostToolChecker {
  return askWithSelfAllowChecker(
    toolName,
    'Allow searching for images?',
    'image_search.no_rule.ask',
  );
}
