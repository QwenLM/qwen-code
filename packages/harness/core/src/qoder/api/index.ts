/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Qoder account and gateway API.
 *
 * Boundaries:
 * - regions: account region and endpoint value objects;
 * - account/credential-store: account domain and its file repository;
 * - oauth-client: wire endpoints for the device flow;
 * - auth-service: login orchestration, login-state checks, refresh;
 * - token-manager: cross-process token access for inference;
 * - model-catalog: qcode catalog mapping;
 * - client: QoderClient facade, API impls, and the outbound pipeline.
 */

export type {
  QoderAccountRegion,
  QoderRegionEndpoints,
} from './regions.js';
export {
  QODER_ACCOUNT_REGIONS,
  QODER_AGENT_ID,
  QODER_CLIENT_ID,
  QODER_CLIENT_TYPE,
  QODER_ENV_ACCOUNT_REGION,
  QODER_ENV_AUTH_BASE_URL,
  QODER_ENV_GATEWAY_BASE_URL,
  QODER_ENV_OAUTH_CLIENT_ID,
  QODER_ENV_OPENAPI_BASE_URL,
  QODER_REGION_ENDPOINTS,
  QODER_SESSION_TYPE,
  isQoderAccountRegion,
  resolveQoderAccountRegion,
  resolveQoderClientId,
  resolveQoderRegionEndpoints,
} from './regions.js';

export type {
  QoderAccountInput,
  QoderAccountRecord,
  QoderAccountSummary,
  QoderCredentialsSnapshot,
} from './account.js';
export { QODER_CREDENTIAL_VERSION, toQoderAccountSummary } from './account.js';
export type { QoderCredentialStoreOptions } from './credential-store.js';
export {
  QoderCredentialError,
  QoderCredentialStore,
  getQoderCredentialsPath,
  hasQoderStoredAccount,
  readQoderCredentials,
  writeQoderCredentials,
} from './credential-store.js';

export type {
  QoderDeviceAuthorization,
  QoderDevicePollResult,
  QoderOAuthClientOptions,
  QoderOAuthErrorCode,
  QoderOAuthRequestOptions,
  QoderTokenResponse,
  QoderUserProfile,
} from './oauth-client.js';
export { QoderOAuthClient, QoderOAuthError } from './oauth-client.js';

export type {
  QoderAccessToken,
  QoderAuthRequestOptions,
  QoderAuthServiceOptions,
  QoderAuthState,
  QoderAuthStatus,
  QoderDeviceLoginHandle,
  QoderDeviceLoginOptions,
  QoderLoginResult,
} from './auth-service.js';
export {
  ensureQoderAccessToken,
  getQoderAuthStatus,
  listQoderAccounts,
  refreshQoderAccount,
  resetQoderRefreshInFlightForTests,
  startQoderDeviceLogin,
} from './auth-service.js';

export type { QoderTokenManagerOptions } from './token-manager.js';
export { QoderTokenManager } from './token-manager.js';

export type {
  QoderModelCatalogEntry,
  QoderModelReasoningConfig,
} from './model-catalog.js';
export {
  QoderModelCatalogError,
  mapQoderModelCatalog,
} from './model-catalog.js';

export type { QoderClient } from './client/qoderClient.js';
export type { CreateQoderClientOptions } from './client/qoderClientFactory.js';
export { createQoderClient } from './client/qoderClientFactory.js';
export type {
  QoderApi,
  QoderAuthApi,
  QoderInferenceApi,
  QoderInferenceRequest,
  QoderInferenceBusiness,
  QoderInferenceStreamOptions,
  QoderLoginOptions,
  QoderModelsApi,
  QoderModelsListOptions,
} from './client/api/qoder.js';
export { QoderInferenceError } from './client/api/inference/inference.js';
export {
  createQoderModelResolver,
  toQoderModel,
} from './model-resolver.js';
export type { QoderTokenProvider } from './client/pipeline/valve/authValve.js';
