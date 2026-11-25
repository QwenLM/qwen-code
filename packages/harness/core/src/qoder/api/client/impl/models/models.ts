/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientError } from '../../../../../client/clientError.js';
import { runLogger } from '../../../../../utils/runLogger.js';
import type {
  QoderModelsApi,
  QoderModelsListOptions,
} from '../../api/models/models.js';
import type { QoderOutboundPipeline } from '../../pipeline/qoderOutboundPipeline.js';
import { QoderRequestBuilder } from '../../request/qoderRequest.js';
import {
  mapQoderModelCatalog,
  type QoderModelCatalogEntry,
} from '../../../model-catalog.js';

const MODEL_LIST_PATH = '/api/v3/model/list';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface QoderModelsApiOptions {
  readonly gatewayBaseUrl: string;
}

/** qcode model catalog adapter over the shared Qoder outbound pipeline. */
export class QoderModelsApiImpl implements QoderModelsApi {
  constructor(
    private readonly pipeline: QoderOutboundPipeline,
    private readonly options: QoderModelsApiOptions,
  ) {}

  async list(
    options: QoderModelsListOptions = {},
  ): Promise<QoderModelCatalogEntry[]> {
    const request = QoderRequestBuilder.builder()
      .operation('models.list')
      .path(MODEL_LIST_PATH)
      .query({ categories: 'qcode' })
      .origin(this.options.gatewayBaseUrl)
      .requireLogin()
      .signal(options.signal)
      .timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      .build();

    let response;
    try {
      response = await this.pipeline.execute(request);
    } catch (error) {
      runLogger.warn('[qoder-models] model list request failed', {
        requestId: request.headers['X-Request-Id'],
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const raw = response.raw;
    const requestId =
      response.requestId || request.headers['X-Request-Id'];
    runLogger.debug('[qoder-models] response headers', {
      requestId,
      status: raw?.status,
      url: raw?.url,
    });
    if (!raw) {
      throw new ClientError(
        `models.list: no response (requestId=${requestId ?? 'unknown'})`,
        {
          operation: 'models.list',
        },
      );
    }
    if (!raw.ok) {
      const responseBody = await raw.text().catch(() => '');
      const detail = responseBody.trim()
        ? `: ${responseBody.slice(0, 300)}`
        : '';
      runLogger.warn('[qoder-models] model list failed', {
        requestId,
        status: raw.status,
        url: raw.url,
      });
      throw new ClientError(
        `models.list: HTTP ${raw.status} (${raw.url}) requestId=${requestId ?? 'unknown'}${detail}`,
        {
          operation: 'models.list',
          statusCode: raw.status,
          responseBody: responseBody.slice(0, 64_000),
        },
      );
    }
    return mapQoderModelCatalog(await response.json<unknown>());
  }
}
