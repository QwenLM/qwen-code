/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import type { BearerResolver } from '../../../auth/bearerResolver.js';
import { BaseValve } from './valve.js';

/**
 * Resolves the declared bearer credential onto the Authorization header.
 *
 * A pure executor: it places whatever token the bearer resolver reports,
 * without inspecting the login state. Missing or empty tokens are skipped
 * so unauthenticated pipelines fall through to transport untouched.
 *
 * A resolver that exposes `refreshBearer` may renew once when the peer
 * answers HTTP 401; the next valves are re-run so the retried send carries
 * the fresh credential. The rejected body is cancelled first.
 */
export class BearerValve extends BaseValve {
  constructor(private readonly bearerResolver: BearerResolver) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    let token: string | undefined;
    if (input.requireBearer) {
      token = this.bearerResolver.getBearerAsync
        ? await this.bearerResolver.getBearerAsync()
        : this.bearerResolver.getBearer();
    }
    if (input.bearerLiteral) token = input.bearerLiteral;
    if (token !== undefined && token !== '') input.applyBearerToken(token);
    await this.getNext()!.invoke(input, output);
    if (
      output.raw?.status !== 401 ||
      input.bearerLiteral ||
      !this.bearerResolver.refreshBearer
    ) {
      return;
    }
    const refused = output.raw;
    const fresh = await this.bearerResolver.refreshBearer(token);
    if (fresh === undefined || fresh === '') return;
    await refused.body?.cancel().catch(() => undefined);
    input.applyBearerToken(fresh);
    await this.getNext()!.invoke(input, output);
  }
}
