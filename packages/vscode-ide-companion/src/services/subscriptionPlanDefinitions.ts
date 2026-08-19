/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildProviderTemplate,
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  CODING_PLAN_GLOBAL_BASE_URL,
  computeModelListVersion,
  findProviderByCredentials,
  TOKEN_PLAN_CHINA_BASE_URL,
  TOKEN_PLAN_ENV_KEY,
  TOKEN_PLAN_GLOBAL_BASE_URL,
} from '@qwen-code/qwen-code-core';

export { CODING_PLAN_ENV_KEY, TOKEN_PLAN_ENV_KEY };

export enum CodingPlanRegion {
  CHINA = 'china',
  GLOBAL = 'global',
}

export type SubscriptionPlanId = 'coding' | 'token';
export type SubscriptionPlanRegion = CodingPlanRegion | string;

export interface SubscriptionPlanModelConfig {
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
  generationConfig?: Record<string, unknown>;
}

export type CodingPlanTemplate = SubscriptionPlanModelConfig[];

const TOKEN_PLAN_CHINA_DOC_URL =
  'https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856';
const TOKEN_PLAN_GLOBAL_DOC_URL =
  'https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model';

interface SubscriptionPlanRegionConfig<
  TRegion extends string = SubscriptionPlanRegion,
> {
  id: TRegion;
  title: string;
  endpoint: string;
  documentationUrl?: string;
  apiKeyUrl?: string;
}

export interface SubscriptionPlanDefinition<
  TId extends string = SubscriptionPlanId,
  TRegion extends string = SubscriptionPlanRegion,
> {
  id: TId;
  option: string;
  title: string;
  description: string;
  envKey: string;
  authEventType: 'coding-plan';
  metadataKey: string;
  endpoint?: string;
  documentationUrl?: string;
  apiKeyUrl?: string;
  usageDocumentationUrl?: string;
  defaultRegion?: TRegion;
  regions?: ReadonlyArray<SubscriptionPlanRegionConfig<TRegion>>;
}

export interface SubscriptionPlanConfig {
  id: SubscriptionPlanId;
  option: string;
  displayName: string;
  title: string;
  description: string;
  authEventType: 'coding-plan';
  envKey: string;
  metadataKey: string;
  template: CodingPlanTemplate;
  version: string;
  baseUrl: string;
  region?: CodingPlanRegion;
  documentationUrl?: string;
  apiKeyUrl?: string;
  usageDocumentationUrl?: string;
}

const CODING_PLAN: SubscriptionPlanDefinition<'coding'> = {
  id: 'coding',
  option: 'CODING_PLAN',
  title: 'Coding Plan',
  description: 'For individual developers · Weekly quota included',
  envKey: CODING_PLAN_ENV_KEY,
  authEventType: 'coding-plan',
  metadataKey: 'codingPlan',
  defaultRegion: CodingPlanRegion.CHINA,
  regions: [
    {
      id: CodingPlanRegion.CHINA,
      title: 'China (Beijing)',
      endpoint: CODING_PLAN_CHINA_BASE_URL,
      documentationUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
    },
    {
      id: CodingPlanRegion.GLOBAL,
      title: 'Singapore (International)',
      endpoint: CODING_PLAN_GLOBAL_BASE_URL,
      documentationUrl:
        'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    },
  ],
};

const TOKEN_PLAN: SubscriptionPlanDefinition<'token'> = {
  id: 'token',
  option: 'TOKEN_PLAN',
  title: 'Token Plan',
  description:
    'For teams and companies · Usage-based billing with dedicated endpoint',
  envKey: TOKEN_PLAN_ENV_KEY,
  authEventType: 'coding-plan',
  metadataKey: 'tokenPlan',
  defaultRegion: CodingPlanRegion.CHINA,
  regions: [
    {
      id: CodingPlanRegion.CHINA,
      title: 'China (Beijing)',
      endpoint: TOKEN_PLAN_CHINA_BASE_URL,
      documentationUrl: TOKEN_PLAN_CHINA_DOC_URL,
      apiKeyUrl: TOKEN_PLAN_CHINA_DOC_URL,
    },
    {
      id: CodingPlanRegion.GLOBAL,
      title: 'Singapore (International)',
      endpoint: TOKEN_PLAN_GLOBAL_BASE_URL,
      documentationUrl: TOKEN_PLAN_GLOBAL_DOC_URL,
      apiKeyUrl: TOKEN_PLAN_GLOBAL_DOC_URL,
    },
  ],
  usageDocumentationUrl: TOKEN_PLAN_CHINA_DOC_URL,
};

const SUBSCRIPTION_PLANS = {
  coding: CODING_PLAN,
  token: TOKEN_PLAN,
} as const satisfies Record<SubscriptionPlanId, SubscriptionPlanDefinition>;

export const SUBSCRIPTION_PLAN_OPTIONS: SubscriptionPlanDefinition[] =
  Object.values(SUBSCRIPTION_PLANS);

function resolveSubscriptionPlanRegion(
  plan: SubscriptionPlanDefinition,
  region?: SubscriptionPlanRegion,
): SubscriptionPlanRegionConfig | undefined {
  if (!plan.regions) {
    return undefined;
  }

  return (
    plan.regions.find((candidate) => candidate.id === region) ||
    plan.regions.find((candidate) => candidate.id === plan.defaultRegion) ||
    plan.regions[0]
  );
}

function getSubscriptionPlanEndpoint(
  plan: SubscriptionPlanDefinition,
  region?: SubscriptionPlanRegion,
): string {
  return (
    resolveSubscriptionPlanRegion(plan, region)?.endpoint || plan.endpoint || ''
  );
}

/**
 * Model template and version for a plan, taken from the matching core provider
 * preset.
 *
 * The CLI recomputes the version from that preset on every launch to decide
 * whether a provider update is pending. Deriving both the template and the
 * version here from the same preset keeps this writer from recording a version
 * the CLI can never reproduce — which would surface as an update prompt right
 * after signing in from the IDE — and keeps the persisted model entries from
 * dropping fields the preset carries (modalities, for one).
 */
function resolvePlanTemplate(
  plan: SubscriptionPlanDefinition,
  region?: SubscriptionPlanRegion,
): { template: CodingPlanTemplate; version: string } {
  const endpoint = getSubscriptionPlanEndpoint(plan, region);
  const provider = findProviderByCredentials(endpoint, plan.envKey);
  if (!provider) {
    throw new Error(
      `No core provider preset matches plan "${plan.id}" (baseUrl ${endpoint}, envKey ${plan.envKey}). ` +
        `The IDE and CLI model lists must come from the same preset.`,
    );
  }
  const template = buildProviderTemplate(provider, endpoint);
  return {
    template,
    version: computeModelListVersion(template),
  };
}

export function getSubscriptionPlanConfig(
  planId: SubscriptionPlanId,
  region?: SubscriptionPlanRegion,
): SubscriptionPlanConfig {
  const plan: SubscriptionPlanDefinition = SUBSCRIPTION_PLANS[planId];
  const resolvedRegion = resolveSubscriptionPlanRegion(plan, region);
  const { template, version } = resolvePlanTemplate(plan, resolvedRegion?.id);

  return {
    id: plan.id,
    option: plan.option,
    displayName: plan.title,
    title: plan.title,
    description: plan.description,
    authEventType: plan.authEventType,
    envKey: plan.envKey,
    metadataKey: plan.metadataKey,
    template,
    version,
    baseUrl: getSubscriptionPlanEndpoint(plan, resolvedRegion?.id),
    ...(resolvedRegion
      ? { region: resolvedRegion.id as CodingPlanRegion }
      : {}),
    documentationUrl: resolvedRegion?.documentationUrl || plan.documentationUrl,
    apiKeyUrl: resolvedRegion?.apiKeyUrl || plan.apiKeyUrl,
    usageDocumentationUrl: plan.usageDocumentationUrl,
  };
}

export function findSubscriptionPlanByConfig(
  baseUrl: string | undefined,
  envKey: string | undefined,
):
  | { plan: SubscriptionPlanDefinition; region?: SubscriptionPlanRegion }
  | undefined {
  if (!baseUrl || !envKey) {
    return undefined;
  }

  for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
    if (plan.envKey !== envKey) {
      continue;
    }

    if (plan.regions) {
      const region = plan.regions.find(
        (candidate) => candidate.endpoint === baseUrl,
      );
      if (region) {
        return { plan, region: region.id };
      }
      continue;
    }

    if (plan.endpoint === baseUrl) {
      return { plan };
    }
  }

  return undefined;
}

export function isSubscriptionPlanConfig(
  baseUrl: string | undefined,
  envKey: string | undefined,
): boolean {
  return findSubscriptionPlanByConfig(baseUrl, envKey) !== undefined;
}
