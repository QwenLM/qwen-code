/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import type { EndpointResolver } from '../../endpoint/endpointResolver.js';
import { BaseValve } from './valve.js';
import { ValveError } from './valveError.js';

/**
 * Resolves the target endpoint for requests that do not carry one yet.
 *
 * Runs before the proxy stage so bypass evaluation sees the resolved origin.
 * An unresolvable key is a hard error: proceeding without an origin would
 * silently bypass every downstream route decision.
 */
export class EndpointValve extends BaseValve {
  constructor(private readonly resolver: EndpointResolver) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    if (!input.origin) {
      const resolved = await this.resolver.resolve(input.endpointType);
      if (resolved === undefined) {
        throw new ValveError(
          `cannot resolve endpoint for ${String(input.endpointType)}`,
          { valveName: 'endpoint', step: 'resolve' },
        );
      }
      input.setOrigin(resolved.origin);
      if (resolved.ips !== undefined) input.setIps(resolved.ips);
    }
    await this.getNext()!.invoke(input, output);
  }
}
