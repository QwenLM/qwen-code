/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomApi } from '../api/custom.js';
import type { CustomInferenceApi } from '../api/inference/inference.js';
import type { Pipeline } from '../pipeline/pipeline.js';
import { CustomInferenceApiImpl } from './inference/inference.js';

/** The custom-provider API facade owned by one client instance. */
export class CustomApiImpl implements CustomApi {
  readonly inference: CustomInferenceApi;

  constructor(pipeline: Pipeline) {
    this.inference = new CustomInferenceApiImpl(pipeline);
  }
}
