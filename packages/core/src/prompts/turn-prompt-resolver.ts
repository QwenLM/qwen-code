/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-turn system prompt resolver shared by every host surface.
 *
 * A turn's prompt depends on the *effective model*, which is only known once the
 * request is about to be sent, while everything else (source, render inputs,
 * policy snapshot) is stable for the turn. So hosts prepare once via
 * `createTurnPromptResolver()` and then call the returned resolver with the
 * model. SessionQueryRunner and the local TUI orchestrator both use this,
 * so the model-aware bundle policy cannot drift between the two entry points.
 */

import process from 'node:process';
import type { Model } from '../provider/model/model.js';
import {
  isQwenServerModel,
  type QoderListedModel,
} from '../qoder/models/qoder-model-fields.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  getPromptPolicySnapshot,
  type PromptPolicySnapshot,
} from '../config-service/features/promptPolicy.js';
import {
  resolveLocalPromptMode,
  resolvePromptPolicy,
  SIMPLE_SYSTEM_PROMPT_ENV,
  type LocalPromptMode,
} from './bundle-resolver.js';
import { buildSystemPromptResultForTurn } from './build-system-prompt.js';
import {
  readPromptBehaviorOverrides,
  type PromptBehaviorOverrides,
} from './behavior-policy.js';
import {
  resolveEffectivePromptSource,
  type ResolvedPromptSource,
} from './effective-prompt.js';
import {
  createMemoryPromptInput,
  createPromptRenderInputs,
} from './render-inputs.js';
import type { SystemPromptAssembler } from './system-prompt-assembler.js';
import type {
  AgentDefinitionLike,
  PromptAssemblyContext,
  PromptBuildResult,
  PromptRenderInputs,
  PromptSurface,
  SdkMemoryPromptState,
} from './types.js';

export interface TurnPromptResolverOptions {
  /** Host context used to read tools / skills / language for render inputs. */
  readonly agentLoopContext: AgentLoopContext;
  readonly sessionId: string;
  readonly cwd: string;
  readonly promptSurface: PromptSurface;
  readonly assembler: SystemPromptAssembler | undefined;
  readonly overrideSystemPrompt?: string;
  readonly customSystemPrompt?: string;
  /** Runtime `--append-system-prompt` equivalent for this turn. */
  readonly appendSystemPrompt?: string;
  /**
   * Startup-level CLI append. SDK runtime append replaces it; other surfaces
   * merge it ahead of their runtime append.
   */
  readonly cliAppendSystemPrompt?: string;
  readonly mainThreadAgentDefinition?: AgentDefinitionLike;
  readonly sdkMemoryState?: SdkMemoryPromptState;
  /** Invoked after every build so hosts can cache the rendered prompt. */
  readonly onResult?: (result: PromptBuildResult) => void;
}

export type TurnPromptResolver = (
  effectiveModel: string,
  selectedModel?: Model,
) => Promise<PromptBuildResult>;

function resolveFixedSdkMemoryState(
  state: SdkMemoryPromptState,
  effectiveModel: string,
  policy:
    | {
        readonly policy: PromptPolicySnapshot;
        readonly localMode: LocalPromptMode;
      }
    | undefined,
): SdkMemoryPromptState {
  if (!policy || state.owner !== 'sdk' || !('promptsByBundle' in state)) {
    return state;
  }
  const bundle = resolvePromptPolicy({ effectiveModel, ...policy }).bundle;
  return Object.freeze({
    owner: 'sdk',
    prompt: state.promptsByBundle[bundle],
    version: 'skill',
    shapeKey: state.shapeKey,
  });
}

/**
 * Prepares the turn-stable half of the prompt and returns a resolver that
 * finishes the model-dependent half.
 */
export async function createTurnPromptResolver(
  options: TurnPromptResolverOptions,
): Promise<TurnPromptResolver> {
  const {
    agentLoopContext,
    promptSurface,
    assembler,
    appendSystemPrompt,
    cliAppendSystemPrompt,
    onResult,
  } = options;
  const sdkMemoryState: SdkMemoryPromptState = options.sdkMemoryState ?? {
    owner: 'native',
  };
  // The three raw prompt inputs only matter here: `resolvedSource` carries the
  // selected source's fixed body from this point on.
  const resolvedSource = resolveEffectivePromptSource({
    overrideSystemPrompt: options.overrideSystemPrompt,
    mainThreadAgentDefinition: options.mainThreadAgentDefinition,
    customSystemPrompt: options.customSystemPrompt,
  });

  // Only assembled sources render sections; override / agent prompts are fixed.
  // Everything the assembled path needs hangs off one discriminant, so the
  // resolver below cannot construct a half-populated context.
  const assembled = prepareAssembledSource(
    resolvedSource.source,
    agentLoopContext,
    promptSurface,
    sdkMemoryState,
  );
  const fixedSdkMemoryPolicy =
    assembled === undefined &&
    sdkMemoryState.owner === 'sdk' &&
    'promptsByBundle' in sdkMemoryState
      ? Object.freeze({
          policy: getPromptPolicySnapshot(),
          localMode: resolveLocalPromptMode(
            process.env[SIMPLE_SYSTEM_PROMPT_ENV],
          ),
        })
      : undefined;

  return async (effectiveModel, selectedModel) => {
    let frontendGuidance: PromptAssemblyContext['frontendGuidance'];
    if (assembled?.frontendGuidance && effectiveModel === QODUCK_MODEL_KEY) {
      const { config } = agentLoopContext;
      const model =
        selectedModel ??
        (config.hasModelProviderManager()
          ? await config.getModelProviderManager().getModel(effectiveModel)
          : undefined);
      if (model?.key === effectiveModel && isSystemCatalogModel(model)) {
        frontendGuidance = assembled.frontendGuidance;
      }
    }
    const sdkMemoryStateForTurn = resolveFixedSdkMemoryState(
      sdkMemoryState,
      effectiveModel,
      fixedSdkMemoryPolicy,
    );
    const result = await buildSystemPromptResultForTurn(assembler, {
      resolvedSource,
      promptSurface,
      appendSystemPrompt,
      cliAppendSystemPrompt,
      ...(assembled
        ? {
            assemblyContext: buildAssemblyContext(
              {
                ...assembled,
                frontendGuidance,
                // Bundle policy stays pinned for the turn; refresh memory input
                // from the current session configuration.
                renderInputs: {
                  ...assembled.renderInputs,
                  memory: createMemoryPromptInput(
                    agentLoopContext,
                    assembled.source,
                    promptSurface,
                    sdkMemoryState,
                  ),
                },
              },
              promptSurface,
              effectiveModel,
            ),
          }
        : {}),
      sdkMemoryState: sdkMemoryStateForTurn,
    });
    onResult?.(result);
    return result;
  };
}

/**
 * Turn-stable half of an assembled prompt. `undefined` for fixed sources
 * (override / custom / agent), which render no sections at all.
 */
type AssembledPromptPrep = {
  readonly source: 'default';
  readonly frontendGuidance?: PromptAssemblyContext['frontendGuidance'];
  readonly renderInputs: PromptRenderInputs;
  readonly policy: PromptPolicySnapshot;
  readonly localMode: LocalPromptMode;
  readonly behaviorOverrides: PromptBehaviorOverrides;
};

const QODUCK_MODEL_KEY = 'lmodel';

function isSystemCatalogModel(model: QoderListedModel): boolean {
  return isQwenServerModel(model) && model.catalogSource === 'system';
}

function prepareAssembledSource(
  source: ResolvedPromptSource['source'],
  agentLoopContext: AgentLoopContext,
  promptSurface: PromptSurface,
  sdkMemoryState: SdkMemoryPromptState,
): AssembledPromptPrep | undefined {
  if (source !== 'default') return undefined;
  const renderInputs = createPromptRenderInputs(
    agentLoopContext,
    source,
    promptSurface,
    sdkMemoryState,
  );
  const policy = getPromptPolicySnapshot();
  const behaviorOverrides = readPromptBehaviorOverrides();
  const profile = policy.behaviorByModel?.[QODUCK_MODEL_KEY];
  const allowFrontendGuidance =
    (behaviorOverrides.frontendGuidance ?? profile?.frontendGuidance) ===
      true && renderInputs.outputStyle?.keepCodingInstructions !== false;
  return {
    source,
    renderInputs,
    policy,
    frontendGuidance: allowFrontendGuidance
      ? { text: profile?.frontendGuidanceText }
      : undefined,
    behaviorOverrides,
    localMode: resolveLocalPromptMode(process.env[SIMPLE_SYSTEM_PROMPT_ENV]),
  };
}

function buildAssemblyContext(
  prep: AssembledPromptPrep,
  surface: PromptSurface,
  effectiveModel: string,
): PromptAssemblyContext {
  const resolvedPolicy = resolvePromptPolicy({
    effectiveModel,
    localMode: prep.localMode,
    policy: prep.policy,
    behaviorOverrides: prep.behaviorOverrides,
  });
  return Object.freeze({
    source: 'default',
    bundle: resolvedPolicy.bundle,
    frontendGuidance: prep.frontendGuidance,
    surface,
    renderInputs: prep.renderInputs,
    enabledSectionGates: resolvedPolicy.enabledSectionGates,
    communication: resolvedPolicy.communication,
  });
}
