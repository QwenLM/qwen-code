/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EndpointReportOptions,
  EndpointResolver,
} from '../../endpoint/endpointResolver.js';
import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import { isNetworkFailureAbort } from '../../utils/networkUtils.js';
import { collectErrorObjects } from '../../../utils/errors.js';
import { BaseValve } from './valve.js';
import { IpValveError } from './ipValve.js';
import { ValveError } from './valveError.js';

export class EndpointValve extends BaseValve {
  constructor(private readonly resolver: EndpointResolver) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    const presetOrigin = input.origin;
    const resolvedEndpoint =
      presetOrigin !== undefined
        ? undefined
        : await this.resolver.resolve(input.endpointType);

    if (presetOrigin === undefined && resolvedEndpoint === undefined) {
      throw new ValveError(
        `cannot resolve endpoint for ${String(input.endpointType)}`,
        { valveName: 'endpoint', step: 'resolve' },
      );
    }

    if (resolvedEndpoint) input.setOrigin(resolvedEndpoint.origin);

    try {
      await this.getNext()!.invoke(input, output);
      resolvedEndpoint?.report({ outcome: 'success' });
    } catch (error) {
      resolvedEndpoint?.report(this.resolveReportOptions(error, input.signal));
      throw error instanceof IpValveError ? error.cause : error;
    } finally {
      if (resolvedEndpoint) input.setOrigin(undefined);
    }
  }

  private resolveReportOptions(
    error: unknown,
    signal: AbortSignal | undefined,
  ): EndpointReportOptions {
    if (signal?.aborted && !isNetworkFailureAbort(signal))
      return { outcome: 'success' };
    for (const obj of collectErrorObjects(error)) {
      const status = (obj as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number') return { outcome: 'success' };
    }
    if (
      error instanceof IpValveError &&
      (error.resolvedIp !== undefined || error.presetIp !== undefined)
    )
      return { outcome: 'success' };
    return { outcome: 'failure' };
  }
}
