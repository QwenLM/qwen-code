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
        name: '[Bailian Coding Plan] qwen3.5-plus',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
          contextWindowSize: 1000000,
        },
      },
      {
        id: 'qwen3-coder-plus',
        name: '[Bailian Coding Plan] qwen3-coder-plus',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          contextWindowSize: 1000000,
        },
      },
      {
        id: 'qwen3-coder-next',
        name: '[Bailian Coding Plan] qwen3-coder-next',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          contextWindowSize: 262144,
        },
      },
      {
        id: 'qwen3-max-2026-01-23',
        name: '[Bailian Coding Plan] qwen3-max-2026-01-23',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
          contextWindowSize: 262144,
        },
      },
      {
        id: 'glm-4.7',
        name: '[Bailian Coding Plan] glm-4.7',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
          contextWindowSize: 202752,
        },
      },
      {
        id: 'glm-5',
        name: '[Bailian Coding Plan] glm-5',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
          contextWindowSize: 202752,
        },
      },
      {
        id: 'MiniMax-M2.5',
        name: '[Bailian Coding Plan] MiniMax-M2.5',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
          contextWindowSize: 1000000,
        },
      },
      {
        id: 'kimi-k2.5',
        name: '[Bailian Coding Plan] kimi-k2.5',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
        generationConfig: {
          extra_body: {
            enable_thinking: true,
          },
          contextWindowSize: 262144,
        },
      },
    ];
  }

  // Global region uses Bailian Coding Plan branding for Global/Intl
  return [
    {
      id: 'qwen3.5-plus',
      name: '[Bailian Coding Plan for Global/Intl] qwen3.5-plus',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
        contextWindowSize: 1000000,
      },
    },
    {
      id: 'qwen3-coder-plus',
      name: '[Bailian Coding Plan for Global/Intl] qwen3-coder-plus',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        contextWindowSize: 1000000,
      },
    },
    {
      id: 'qwen3-coder-next',
      name: '[Bailian Coding Plan for Global/Intl] qwen3-coder-next',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        contextWindowSize: 262144,
      },
    },
    {
      id: 'qwen3-max-2026-01-23',
      name: '[Bailian Coding Plan for Global/Intl] qwen3-max-2026-01-23',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
        contextWindowSize: 262144,
      },
    },
    {
      id: 'glm-4.7',
      name: '[Bailian Coding Plan for Global/Intl] glm-4.7',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
        contextWindowSize: 202752,
      },
    },
    {
      id: 'glm-5',
      name: '[Bailian Coding Plan for Global/Intl] glm-5',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
        contextWindowSize: 202752,
      },
    },
    {
      id: 'MiniMax-M2.5',
      name: '[Bailian Coding Plan for Global/Intl] MiniMax-M2.5',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
        contextWindowSize: 1000000,
      },
    },
    {
      id: 'kimi-k2.5',
      name: '[Bailian Coding Plan for Global/Intl] kimi-k2.5',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      envKey: CODING_PLAN_ENV_KEY,
      generationConfig: {
        extra_body: {
          enable_thinking: true,
        },
        contextWindowSize: 262144,
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
