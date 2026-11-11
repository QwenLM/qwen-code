/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import type { Transport } from '../../../client/transport/transport.js';
import { getVersionSync } from '../../../utils/version.js';
import type { QoderAccountRegion } from '../regions.js';
import {
  resolveQoderAccountRegion,
  resolveQoderRegionEndpoints,
} from '../regions.js';
import {
  QoderCredentialStore,
  type QoderCredentialStoreOptions,
} from '../credential-store.js';
import { QoderTokenManager } from '../token-manager.js';
import type { QoderApi } from './api/qoder.js';
import { QoderAuthApiImpl } from './impl/auth/auth.js';
import { QoderInferenceApiImpl } from './impl/inference/inference.js';
import { QoderModelsApiImpl } from './impl/models/models.js';
import { buildQoderOutboundPipeline } from './pipeline/outboundPipelineFactory.js';
import type { QoderTokenProvider } from './pipeline/valve/authValve.js';
import type { QoderClient } from './qoderClient.js';
import { QoderClientImpl } from './qoderClientImpl.js';

export interface CreateQoderClientOptions {
  /** Defaults to the build's account region, overridable via env. */
  readonly region?: QoderAccountRegion;
  readonly credentialStore?: QoderCredentialStore;
  readonly credentialStoreOptions?: QoderCredentialStoreOptions;
  /** Production token source; when omitted a manager is created from the store. */
  readonly tokenManager?: QoderTokenManager;
  /** Structural override for the pipeline's bearer source (tests/embedders). */
  readonly tokenProvider?: QoderTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly clientId?: string;
  readonly requestTimeoutMs?: number;
  readonly gatewayBaseUrl?: string;
  readonly clientVersion?: string;
  readonly generateId?: () => string;
  /** Wire transport override; production and tests both go through the pipeline. */
  readonly transport?: Transport;
}

/**
 * Compose a Qoder client for builds that talk to the Qoder gateway directly:
 * account login, qcode model catalog, and Responses inference share one
 * outbound pipeline.
 */
export function createQoderClient(
  options: CreateQoderClientOptions = {},
): QoderClient {
  const env = options.env ?? process.env;
  const region = options.region ?? resolveQoderAccountRegion(env);
  const credentials =
    options.credentialStore ??
    new QoderCredentialStore({
      ...options.credentialStoreOptions,
      ...(options.now ? { now: options.now } : {}),
    });
  const tokenProvider =
    options.tokenManager ??
    options.tokenProvider ??
    QoderTokenManager.forRegion(region, {
      credentialStore: credentials,
      ...(options.now ? { now: options.now } : {}),
    });
  const clientVersion = options.clientVersion ?? getVersionSync() ?? 'dev';
  const gatewayBaseUrl = (
    options.gatewayBaseUrl ??
    resolveQoderRegionEndpoints(region, env).gatewayBaseUrl
  ).replace(/\/+$/, '');
  const generateId = options.generateId ?? randomUUID;
  const pipeline = buildQoderOutboundPipeline({
    tokenProvider,
    attribution: {
      clientVersion,
      generateId,
    },
    ...(options.transport ? { transport: options.transport } : {}),
  });

  const api: QoderApi = {
    auth: new QoderAuthApiImpl({
      region,
      credentialStore: credentials,
      tokenProvider,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    }),
    models: new QoderModelsApiImpl(pipeline, { gatewayBaseUrl }),
    inference: new QoderInferenceApiImpl(pipeline, {
      gatewayBaseUrl,
      generateId,
    }),
  };

  return new QoderClientImpl(api, tokenProvider);
}
