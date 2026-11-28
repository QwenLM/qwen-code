/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import type { ApiKeyResolver } from '../../../auth/apiKeyResolver.js';
import { BaseValve } from './valve.js';

/**
 * Places the resolver's API key onto the request, omitting missing values.
 *
 * Pure executor like BearerValve: it never decides which auth mode applies,
 * the resolver does — an undefined key leaves the request untouched.
 */
export class ApiKeyValve extends BaseValve {
  constructor(private readonly apiKeyResolver: ApiKeyResolver) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    let token: string | undefined;
    if (input.requireApiKey) {
      token = this.apiKeyResolver.getApiKey();
    }
    if (token !== undefined && token !== '') {
      input.applyApiKeyToken(
        token,
        this.apiKeyResolver.getApiKeyHeader?.() ?? 'x-api-key',
      );
    }
    await this.getNext()!.invoke(input, output);
  }
}
