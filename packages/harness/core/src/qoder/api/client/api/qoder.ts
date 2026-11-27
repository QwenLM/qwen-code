/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QoderAuthApi } from './auth/auth.js';
import type { QoderInferenceApi } from './inference/inference.js';
import type { QoderModelsApi } from './models/models.js';

/** The single public facade for Qoder account and gateway capabilities. */
export interface QoderApi {
  readonly auth: QoderAuthApi;
  readonly models: QoderModelsApi;
  readonly inference: QoderInferenceApi;
}

export * from './auth/auth.js';
export * from './inference/inference.js';
export * from './models/models.js';
