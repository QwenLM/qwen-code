/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compile-time feature flags using Bun's bundle system.
 *
 * When building with `bun build --compile`, features defined as false
 * are completely removed from the output via Dead Code Elimination (DCE).
 *
 * Usage:
 *   import { feature } from './bundle-features.js';
 *   if (feature('VOICE_MODE')) {
 *     // This code is only included when VOICE_MODE is enabled
 *   }
 */

import {
  isInBundledMode,
  isRunningWithBun,
  getRuntimeMode,
} from './bundledMode.js';

// Re-export runtime detection functions from bundledMode.ts
export { isInBundledMode, isRunningWithBun, getRuntimeMode };

// Feature registry - values are set at compile time via --define
export type FeatureName =
  | 'VOICE_MODE'
  | 'TEAMMEM'
  | 'KAIROS'
  | 'COORDINATOR_MODE'
  | 'AGENT_TRIGGERS'
  | 'TRANSCRIPT_CLASSIFIER'
  | 'BASH_CLASSIFIER'
  | 'PROACTIVE'
  | 'FAST_MODE'
  | 'MCP'
  | 'SKILLS'
  | 'CORE';

// Runtime fallback for non-bun environments
const featureDefaults: Record<FeatureName, boolean> = {
  VOICE_MODE: false,
  TEAMMEM: false,
  KAIROS: false,
  COORDINATOR_MODE: false,
  AGENT_TRIGGERS: false,
  TRANSCRIPT_CLASSIFIER: false,
  BASH_CLASSIFIER: false,
  PROACTIVE: false,
  FAST_MODE: false,
  MCP: true,
  SKILLS: true,
  CORE: true,
};

/**
 * Check if a feature is enabled at compile time.
 *
 * In bun builds, this uses the compiled-in value and enables DCE.
 * In node/esbuild, this falls back to runtime check.
 */
export function feature(name: FeatureName): boolean {
  const envKey = `FEATURE_${name}`;

  // Bun compile injects these as literal values via --define
  // At runtime, we check process.env which contains the injected values
  const envValue = process.env[envKey];
  if (envValue !== undefined) {
    // process.env values are always strings, so we check string representations
    return envValue === 'true' || envValue === '1';
  }

  // Fallback to defaults
  return featureDefaults[name] ?? false;
}

/**
 * Get all enabled features for analytics/metadata.
 */
export function getEnabledFeatures(): FeatureName[] {
  return (Object.keys(featureDefaults) as FeatureName[]).filter((f) =>
    feature(f),
  );
}
