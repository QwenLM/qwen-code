/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CustomOutboundPipeline } from '../../../../client/pipeline/customOutboundPipeline.js';
import type { QoderRequest } from '../request/qoderRequest.js';
import type { QoderResponse } from '../response/qoderResponse.js';

/**
 * The Qoder-specific outbound pipeline: narrows the base pipeline contract to
 * {@link QoderRequest} / {@link QoderResponse}.
 */
export class QoderOutboundPipeline extends CustomOutboundPipeline {
  constructor(initialOutput: () => QoderResponse) {
    super(initialOutput);
  }

  override async execute(input: QoderRequest): Promise<QoderResponse> {
    return super.execute(input) as Promise<QoderResponse>;
  }

  override async invoke(
    input: QoderRequest,
    output: QoderResponse,
  ): Promise<void> {
    await super.invoke(input, output);
  }
}
