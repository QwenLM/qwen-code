/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { Config } from '../config/config.js';
import type { BusinessInfo } from '../qoder/business-info.js';

import type {
  ModelStreamMessage,
  ModelStreamTool,
} from '../provider/modelStreamRequest.js';
import type { Message } from '../protocol/transcript/message.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { ReasoningEffortLevel } from '../config/model-values.js';
import type { LlmGenerationConfig } from '../config/generation-config.js';
import type { FileStateCache } from '../utils/fileStateCache.js';
import type { SystemPrompt } from '../prompts/types.js';

/** Bind the foreground request to the account, model setting and permission mode
 * that produced it. A host may change any of them while inference is pending. */
export function captureParentRequestIdentity(config: Config | undefined) {
  try {
    if (!config) return undefined;
    return {
      model: config.getModel(),
      identity: config.getModelRequestIdentity(),
      permission: config.getPermissionMode(),
    };
  } catch {
    // This optional checkpoint may never interrupt a foreground request.
    return undefined;
  }
}

/**
 * Cache-safe parent request snapshot for streaming and post-turn forked agents.
 *
 * Forked features, such as Agent tools and SDK prompt suggestions, must reuse the
 * same model, system prompt, tool schema list, reasoning settings, and message
 * prefix as the parent request. Otherwise the provider prompt cache cannot be
 * shared with the parent turn.
 */
export interface CacheSafeQuerySnapshot {
  /** Only set on a completed end-turn checkpoint, never on the pre-stream prefix. */
  completedTurn?: {
    sessionId: string;
    sourceSessionId?: string;
    promptId: string;
    requestSetId: string;
    workdirs?: readonly string[];
    customContext?: Readonly<Record<string, string>>;
    businessInfo?: Readonly<BusinessInfo>;
    requestIdentity?: ReturnType<typeof captureParentRequestIdentity>;
    /** @deprecated Use requestIdentity. */
    predictionIdentity?: ReturnType<typeof captureParentRequestIdentity>;
  };
  /** Complete selection; the remaining scalar fields project request/cache settings. */
  modelResolution: ModelSelection;
  /** Read baselines captured with the request, before streaming tools run. */
  fileReadState?: FileStateCache;
  systemPrompt?: SystemPrompt;
  /**
   * Exact ephemeral runtime messages prepended to the parent request before
   * API projection. Manual forks reuse these instead of rebuilding context
   * from mutable Config state.
   */
  requestPrefixMessages?: readonly Message[];
  forkContextMessages: readonly ModelStreamMessage[];
  /** Structured environment and session context in that exact projected prefix. */
  contextAttachmentMessages?: readonly Message[];
  model: string;
  toolSchemas: ModelStreamTool[];
  maxOutputTokens?: number;
  thinkingBudget?: number;
  reasoningEffort?: ReasoningEffortLevel;
  generation?: LlmGenerationConfig;
  contextWindow?: number;
  lastAssistantUsage?: NonNullableUsage;
}
