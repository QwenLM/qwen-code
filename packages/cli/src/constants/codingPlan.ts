/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ProviderModelConfig as ModelConfig } from '@qwen-code/qwen-code-core';

/**
 * Coding plan regions
 */
export enum CodingPlanRegion {
  CHINA = 'china',
  GLOBAL = 'global',
}

/**
 * Coding plan template - array of model configurations
 * When user provides an api-key, these configs will be cloned with envKey pointing to the stored api-key
 */
export type CodingPlanTemplate = ModelConfig[];

/**
 * Environment variable key for storing the coding plan API key.
 * Unified key for both regions since they are mutually exclusive.
 */
export const CODING_PLAN_ENV_KEY = 'BAILIAN_CODING_PLAN_API_KEY';

/**
 * Computes the version hash for the coding plan template.
 * Uses SHA256 of the JSON-serialized template for deterministic versioning.
 * @param template - The template to compute version for
 * @returns Hexadecimal string representing the template version
 */
export function computeCodingPlanVersion(template: CodingPlanTemplate): string {
  const templateString = JSON.stringify(template);
  return createHash('sha256').update(templateString).digest('hex');
}

/**
 * Generate the complete coding plan template for a specific region.
 * China region uses legacy description to maintain backward compatibility.
 * Global region uses new description with region indicator.
 * @param region - The region to generate template for
 * @returns Complete model configuration array for the region
 */
export function generateCodingPlanTemplate(
  region: CodingPlanRegion,
): CodingPlanTemplate {
  if (region === CodingPlanRegion.CHINA) {
    // China region uses legacy fields to maintain backward compatibility
    // This ensures existing users don't get prompted for unnecessary updates
    return [
      {
        id: 'qwen3.5-plus',
        name: 'qwen3.5-plus',
        description:
          'qwen3.5-plus model with thinking enabled from Bailian Coding Plan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
        },
      },
      {
        id: 'qwen3-coder-plus',
        name: 'qwen3-coder-plus',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        description: 'qwen3-coder-plus model from Bailian Coding Plan',
        envKey: CODING_PLAN_ENV_KEY,
      },
      {
        id: 'qwen3-coder-next',
        name: 'qwen3-coder-next',
        description:
          'qwen3-coder-next model with thinking enabled from Bailian Coding Plan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
        },
      },
      {
        id: 'qwen3-max-2026-01-23',
        name: 'qwen3-max-2026-01-23',
        description:
          'qwen3-max model with thinking enabled from Bailian Coding Plan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
        },
      },
      {
        id: 'glm-4.7',
        name: 'glm-4.7',
        description:
          'glm-4.7 model with thinking enabled from Bailian Coding Plan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
        },
      },
      {
        id: 'kimi-k2.5',
        name: 'kimi-k2.5',
        description:
          'kimi-k2.5 model with thinking enabled from Bailian Coding Plan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
        },
      },
    ];
  }

  // Global region uses new description with region indicator
  return [
    {
      id: 'qwen3.5-plus',
      name: 'qwen3.5-plus',
      description:
        'qwen3.5-plus model with thinking enabled from Coding Plan (Global/Intl)',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
      },
    },
    {
      id: 'qwen3-coder-plus',
      name: 'qwen3-coder-plus',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      description: 'qwen3-coder-plus model from Coding Plan (Global/Intl)',
      envKey: CODING_PLAN_ENV_KEY,
    },
    {
      id: 'qwen3-max-2026-01-23',
      name: 'qwen3-max-2026-01-23',
      description:
        'qwen3-max model with thinking enabled from Coding Plan (Global/Intl)',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
      },
    },
  ];
}

/**
 * Get the complete configuration for a specific region.
 * @param region - The region to use
 * @returns Object containing template, baseUrl, and version
 */
export function getCodingPlanConfig(region: CodingPlanRegion) {
  const template = generateCodingPlanTemplate(region);
  const baseUrl =
    region === CodingPlanRegion.CHINA
      ? 'https://coding.dashscope.aliyuncs.com/v1'
      : 'https://coding-intl.dashscope.aliyuncs.com/v1';
  const regionName =
    region === CodingPlanRegion.CHINA
      ? 'Coding Plan (Bailian, China)'
      : 'Coding Plan (Bailian, Global/Intl)';

  return {
    template,
    baseUrl,
    regionName,
    version: computeCodingPlanVersion(template),
  };
}

/**
 * Get all unique base URLs for coding plan (used for filtering/config detection).
 * @returns Array of base URLs
 */
export function getCodingPlanBaseUrls(): string[] {
  return [
    'https://coding.dashscope.aliyuncs.com/v1',
    'https://coding-intl.dashscope.aliyuncs.com/v1',
  ];
}

/**
 * Check if a config belongs to Coding Plan (any region).
 * Returns the region if matched, or false if not a Coding Plan config.
 * @param baseUrl - The baseUrl to check
 * @param envKey - The envKey to check
 * @returns The region if matched, false otherwise
 */
export function isCodingPlanConfig(
  baseUrl: string | undefined,
  envKey: string | undefined,
): CodingPlanRegion | false {
  if (!baseUrl || !envKey) {
    return false;
  }

  // Must use the unified envKey
  if (envKey !== CODING_PLAN_ENV_KEY) {
    return false;
  }

  // Check which region's baseUrl matches
  if (baseUrl === 'https://coding.dashscope.aliyuncs.com/v1') {
    return CodingPlanRegion.CHINA;
  }
  if (baseUrl === 'https://coding-intl.dashscope.aliyuncs.com/v1') {
    return CodingPlanRegion.GLOBAL;
  }

  return false;
}

/**
 * Get region from baseUrl.
 * @param baseUrl - The baseUrl to check
 * @returns The region if matched, null otherwise
 */
export function getRegionFromBaseUrl(
  baseUrl: string | undefined,
): CodingPlanRegion | null {
  if (!baseUrl) return null;

  if (baseUrl === 'https://coding.dashscope.aliyuncs.com/v1') {
    return CodingPlanRegion.CHINA;
  }
  if (baseUrl === 'https://coding-intl.dashscope.aliyuncs.com/v1') {
    return CodingPlanRegion.GLOBAL;
  }

  return null;
}
