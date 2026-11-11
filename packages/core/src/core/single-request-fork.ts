/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import {
  endModelRequestScope,
  SINGLE_REQUEST_FORK,
} from '../model-request/request-scope.js';
import type { ModelRequestObserver } from '../model-request/types.js';
import { createAssistantMessage } from '../protocol/transcript/conversions.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type {
  ModelStreamMessage,
  ModelStreamUserContent,
} from '../provider/modelStreamRequest.js';
import {
  applyBusinessSubTask,
  type BusinessInfo,
} from '../qoder/business-info.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import { countRequestTokens } from '../utils/request-token-count.js';
import { AgentLifecycleState } from './agent-lifecycle-state.js';
import type { ModelPolicyLabels } from './model-policy.js';
import {
  buildModelPrompt,
  streamProviderRequest,
  taskIdForQuerySource,
} from './model-request-execution.js';
import { projectModelUsage } from './model-response-to-query-event.js';
import type { CacheSafeQuerySnapshot } from './cache-safe-query-snapshot.js';
import type {
  ForkedAgentCompletion,
  ForkRequestContext,
} from './fork-accounting.js';
import type { QueryCollectorResult } from './query-result-collector.js';

const SINGLE_REQUEST_FORK_TIMEOUT_MS = 30_000;

export interface SingleRequestForkParams {
  readonly mode: 'singleRequest';
  readonly config: Config;
  readonly querySource: string;
  readonly selection: ModelSelection;
  readonly prompt: ModelStreamUserContent;
  readonly parent: Pick<
    CacheSafeQuerySnapshot,
    'systemPrompt' | 'toolSchemas' | 'forkContextMessages' | 'modelResolution'
  > & {
    readonly completedTurn: NonNullable<
      CacheSafeQuerySnapshot['completedTurn']
    > & {
      readonly businessInfo: Readonly<BusinessInfo>;
    };
  };
  readonly isCurrent: () => boolean;
  readonly policyLabels?: ModelPolicyLabels;
  readonly signal?: AbortSignal;
  readonly onCompleted?: (completion: ForkedAgentCompletion) => void;
  readonly onObservation?: ModelRequestObserver;
}

/** Execute one inference against the completed parent prefix. */
export async function runSingleRequestFork(
  options: SingleRequestForkParams,
  accounting: ForkRequestContext,
): Promise<QueryCollectorResult> {
  const { config, selection, querySource, parent } = options;
  const { completedTurn: turn, systemPrompt, toolSchemas: tools } = parent;
  if (!turn.requestSetId || !turn.sessionId) {
    throw new Error('Missing single-request fork parent identity');
  }
  if (
    selection.model.source !== parent.modelResolution.model.source ||
    selection.model.key !== parent.modelResolution.model.key
  ) {
    throw new Error('Single-request fork requires the parent model');
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException('Single-request fork timed out', 'TimeoutError'),
      ),
    SINGLE_REQUEST_FORK_TIMEOUT_MS,
  );
  timeout.unref?.();
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  let requestSetId: string | undefined;
  try {
    signal.throwIfAborted();
    const messages: ModelStreamMessage[] = [
      ...parent.forkContextMessages,
      { role: 'user', content: options.prompt },
    ];
    const window =
      selection.config.context?.contextWindow ??
      selection.model.limits.maxContextTokens;
    const inputTokens = countRequestTokens({
      model: selection.model.key,
      messages: [],
      normalizedMessages: messages,
      systemPrompt,
      tools,
    }).tokens;
    const outputTokens =
      selection.config.context?.maxOutputTokens ??
      selection.model.limits.maxOutputTokens ??
      0;
    if (inputTokens + outputTokens > window) {
      throw new Error('Single-request fork exceeds the model context window');
    }
    const started = Date.now();
    const requestId = randomUUID();
    const lifecycle = await raceWithAbortSignal(
      AgentLifecycleState.createForSubagent(
        turn.sessionId,
        querySource,
        turn.businessInfo,
        accounting.promptId,
        turn.requestSetId,
        querySource,
      ),
      signal,
    );
    requestSetId = lifecycle.requestSetId;
    const request = {
      [SINGLE_REQUEST_FORK]: true,
      resolution: selection,
      prompt: buildModelPrompt(selection, {
        system: systemPrompt,
        messages,
        tools: [...tools],
        toolChoice: 'none',
        skipCacheWrite: true,
      }),
      control: { signal },
      qoder: {
        identity: {
          sessionId: turn.sessionId,
          sourceSessionId: turn.sourceSessionId,
          requestSetId,
          requestId,
        },
        business: applyBusinessSubTask(
          lifecycle.businessInfo,
          querySource,
          options.policyLabels?.subTask ?? querySource,
        ),
        taskRouting: {
          taskId: taskIdForQuerySource(querySource),
          policyTaskId: options.policyLabels?.taskId,
        },
        workdirs: turn.workdirs,
        customContext: accounting.customContext,
      },
    };
    signal.throwIfAborted();
    if (!options.isCurrent()) throw new Error('Fork source changed');
    const stream = streamProviderRequest(config, request, {
      diagnostic: {
        loopId: accounting.promptId,
        requestIndex: 1,
        requestMessageCount: messages.length,
        toolSchemaCount: tools.length,
        isSubagent: true,
        taskId: requestSetId,
        onCompleted: accounting.onModelRequestCompleted,
        onFinished: accounting.onModelRequestFinished,
        onObservation: options.onObservation,
      },
    });
    try {
      let next = await stream.next();
      while (!next.done) {
        const event = next.value;
        if (
          (event.type === 'assistant_block' &&
            event.message.blocks.some((block) => block.type === 'tool_use')) ||
          (event.type === 'stream_event' &&
            event.event.type === 'content_block_start' &&
            event.event.contentBlock.type === 'tool_use')
        ) {
          throw new Error('Single-request fork attempted a tool call');
        }
        next = await stream.next();
      }
      const outcome = next.value;
      const { message } = outcome;
      const usage = projectModelUsage(message.usage, requestId);
      const terminal = {
        requestSetId,
        requestId,
        numTurns: 1,
        usage,
        modelStopReason: message.stopReason,
        durationMs: Date.now() - started,
      };
      signal.throwIfAborted();
      if (
        outcome.kind !== 'complete' ||
        message.stopReason !== 'end_turn' ||
        message.blocks.some((block) => block.type === 'tool_use')
      ) {
        return {
          messages: [],
          totalUsage: usage,
          textContent: '',
          terminal: {
            ...terminal,
            reason: 'error',
            error: new Error('Incomplete or non-text fork response'),
          },
        };
      }
      return {
        messages: [
          createAssistantMessage(message, requestId, undefined, usage),
        ],
        totalUsage: usage,
        textContent: message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
        terminal: { ...terminal, reason: 'end_turn' },
      };
    } finally {
      await stream.return(undefined as never);
    }
  } finally {
    try {
      if (requestSetId) {
        await raceWithAbortSignal(
          endModelRequestScope(turn.sessionId, requestSetId),
          signal,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
