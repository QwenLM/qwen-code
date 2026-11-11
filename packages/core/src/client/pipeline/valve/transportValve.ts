/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import type { Transport } from '../../transport/transport.js';
import { BaseValve } from './valve.js';

/**
 * Terminal pipeline valve that selects a registered protocol transport. It
 * intentionally does not invoke `next`.
 */
export class TransportValve extends BaseValve {
  constructor(
    private readonly transports: Readonly<Record<string, Transport>>,
  ) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    const transport = this.transports[input.protocol];
    if (!transport) {
      throw new Error(`Unsupported transport protocol: ${input.protocol}`);
    }
    await transport.invoke(input, output);
  }
}
