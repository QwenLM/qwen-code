/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../request/customRequest.js';
import type { CustomResponse } from '../response/customResponse.js';

/** Invokes one protocol-specific request against its response context. */
export interface Transport {
  invoke(input: CustomRequest, output: CustomResponse): Promise<void>;
}
