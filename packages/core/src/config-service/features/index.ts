/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { registerAutoCompactModelThresholdCapsFeature } from '../../compression-v2/config/autoCompactModelThresholdCaps.js';
import { registerEchoFeature } from './echo.js';
import { registerContextWindowSelectionFeature } from './contextWindowSelection.js';
import { registerModelStreamDiagnosticsFeature } from './modelStreamDiagnostics.js';
import { registerCodebaseBackflowFeature } from './codebaseBackflow.js';
import { registerDynamicCommandsFeature } from './dynamicCommands.js';
import { registerPowerShellToolFeature } from './powerShellTool.js';
import { registerAutoMemoryFeature } from './autoMemory.js';
import { registerPromptPolicyFeature } from './promptPolicy.js';
import { registerAutoMemoryPolicyFeature } from './autoMemoryPolicy.js';
import { registerAutoDreamFeature } from './autoDream.js';
import { registerAgentsMdSizePolicyFeature } from './agentsMdSizePolicy.js';
import { registerLegacyInferDomainFailoverFeature } from './legacyInferDomainFailover.js';
import { registerModelRequestZstdFeature } from './modelRequestZstd.js';
import { registerCodeModeFeature } from './codeMode.js';
import { registerDynamicTurnBudgetFeature } from './dynamicTurnBudget.js';
import { registerPromptSuggestionFeature } from './promptSuggestion.js';

/**
 * Register all built-in feature gates.
 * Used by the legacy ConfigClient startup path before client.start().
 */
export function registerBuiltInFeatures(): void {
  registerAutoCompactModelThresholdCapsFeature();
  registerEchoFeature();
  registerContextWindowSelectionFeature();
  registerModelStreamDiagnosticsFeature();
  registerCodebaseBackflowFeature();
  registerDynamicCommandsFeature();
  registerPowerShellToolFeature();
  registerAutoMemoryFeature();
  registerPromptPolicyFeature();
  registerAutoMemoryPolicyFeature();
  registerAutoDreamFeature();
  registerAgentsMdSizePolicyFeature();
  registerLegacyInferDomainFailoverFeature();
  registerModelRequestZstdFeature();
  registerCodeModeFeature();
  registerDynamicTurnBudgetFeature();
  registerPromptSuggestionFeature();
  // Future: registerAwarenessFeature(), registerModelRouteFeature(), ...
}
