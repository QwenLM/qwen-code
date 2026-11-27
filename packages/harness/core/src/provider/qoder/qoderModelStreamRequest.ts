/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ModelInferenceError } from '../modelInferenceError.js';
import type { QoderInferenceBusiness } from '../../qoder/api/client/api/inference/inference.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';

/** The open API consumes a subset of the runtime's existing Qoder context. */
export interface QoderRequestContext {
  readonly identity: {
    readonly sessionId?: string;
    readonly sourceSessionId?: string;
    readonly requestSetId?: string;
    readonly requestId?: string;
  };
  readonly taskRouting?: {
    readonly taskId?: string;
    readonly policyTaskId?: string;
    readonly omitTaskId?: boolean;
  };
  readonly business?: QoderInferenceBusiness;
}

export interface QoderModelStreamRequest extends ModelStreamRequest {
  /** Standalone utility requests can have no parent execution or business. */
  readonly qoder?: QoderRequestContext;
}

/**
 * Snapshot only the consumed attribution fields before inference starts.
 * No account state, global context lookup, or new business ID is introduced.
 */
export function snapshotQoderModelRequest(
  request: ModelStreamRequest,
): QoderModelStreamRequest {
  const context = (request as QoderModelStreamRequest).qoder;
  if (!context) return { ...request };
  const business = context.business;
  if (business && (!business.id?.trim() || !business.type?.trim())) {
    throw new ModelInferenceError(
      'Qoder business attribution requires a non-empty id and type',
      { kind: 'invalid_request', phase: 'before_output' },
    );
  }
  return {
    ...request,
    qoder: Object.freeze({
      identity: Object.freeze({ ...context.identity }),
      ...(context.taskRouting
        ? { taskRouting: Object.freeze({ ...context.taskRouting }) }
        : {}),
      ...(business
        ? {
            business: Object.freeze({
              id: business.id,
              type: business.type,
              ...(business.sub_task !== undefined
                ? { sub_task: business.sub_task }
                : {}),
              ...(business.model_key !== undefined
                ? { model_key: business.model_key }
                : {}),
            }),
          }
        : {}),
    }),
  };
}
