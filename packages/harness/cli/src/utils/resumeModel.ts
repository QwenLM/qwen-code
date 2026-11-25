/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type LlmGenerationConfig,
  type SessionResumeData,
  normalizeLlmGenerationConfig,
  parseReasoningEffortLevel,
  runLogger,
} from '@qwen-code/core';
import {
  getPreferredContextWindow,
  getPreferredGeneration,
  getPreferredReasoningEffort,
  setModelPreference,
  setPreferredGeneration,
} from './modelPreference.js';

export interface ResumeRuntimeConfigRestoreResult {
  model?: string;
  reasoningEffort?: string | null;
  contextWindow?: number | null;
  generation?: LlmGenerationConfig | null;
}

export async function restoreRuntimeConfigFromResumeData(
  config: Config,
  resumedData: SessionResumeData,
): Promise<ResumeRuntimeConfigRestoreResult> {
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const initialModel = config.getModel();
  const model = await restoreModelFromResumeData(config, resumedData);
  const resumeModel = resumedData.model?.trim();
  if (resumeModel && model === undefined && config.getModel() !== resumeModel) {
    runLogger.log(
      '[session.resume] runtime_config.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_model=${resumeModel}`,
      `current_model=${config.getModel()}`,
      'reason=resume_model_not_active',
    );
    return { model };
  }
  const cliModel = config.getCliModel?.()?.trim();
  if (cliModel && !resumeModel) {
    runLogger.log(
      '[session.resume] runtime_config.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_model=${resumeModel ?? 'unknown'}`,
      `cli_model=${cliModel}`,
      'reason=cli_model_override',
    );
    return { model };
  }

  const targetModel = config.getModel();
  const stillCurrent = () =>
    config.getModel() === targetModel &&
    (model !== undefined || targetModel === initialModel) &&
    config.getModelRequestIdentity() === identity &&
    config.getSessionId() === sessionId;
  if (!stillCurrent()) return { model };
  const generation = await restoreGenerationFromResumeData(config, resumedData);
  if (!stillCurrent()) return { model, generation };
  const reasoningEffort = await restoreReasoningEffortFromResumeData(
    config,
    resumedData,
  );
  if (!stillCurrent()) return { model, generation, reasoningEffort };
  const contextWindow = await restoreContextWindowFromResumeData(
    config,
    resumedData,
  );
  return { model, reasoningEffort, contextWindow, generation };
}

async function restoreGenerationFromResumeData(
  config: Config,
  resumedData: SessionResumeData,
): Promise<LlmGenerationConfig | null | undefined> {
  if (resumedData.generation === undefined) {
    return undefined;
  }

  let next =
    resumedData.generation === null
      ? undefined
      : normalizeLlmGenerationConfig(resumedData.generation);
  if (resumedData.generation !== null && next === undefined) {
    runLogger.log(
      '[session.resume] generation.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      'reason=invalid_generation',
    );
    return undefined;
  }

  const modelKey = config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const listed = await config.getModelProviderManager().getModel(modelKey);
  if (
    modelKey !== config.getModel() ||
    identity !== config.getModelRequestIdentity() ||
    sessionId !== config.getSessionId()
  )
    return undefined;

  // A CLI effort override is more specific than transcript state. Preserve its
  // currently composed reasoning block while restoring sampling fields.
  // An absent block (`--reasoning-effort auto`) also replaces transcript
  // reasoning, otherwise an old explicit effort would override the CLI default.
  if (config.getCliReasoningEffort?.() !== undefined) {
    const currentReasoning = getPreferredGeneration(config, listed)?.reasoning;
    next = normalizeLlmGenerationConfig({
      ...(next ?? {}),
      reasoning: currentReasoning,
    });
  }

  if (
    JSON.stringify(getPreferredGeneration(config, listed) ?? null) !==
    JSON.stringify(next ?? null)
  ) {
    await setPreferredGeneration(config, next, { model: listed ?? modelKey });
    runLogger.log(
      '[session.resume] generation.restored',
      `target_session=${resumedData.sessionId}`,
      `generation=${next ? 'configured' : 'none'}`,
    );
  }

  return resumedData.generation === null ? null : next;
}

export async function restoreModelFromResumeData(
  config: Config,
  resumedData: SessionResumeData,
): Promise<string | undefined> {
  const model = resumedData.model?.trim();
  if (!model) {
    return undefined;
  }

  if (config.getCliModel?.()) {
    runLogger.log(
      '[session.resume] model.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_model=${model}`,
      'reason=cli_model_override',
    );
    return undefined;
  }

  const manager = config.getModelProviderManager();
  const currentModel = config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const models = await manager.listModels();
  const hasListedModels = models.length > 0;
  const modelEntry = hasListedModels
    ? await manager.getModel(model)
    : undefined;
  if (
    config.getModel() !== currentModel ||
    config.getModelRequestIdentity() !== identity ||
    config.getSessionId() !== sessionId ||
    config.getCliModel?.()
  )
    return undefined;
  if (hasListedModels && (!modelEntry || modelEntry.enabled === false)) {
    runLogger.log(
      '[session.resume] model.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_model=${model}`,
      `reason=${modelEntry ? 'model_disabled' : 'model_not_found'}`,
    );
    return undefined;
  }

  if (config.getModel() === model) {
    return model;
  }

  // setModel restores per-model preferences, including clearing effort for an
  // unconfigured model. Snapshot the resolved CLI reasoning before the switch
  // so session overrides (including `auto`, `none`, and `ultracode`) survive.
  const hasCliEffort = config.getCliReasoningEffort?.() !== undefined;
  const previousModel = hasCliEffort
    ? await manager.getModel(currentModel)
    : undefined;
  if (
    currentModel !== config.getModel() ||
    identity !== config.getModelRequestIdentity() ||
    sessionId !== config.getSessionId()
  )
    return undefined;
  const cliReasoning = hasCliEffort
    ? getPreferredGeneration(config, previousModel)?.reasoning
    : undefined;
  const applied = await config.setModel(model, true);
  if (
    !applied ||
    config.getModel() !== model ||
    config.getModelRequestIdentity() !== identity ||
    config.getSessionId() !== sessionId
  )
    return undefined;
  if (hasCliEffort) {
    try {
      await setPreferredGeneration(config, {
        ...getPreferredGeneration(config, modelEntry),
        reasoning: cliReasoning,
      });
    } catch (error) {
      runLogger.log(
        '[session.resume] model.cli_reasoning_skipped',
        `target_session=${resumedData.sessionId}`,
        `model=${model}`,
        `reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (
    config.getModel() !== model ||
    config.getModelRequestIdentity() !== identity ||
    config.getSessionId() !== sessionId
  )
    return undefined;
  runLogger.log(
    '[session.resume] model.restored',
    `target_session=${resumedData.sessionId}`,
    `model=${model}`,
  );

  return model;
}

async function restoreReasoningEffortFromResumeData(
  config: Config,
  resumedData: SessionResumeData,
): Promise<string | null | undefined> {
  if (resumedData.reasoningEffort === undefined) {
    return undefined;
  }

  if (config.getCliReasoningEffort?.() !== undefined) {
    runLogger.log(
      '[session.resume] reasoning_effort.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_reasoning_effort=${resumedData.reasoningEffort ?? 'none'}`,
      'reason=cli_reasoning_effort_override',
    );
    return undefined;
  }

  const next =
    resumedData.reasoningEffort === null
      ? undefined
      : parseReasoningEffortLevel(resumedData.reasoningEffort);
  if (resumedData.reasoningEffort !== null && next === undefined) {
    runLogger.log(
      '[session.resume] reasoning_effort.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_reasoning_effort=${resumedData.reasoningEffort}`,
      'reason=invalid_reasoning_effort',
    );
    return undefined;
  }
  const modelKey = config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const listed = await config.getModelProviderManager().getModel(modelKey);
  if (
    modelKey !== config.getModel() ||
    identity !== config.getModelRequestIdentity() ||
    sessionId !== config.getSessionId()
  )
    return undefined;
  if (getPreferredReasoningEffort(config, listed) === next) {
    return resumedData.reasoningEffort;
  }

  try {
    await setModelPreference(
      config,
      { reasoning: { effort: next } },
      { model: listed ?? modelKey },
    );
  } catch (error) {
    runLogger.log(
      '[session.resume] reasoning_effort.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_reasoning_effort=${resumedData.reasoningEffort ?? 'none'}`,
      `reason=${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  runLogger.log(
    '[session.resume] reasoning_effort.restored',
    `target_session=${resumedData.sessionId}`,
    `reasoning_effort=${resumedData.reasoningEffort ?? 'none'}`,
  );

  return resumedData.reasoningEffort;
}

async function restoreContextWindowFromResumeData(
  config: Config,
  resumedData: SessionResumeData,
): Promise<number | null | undefined> {
  if (resumedData.contextWindow === undefined) {
    return undefined;
  }

  if (config.getCliContextWindow?.() !== undefined) {
    runLogger.log(
      '[session.resume] context_window.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_context_window=${resumedData.contextWindow ?? 'none'}`,
      'reason=cli_context_window_override',
    );
    return undefined;
  }

  const modelKey = config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const model = await config.getModelProviderManager().getModel(modelKey);
  if (
    modelKey !== config.getModel() ||
    identity !== config.getModelRequestIdentity() ||
    sessionId !== config.getSessionId()
  )
    return undefined;

  if (resumedData.contextWindow === null) {
    if (getPreferredContextWindow(config, model) !== undefined) {
      await setModelPreference(config, {
        context: { contextWindow: undefined },
      });
      runLogger.log(
        '[session.resume] context_window.restored',
        `target_session=${resumedData.sessionId}`,
        'context_window=none',
      );
    }
    return null;
  }

  const contextWindow = resumedData.contextWindow;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    runLogger.log(
      '[session.resume] context_window.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_context_window=${contextWindow}`,
      'reason=invalid_context_window',
    );
    return undefined;
  }

  const availableContextWindows = config.getAvailableContextWindows(model);
  if (
    availableContextWindows.length > 0 &&
    !availableContextWindows.includes(contextWindow)
  ) {
    runLogger.log(
      '[session.resume] context_window.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_context_window=${contextWindow}`,
      `model=${config.getModel()}`,
      `available_context_windows=${availableContextWindows.join(',')}`,
      'reason=unsupported_context_window',
    );
    return undefined;
  }

  if (getPreferredContextWindow(config, model) === contextWindow) {
    return contextWindow;
  }

  try {
    await setModelPreference(config, { context: { contextWindow } });
  } catch (error) {
    runLogger.log(
      '[session.resume] context_window.restore_skipped',
      `target_session=${resumedData.sessionId}`,
      `resume_context_window=${contextWindow}`,
      `reason=${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  runLogger.log(
    '[session.resume] context_window.restored',
    `target_session=${resumedData.sessionId}`,
    `context_window=${contextWindow}`,
  );

  return contextWindow;
}
