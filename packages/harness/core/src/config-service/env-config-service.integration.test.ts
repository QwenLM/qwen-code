/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvConfigService } from './env-config-service.js';
import { installConfigService, stopConfigService } from './index.js';
import { getAutoMemoryFeatureGateConfig } from './features/autoMemory.js';
import { getAutoMemoryPolicyConfig } from './features/autoMemoryPolicy.js';
import { isAutoDreamFeatureGateEnabled } from './features/autoDream.js';
import {
  getCodeModeFeatureConfig,
  CODE_MODE_FEATURE_ENV,
} from './features/codeMode.js';
import { getCodebaseBackflowConfig } from './features/codebaseBackflow.js';
import { isContextWindowSelectionEnabled } from './features/contextWindowSelection.js';
import { isLegacyInferDomainFailoverEnabledByFeatureGate } from './features/legacyInferDomainFailover.js';
import { getModelRequestZstdConfig } from './features/modelRequestZstd.js';
import { getModelStreamDiagnosticsConfig } from './features/modelStreamDiagnostics.js';
import { isPowerShellToolQcsEnabled } from './features/powerShellTool.js';
import { getPromptSuggestionFeatureConfig } from './features/promptSuggestion.js';
import { resolveReadPartialGate } from './features/readPartial.js';
import { getAutoCompactModelThresholdCap } from '../compression-v2/config/autoCompactModelThresholdCaps.js';

afterEach(async () => {
  await stopConfigService();
});

describe('EnvConfigService feature defaults with real consumers', () => {
  it('enables memory consumption, turn-complete generation and Dream without environment setup', () => {
    installConfigService(new EnvConfigService({ environment: {} }));

    expect(getAutoMemoryFeatureGateConfig()).toEqual({
      projectEnabled: true,
      userEnabled: true,
    });
    expect(getAutoMemoryPolicyConfig()).toEqual({
      enabled: true,
      extractionEveryNTurns: 1,
    });
    expect(isAutoDreamFeatureGateEnabled()).toBe(true);
  });

  it('enables the other feature gates without inventing thresholds or organization targets', () => {
    vi.stubEnv(CODE_MODE_FEATURE_ENV, undefined);
    vi.stubEnv('QWEN_FEATURE_CODEBASE_BACKFLOW', undefined);
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODIES', undefined);
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    installConfigService(new EnvConfigService({ environment: {} }));

    expect(getCodeModeFeatureConfig()).toEqual({
      enabled: true,
      defaultMode: 'on',
    });
    expect(getCodebaseBackflowConfig()).toEqual({
      enabled: true,
      allowedOrgIds: [],
    });
    expect(isContextWindowSelectionEnabled()).toBe(true);
    expect(isLegacyInferDomainFailoverEnabledByFeatureGate()).toBe(true);
    expect(getModelRequestZstdConfig()).toMatchObject({
      enabled: true,
      transports: ['legacy'],
      minBodyChars: 4096,
      level: 1,
    });
    expect(getModelStreamDiagnosticsConfig()).toMatchObject({ enabled: true });
    expect(isPowerShellToolQcsEnabled()).toBe(true);
    expect(getPromptSuggestionFeatureConfig()).toEqual({
      enabled: true,
      mode: 'shared',
      forkEnabled: true,
    });
    expect(resolveReadPartialGate(true).enabled).toBe(true);
    expect(resolveReadPartialGate(false).enabled).toBe(false);
    expect(getAutoCompactModelThresholdCap('unknown-model')).toBeUndefined();
  });

  it('honors explicit environment disabling and a custom extraction interval', () => {
    const environment: NodeJS.ProcessEnv = {
      QWEN_CONFIG_AUTO_MEMORY: '{"project_enabled":false,"user_enabled":false}',
      QWEN_CONFIG_AUTO_MEMORY_POLICY:
        '{"enabled":false,"extraction_every_n_turns":1}',
      QWEN_CONFIG_AUTO_DREAM: '{"enabled":false}',
    };
    installConfigService(new EnvConfigService({ environment }));

    expect(getAutoMemoryFeatureGateConfig()).toEqual({
      projectEnabled: false,
      userEnabled: false,
    });
    expect(getAutoMemoryPolicyConfig().enabled).toBe(false);
    expect(isAutoDreamFeatureGateEnabled()).toBe(false);

    environment['QWEN_CONFIG_AUTO_MEMORY_POLICY'] =
      '{"enabled":true,"extraction_every_n_turns":3}';
    expect(getAutoMemoryPolicyConfig()).toEqual({
      enabled: true,
      extractionEveryNTurns: 3,
    });
  });
});
