/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** 本地调用控制选项，不进入请求体。 */
export interface CustomInferenceStreamOptions {
  readonly signal?: AbortSignal;
}
