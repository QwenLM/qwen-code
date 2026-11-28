/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomInferenceApi } from './inference/inference.js';

/** The custom-provider API facade owned by one client instance. */
export interface CustomApi {
  /** The inference API facade for chat/responses/messages protocols. */
  readonly inference: CustomInferenceApi;
}
