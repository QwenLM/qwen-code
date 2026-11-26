/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Session configuration binding; never part of the inference or wire contract. */
export interface ModelRequestRetryConfig {
  getMaxAttempts(): number;
  getRetryFetchErrors(): boolean;
}
const configScope = new AsyncLocalStorage<ModelRequestRetryConfig>();
export const getModelRequestRetryConfig = () => configScope.getStore();
export function withModelRequestRetryConfig<T>(
  config: ModelRequestRetryConfig,
  run: () => T,
): T {
  return configScope.run(config, run);
}
