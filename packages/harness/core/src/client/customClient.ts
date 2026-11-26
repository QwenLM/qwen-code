/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamClient } from '../provider/transport/modelTransport.js';
import type { CustomApi } from './api/custom.js';

/** The client-facing facade for user-configured model services. */
export interface CustomClient extends ModelStreamClient {
  /** The custom-provider API facade owned by this client. */
  readonly api: CustomApi;
}
