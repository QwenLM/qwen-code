/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthClient } from 'google-auth-library';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { CodeAssistServer, type HttpOptions } from './server.js';
import {
  UserTierId,
  IneligibleTierReasonCode,
  type ClientMetadata,
  type GeminiUserTier,
  type IneligibleTier,
  type LoadCodeAssistResponse,
  type LongRunningOperationResponse,
  type OnboardUserRequest,
} from './types.js';

const debugLogger = createDebugLogger('CODE_ASSIST');
const SETUP_CACHE_TTL_MS = 30_000;
const SETUP_DEADLINE_MS = 60_000;
const OPERATION_POLL_MS = 5_000;

export class ProjectIdRequiredError extends Error {
  constructor() {
    super(
      'This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set to a string-based Google Cloud project ID.',
    );
    this.name = 'ProjectIdRequiredError';
  }
}

export class InvalidNumericProjectIdError extends Error {
  constructor(projectId: string) {
    super(
      `Invalid Google Cloud Project ID: "${projectId}". Use the string-based project ID, not the numeric project number.`,
    );
    this.name = 'InvalidNumericProjectIdError';
  }
}

export class ValidationRequiredError extends Error {
  constructor(
    message: string,
    readonly validationLink?: string,
    readonly validationDescription?: string,
  ) {
    super(message);
    this.name = 'ValidationRequiredError';
  }
}

export class IneligibleTierError extends Error {
  constructor(readonly ineligibleTiers: IneligibleTier[]) {
    super(
      ineligibleTiers
        .map((tier) => tier.reasonMessage)
        .filter((reason): reason is string => !!reason)
        .join(', ') || 'This account is not eligible for Code Assist.',
    );
    this.name = 'IneligibleTierError';
  }
}

export interface UserData {
  projectId: string;
  userTier: UserTierId;
  userTierName?: string;
  paidTier?: GeminiUserTier;
  hasOnboardedPreviously?: boolean;
}

type SetupCacheEntry = {
  expiresAt: number;
  promise: Promise<UserData>;
};

let userDataCache = new WeakMap<
  AuthClient,
  Map<string | undefined, SetupCacheEntry>
>();

/** @internal */
export function resetUserDataCacheForTesting(): void {
  userDataCache = new WeakMap();
}

export async function setupUser(
  client: AuthClient,
  config: Config,
  httpOptions: HttpOptions = {},
  signal?: AbortSignal,
): Promise<UserData> {
  signal?.throwIfAborted();
  const projectId =
    process.env['GOOGLE_CLOUD_PROJECT']?.trim() ||
    process.env['GOOGLE_CLOUD_PROJECT_ID']?.trim() ||
    undefined;

  if (projectId && /^\d+$/.test(projectId)) {
    throw new InvalidNumericProjectIdError(projectId);
  }

  let projectCache = userDataCache.get(client);
  if (!projectCache) {
    projectCache = new Map();
    userDataCache.set(client, projectCache);
  }
  const cached = projectCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    return withCallerAbort(cached.promise, signal);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error('Code Assist setup timed out after 60 seconds.'),
    );
  }, SETUP_DEADLINE_MS);
  timer.unref();
  const entry: SetupCacheEntry = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise: doSetupUser(
      client,
      projectId,
      config,
      httpOptions,
      controller.signal,
    ).finally(() => clearTimeout(timer)),
  };
  projectCache.set(projectId, entry);
  void entry.promise.then(
    () => {
      if (projectCache.get(projectId) === entry) {
        entry.expiresAt = Date.now() + SETUP_CACHE_TTL_MS;
      }
    },
    () => {
      if (projectCache.get(projectId) === entry) {
        projectCache.delete(projectId);
      }
    },
  );
  return withCallerAbort(entry.promise, signal);
}

function withCallerAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let onAbort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  cancelled.catch(() => undefined);
  return Promise.race([promise, cancelled]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

async function doSetupUser(
  client: AuthClient,
  projectId: string | undefined,
  config: Config,
  httpOptions: HttpOptions,
  signal: AbortSignal,
): Promise<UserData> {
  const caServer = new CodeAssistServer(client, projectId, httpOptions, config);
  const coreClientMetadata: ClientMetadata = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  };

  const loadRes = await caServer.loadCodeAssist(
    {
      cloudaicompanionProject: projectId,
      metadata: {
        ...coreClientMetadata,
        duetProject: projectId,
      },
    },
    signal,
  );
  validateLoadCodeAssistResponse(loadRes);

  if (loadRes.currentTier || loadRes.paidTier) {
    const selectedTier = loadRes.paidTier?.id
      ? loadRes.paidTier
      : loadRes.currentTier;
    if (!selectedTier?.id) {
      debugLogger.warn(
        'Code Assist did not return a user tier ID; using STANDARD.',
      );
    }
    const selectedProject = loadRes.cloudaicompanionProject || projectId;
    if (!selectedProject) {
      throwIneligibleOrProjectIdError(loadRes);
    }
    return {
      projectId: selectedProject,
      userTier: selectedTier?.id ?? UserTierId.STANDARD,
      userTierName: selectedTier?.name,
      paidTier: loadRes.paidTier ?? undefined,
      hasOnboardedPreviously:
        loadRes.currentTier?.hasOnboardedPreviously ??
        loadRes.paidTier?.hasOnboardedPreviously ??
        true,
    };
  }

  const tier = getOnboardTier(loadRes);
  const tierId = tier.id ?? UserTierId.STANDARD;
  if (!tier.id) {
    debugLogger.warn(
      'Code Assist did not return an onboarding tier ID; using STANDARD.',
    );
  }
  if (tier.userDefinedCloudaicompanionProject && !projectId) {
    throw new ProjectIdRequiredError();
  }

  const onboardReq: OnboardUserRequest =
    tierId === UserTierId.FREE
      ? {
          tierId,
          cloudaicompanionProject: undefined,
          metadata: coreClientMetadata,
        }
      : {
          tierId,
          cloudaicompanionProject: projectId,
          metadata: {
            ...coreClientMetadata,
            duetProject: projectId,
          },
        };

  let lroRes = await caServer.onboardUser(onboardReq, signal);
  while (!lroRes.done) {
    checkOperationError(lroRes);
    if (!lroRes.name) {
      throw new Error(
        'Code Assist onboarding did not complete and returned no operation name.',
      );
    }
    await delay(OPERATION_POLL_MS, signal);
    lroRes = await caServer.getOperation(lroRes.name, signal);
  }
  checkOperationError(lroRes);

  const managedProject = lroRes.response?.cloudaicompanionProject?.id;
  if (tierId === UserTierId.FREE && !managedProject) {
    throw new Error(
      'Code Assist free-tier onboarding returned no managed project ID.',
    );
  }
  const selectedProject = managedProject || projectId;
  if (!selectedProject) {
    throwIneligibleOrProjectIdError(loadRes);
  }
  return {
    projectId: selectedProject,
    userTier: tierId,
    userTierName: tier.name,
    hasOnboardedPreviously: tier.hasOnboardedPreviously ?? false,
  };
}

function checkOperationError(lroRes: LongRunningOperationResponse): void {
  if (lroRes.error) {
    throw new Error(
      `Code Assist onboarding failed: ${lroRes.error.message ?? 'unknown error'}`,
    );
  }
}

function throwIneligibleOrProjectIdError(res: LoadCodeAssistResponse): never {
  if (res.ineligibleTiers && res.ineligibleTiers.length > 0) {
    throw new IneligibleTierError(res.ineligibleTiers);
  }
  throw new ProjectIdRequiredError();
}

function getOnboardTier(res: LoadCodeAssistResponse): GeminiUserTier {
  for (const tier of res.allowedTiers || []) {
    if (tier.isDefault) return tier;
  }
  if (res.ineligibleTiers?.length) {
    throw new IneligibleTierError(res.ineligibleTiers);
  }
  return {
    name: '',
    description: '',
    id: UserTierId.LEGACY,
    userDefinedCloudaicompanionProject: true,
  };
}

function validateLoadCodeAssistResponse(res: LoadCodeAssistResponse): void {
  if (!res) {
    throw new Error('LoadCodeAssist returned an empty response.');
  }
  if (
    !res.currentTier &&
    !res.paidTier &&
    res.ineligibleTiers &&
    res.ineligibleTiers.length > 0
  ) {
    const validationTier = res.ineligibleTiers.find(
      (tier) =>
        tier.reasonCode === IneligibleTierReasonCode.VALIDATION_REQUIRED,
    );
    if (validationTier) {
      const message =
        validationTier.reasonMessage ??
        validationTier.validationErrorMessage ??
        'Verify this account';
      const instruction = validationTier.validationUrl
        ? `Complete ${validationTier.validationUrl} and sign in again.`
        : 'Complete account validation and sign in again.';
      throw new ValidationRequiredError(
        `Account validation required: ${message}. ${instruction}`,
        validationTier.validationUrl,
        message,
      );
    }
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
