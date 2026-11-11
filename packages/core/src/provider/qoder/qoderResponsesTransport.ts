/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QoderClient } from '../../qoder/api/client/qoderClient.js';
import type { ModelStreamEvent } from '../event/modelStreamEvent.js';
import type { ModelTransport } from '../transport/modelTransport.js';
import { OPENAI_RESPONSES } from '../transport/modelProtocol.js';
import { buildResponsesStreamReq } from '../transport/impl/responses-factory/request/responsesStreamReqFactory.js';
import { buildResponsesStreamEvents } from '../transport/impl/responses-factory/response/responsesStreamRespFactory.js';
import type { QoderModelStreamRequest } from './qoderModelStreamRequest.js';

/** Responses codecs are shared; the Qoder API handoff stays service-specific. */
export class QoderResponsesTransport implements ModelTransport {
  readonly protocol = OPENAI_RESPONSES;

  async *stream(
    client: QoderClient,
    request: QoderModelStreamRequest,
  ): AsyncGenerator<ModelStreamEvent> {
    const context = request.qoder;
    const frames = client.api.inference.stream(
      {
        body: buildResponsesStreamReq(request),
        sessionId: context?.identity.sessionId,
        sourceSessionId: context?.identity.sourceSessionId,
        requestSetId: context?.identity.requestSetId,
        requestId: context?.identity.requestId,
        taskId: context?.taskRouting?.omitTaskId
          ? undefined
          : (context?.taskRouting?.taskId ??
            context?.taskRouting?.policyTaskId),
        business: context?.business,
        contextLength: request.resolution.config.context?.contextWindow,
      },
      { signal: request.control?.signal },
    );
    yield* buildResponsesStreamEvents(frames);
  }
}
