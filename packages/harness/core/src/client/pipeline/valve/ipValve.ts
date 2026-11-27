/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IpReportOptions,
  IpResolver,
  ResolvedIp,
} from '../../ip/ipResolver.js';
import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import { isNetworkFailureAbort } from '../../utils/networkUtils.js';
import { runLogger } from '../../../utils/runLogger.js';
import { BaseValve } from './valve.js';
import { ValveError } from './valveError.js';

export class IpValveError extends ValveError {
  readonly resolvedIp?: ResolvedIp;
  readonly presetIp?: string;

  constructor(
    cause: unknown,
    evidence: { resolvedIp?: ResolvedIp; presetIp?: string } = {},
  ) {
    super(cause instanceof Error ? cause.message : String(cause), {
      valveName: 'ip',
      step: 'send',
      cause,
    });
    this.name = 'IpValveError';
    this.resolvedIp = evidence.resolvedIp;
    this.presetIp = evidence.presetIp;
  }
}

export class IpValve extends BaseValve {
  constructor(private readonly ipResolver: IpResolver) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    const presetIp = input.ip;
    let resolvedIp: ResolvedIp | undefined;
    if (presetIp === undefined && input.origin !== undefined) {
      try {
        resolvedIp = await this.ipResolver.resolve(input.origin);
      } catch (error) {
        runLogger.warn('[ip] resolve failed; sending by hostname', {
          origin: input.origin,
          error_type: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    if (resolvedIp) input.setIp(resolvedIp.ip);

    try {
      await this.getNext()!.invoke(input, output);
      resolvedIp?.report({ outcome: 'success' });
    } catch (error) {
      resolvedIp?.report(this.resolveReportOptions(error, input.signal));
      throw new IpValveError(error, { resolvedIp, presetIp });
    } finally {
      if (resolvedIp) input.setIp(undefined);
    }
  }

  private resolveReportOptions(
    error: unknown,
    signal: AbortSignal | undefined,
  ): IpReportOptions {
    if (signal?.aborted && !isNetworkFailureAbort(signal))
      return { outcome: 'success' };
    const statusCode = (error as { statusCode?: unknown } | undefined)
      ?.statusCode;
    return { outcome: typeof statusCode === 'number' ? 'success' : 'failure' };
  }
}
