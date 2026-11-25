/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal, content-free business attribution exposed by the main Agent loop.
 * Consumers must keep this callback synchronous and side-effect free.
 */
export interface QueryBusinessContext {
  sessionId: string;
  requestSetId: string;
  businessId?: string;
}
