/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomProviderConfig } from '../provider/impl/customProviderConfig.js';
import type { CustomApi } from './api/custom.js';
import { CustomApiImpl } from './impl/custom.js';
import { buildCustomOutboundPipeline } from './pipeline/outboundPipelineFactory.js';
import type { CustomClient } from './customClient.js';

export interface CreateCustomClientImplOptions {
  readonly customProviderConfig: CustomProviderConfig;
}

/** One custom provider's client: a fixed endpoint/credential binding plus its API facade. */
export class CustomClientImpl implements CustomClient {
  readonly api: CustomApi;

  constructor(options: CreateCustomClientImplOptions) {
    this.api = new CustomApiImpl(
      buildCustomOutboundPipeline({
        endpointResolver: options.customProviderConfig,
        bearerResolver: options.customProviderConfig,
        apiKeyResolver: options.customProviderConfig,
      }),
    );
  }
}
