/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QoderModelCatalogEntry } from '../../../model-catalog.js';

export interface QoderModelsListOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Qoder account model catalog (`categories=qcode`). */
export interface QoderModelsApi {
  list(options?: QoderModelsListOptions): Promise<QoderModelCatalogEntry[]>;
}
