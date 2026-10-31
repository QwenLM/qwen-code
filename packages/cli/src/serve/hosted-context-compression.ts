/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Content } from '@google/genai';
import { llmPreparedProviderPin } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';
import {
  getStartupContextLength,
  markCompressedHistory,
} from '@qwen-code/qwen-code-core/core/environmentContext.js';
import { estimateContentTokens } from '@qwen-code/qwen-code-core/services/tokenEstimation.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { CompressionStatus } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  ChatCompressionService,
  firePostCompact,
  type ChatCompressionCandidate,
} from '@qwen-code/qwen-code-core/services/chatCompressionService.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  parseHistoryMaintenance,
  type HistoryMaintenance,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-history-maintenance-record.js';
import {
  publishManagedMessageBody,
  readManagedMessageBody,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-message-chunks.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHookOutput,
  HookEventName,
  type HookInput,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { applyHostedModelPin } from './hosted-harness-model.js';
import type { HostedAgentDefinition } from './hosted-agent-definition.js';
import type { HostedModelSelection } from './hosted-model-selection.js';

const debugLogger = createDebugLogger('HOSTED_CONTEXT_COMPRESSION');

export interface HostedCompressionIntent {
  operationId: string;
  expectedCompactionRevision: number;
  modelSelection?: HostedModelSelection;
}

interface CompressionRequest extends HostedCompressionIntent {
  version: 1;
  historyCutSequence: number;
  providerPin: string;
  policyPin: string;
  instructions: string;
  history: Content[];
  completedToolCallIds: string[];
  historyPromptIds: Array<string | null>;
  contextPrefixLength: number;
}

interface PersistedCandidate extends ChatCompressionCandidate {
  promptIds: Array<string | null>;
  contextPrefixLength: number;
}

interface CompressionOptions {
  session: ManagedSession;
  cwd: string;
  agentDefinition?: HostedAgentDefinition;
  instructions: () => Promise<string>;
  busy: () => boolean;
  hasPendingHooks: () => boolean;
  fireHook?: (
    event: HookEventName,
    operationId: string,
    fields: HookInput,
  ) => Promise<unknown>;
}

export interface HostedCompressionStatus {
  operationId: string;
  status: 'pending' | 'running' | 'recovery_blocked' | 'completed' | 'failed';
  outcome?: 'compressed' | 'noop';
  compactionRevision: number;
  failureCode?: string;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class HostedCompressionRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class HostedContextCompression {
  private admitting = false;
  private running?: Promise<void>;

  constructor(private readonly options: CompressionOptions) {}

  get busy(): boolean {
    return (
      this.admitting ||
      !!this.options.session.authority.activeHistoryMaintenance
    );
  }

  get revision(): number {
    const authority = this.options.session.authority;
    return (
      authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .findLast((event) => event.kind === 'context.compacted')?.sequence ?? 0
    );
  }

  private record(operationId: string): HistoryMaintenance | undefined {
    const saved = this.options.session.authority.extensionRecord(
      'history_maintenance',
      operationId,
    );
    return saved ? parseHistoryMaintenance(saved.record) : undefined;
  }

  status(operationId: string): HostedCompressionStatus | undefined {
    const record = this.record(operationId);
    if (!record) return undefined;
    return {
      operationId,
      status:
        record.phase === 'settled'
          ? record.outcome === 'failed'
            ? 'failed'
            : 'completed'
          : record.run.state === 'recovery_blocked'
            ? 'recovery_blocked'
            : record.phase === 'admitted'
              ? 'pending'
              : 'running',
      ...(record.outcome === 'compressed' || record.outcome === 'noop'
        ? { outcome: record.outcome }
        : {}),
      compactionRevision:
        record.compactionRevision ?? record.expectedCompactionRevision,
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    };
  }

  private async read<T>(ref: ManagedSessionDurableRef): Promise<T> {
    return JSON.parse(
      (
        await readManagedMessageBody(
          (part) => this.options.session.resources.read(part),
          ref,
        )
      ).toString('utf8'),
    ) as T;
  }

  private publish(value: unknown): Promise<ManagedSessionDurableRef> {
    return publishManagedMessageBody(
      this.options.session.resources,
      Buffer.from(JSON.stringify(value)),
    );
  }

  async admit(
    intent: HostedCompressionIntent,
  ): Promise<HostedCompressionStatus> {
    const previous = this.record(intent.operationId);
    if (previous) {
      const saved = await this.read<CompressionRequest>(previous.requestRef);
      if (
        saved.expectedCompactionRevision !==
          intent.expectedCompactionRevision ||
        JSON.stringify(saved.modelSelection) !==
          JSON.stringify(intent.modelSelection)
      )
        throw new HostedCompressionRefusal('idempotency_conflict');
      this.resume();
      return this.status(intent.operationId)!;
    }
    if (this.busy || this.options.busy())
      throw new HostedCompressionRefusal('session_context_busy');
    if (this.revision !== intent.expectedCompactionRevision)
      throw new HostedCompressionRefusal('compaction_revision_conflict');
    this.admitting = true;
    let committing = false;
    try {
      const session = this.options.session;
      const historyCutSequence = session.authority.committedSequence;
      const settled = new Set(
        session.authority
          .eventsInSequenceRange(1, historyCutSequence)
          .filter((event) => event.kind === 'turn.settled')
          .map((event) => event.payload['turnId']),
      );
      const unanswered = new Set(
        session.authority
          .eventsInSequenceRange(1, historyCutSequence)
          .filter(
            (event) =>
              event.kind === 'turn.settled' &&
              ['error', 'cancelled'].includes(String(event.payload['outcome'])),
          )
          .map((event) => event.payload['turnId']),
      );
      const history = await session.sink.projectModelHistory({
        throughSequence: historyCutSequence,
        includeRecord: (entry) =>
          (entry.type === 'system' || settled.has(entry.daemonPromptId)) &&
          !(entry.type === 'user' && unanswered.has(entry.daemonPromptId)),
      });
      history.apiHistory = history.apiHistory.filter(
        (entry) =>
          entry.role !== 'user' ||
          !unanswered.has(getApiHistoryPromptId(entry)),
      );
      const instructions = await this.options.instructions();
      const config = await this.createConfig(intent, instructions).catch(() => {
        throw new HostedCompressionRefusal(
          'context_compression_configuration_unavailable',
        );
      });
      let requestRef: ManagedSessionDurableRef;
      try {
        requestRef = await this.publish({
          ...intent,
          version: 1,
          historyCutSequence,
          instructions,
          providerPin: llmPreparedProviderPin(
            config.getContentGeneratorConfig(),
          ),
          policyPin: this.policyPin(config),
          history: history.apiHistory,
          historyPromptIds: history.apiHistory.map(
            (entry) => getApiHistoryPromptId(entry) ?? null,
          ),
          contextPrefixLength: getStartupContextLength(history.apiHistory, {
            includeCompressed: true,
          }),
          completedToolCallIds: [...(history.completedToolCallIds ?? [])],
        } satisfies CompressionRequest);
      } finally {
        await config.shutdown({
          shutdownTelemetry: false,
          strictResourceCleanup: true,
        });
      }
      if (this.options.busy())
        throw new HostedCompressionRefusal('session_context_busy');
      const record: HistoryMaintenance = {
        schemaVersion: 1,
        kind: 'context_compression',
        operationId: intent.operationId,
        expectedCompactionRevision: intent.expectedCompactionRevision,
        historyCutSequence,
        requestRef,
        phase: 'admitted',
        attempt: 0,
        candidateRef: null,
        outcome: null,
        failureCode: null,
        compactionRevision: null,
        run: {
          state: 'admitted',
          reason: null,
          definition: null,
          executionCallId: null,
          effectId: null,
          dispatchId: null,
          deliveryId: null,
          execution: null,
          runtime: null,
          delivery: null,
        },
      };
      committing = true;
      await this.commit(record);
      this.resume();
      return this.status(intent.operationId)!;
    } catch (cause) {
      if (!committing && !(cause instanceof HostedCompressionRefusal))
        throw new HostedCompressionRefusal(
          'context_compression_preparation_failed',
        );
      throw cause;
    } finally {
      this.admitting = false;
    }
  }

  resume(): void {
    if (this.running || this.options.session.authority.writesStopped) return;
    const current = this.options.session.authority.activeHistoryMaintenance;
    if (!current) return;
    this.running = this.execute(current)
      .catch((cause: unknown) => {
        debugLogger.debug('Context compression needs durable recovery', cause);
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  async wait(): Promise<void> {
    await this.running;
  }

  private policyPin(config: Awaited<ReturnType<typeof loadCliConfig>>): string {
    return digest({
      compression: config.getChatCompression(),
      compactionModel: config.getCompactionModel(),
      fastModel: config.getFastModel(),
      models: config
        .getAllConfiguredModels()
        .map(({ id, authType, registryBaseUrl }) => ({
          id,
          authType,
          registryBaseUrl,
        })),
    });
  }

  private async createConfig(
    intent: HostedCompressionIntent,
    instructions: string,
  ) {
    const settings = loadSettings(this.options.cwd, {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
      workspaceTrusted: false,
    });
    const argv = {
      acp: true,
      safeMode: true,
      chatRecording: false,
      sessionIdGenerated: true,
      sessionId:
        this.options.session.authority.sessionHeader.sessionKey.sessionId,
    } as CliArgs;
    const config = await loadCliConfig(
      settings.merged,
      argv,
      this.options.cwd,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      { toolInvocationGuard: () => ({ allowed: false }) },
    );
    try {
      await applyHostedModelPin(
        config,
        intent.modelSelection
          ? { id: intent.modelSelection.modelId }
          : this.options.agentDefinition?.model,
      );
      config.setUserMemory(instructions);
      await config.initialize({
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
        lenientToolWarmup: true,
        ...(this.options.fireHook
          ? {
              managedHookDispatcher: {
                hasHooksForEvent: (event) =>
                  event === HookEventName.PreCompact ||
                  event === HookEventName.PostCompact,
                execute: async (event, fields) => {
                  const result = await this.options.fireHook!(
                    event,
                    intent.operationId,
                    fields,
                  );
                  const output = result
                    ? createHookOutput(event, result)
                    : undefined;
                  return {
                    success: true,
                    allOutputs: output ? [output] : [],
                    errors: [],
                    totalDuration: 0,
                    finalOutput: output,
                  };
                },
              },
            }
          : {}),
      });
      config.setUserMemory(instructions);
      const authType = config.getModelsConfig().getCurrentAuthType();
      if (!authType)
        throw new Error('Hosted compression authentication is unavailable.');
      await config.refreshAuth(authType, true);
      return config;
    } catch (cause) {
      await config.shutdown({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
      throw cause;
    }
  }

  private async commit(
    record: HistoryMaintenance,
    compaction?: {
      summaryRef: ManagedSessionDurableRef;
      compactionId: string;
      fromSequence: number;
      toSequence: number;
      replacedMessageIds: string[];
    },
  ): Promise<void> {
    const session = this.options.session;
    const revision =
      session.authority.extensionRecord(
        'history_maintenance',
        record.operationId,
      )?.revision ?? 0;
    await session.authority.commitHistoryMaintenance(
      {
        operation: 'contextCompression',
        commandId: `${record.operationId}:${revision + 1}`,
        sessionKey: session.authority.sessionHeader.sessionKey,
        contentDigest: digest(record),
      },
      { record, ...(compaction ? { compaction } : {}) },
      { class: 'harness', activation: session.activation },
    );
  }

  private async execute(initial: HistoryMaintenance): Promise<void> {
    let current = initial;
    let config: Awaited<ReturnType<typeof loadCliConfig>> | undefined;
    const signal = new AbortController().signal;
    try {
      const request = await this.read<CompressionRequest>(current.requestRef);
      config = await this.createConfig(request, request.instructions);
      if (
        request.version !== 1 ||
        request.operationId !== current.operationId ||
        request.historyCutSequence !== current.historyCutSequence ||
        request.providerPin !==
          llmPreparedProviderPin(config.getContentGeneratorConfig()) ||
        request.policyPin !== this.policyPin(config)
      )
        throw new Error('Saved compression configuration is unavailable.');
      const chat = config.getLlmClient().getChat();
      request.history.forEach((entry, index) =>
        markApiHistoryPrompt(entry, request.historyPromptIds[index]),
      );
      markCompressedHistory(request.history, request.contextPrefixLength);
      chat.setHistory(request.history, request.completedToolCallIds);
      let candidate: PersistedCandidate;
      if (current.candidateRef) {
        candidate = await this.read<PersistedCandidate>(current.candidateRef);
        await firePostCompact(config, candidate, signal);
      } else {
        current = {
          ...current,
          phase: 'generating',
          attempt: current.attempt + 1,
          run: { ...current.run, state: 'running', reason: null },
          failureCode: null,
        };
        await this.commit(current);
        const result = await new ChatCompressionService().compress(chat, {
          promptId: current.operationId,
          force: true,
          trigger: 'manual',
          config,
          consecutiveFailures: 0,
          originalTokenCount: estimateContentTokens(request.history),
          signal,
          restoreRecentFiles: false,
          onPreparedCompaction: async (prepared) => {
            prepared.info.originalTokenCountIsEstimated = true;
            const candidateRef = await this.publish({
              ...prepared,
              promptIds: prepared.newHistory.map(
                (entry) => getApiHistoryPromptId(entry) ?? null,
              ),
              contextPrefixLength: getStartupContextLength(
                prepared.newHistory,
                { includeCompressed: true },
              ),
            } satisfies PersistedCandidate);
            current = { ...current, phase: 'candidate', candidateRef };
            await this.commit(current);
          },
        });
        if (
          result.info.compressionStatus !== CompressionStatus.COMPRESSED ||
          !result.newHistory
        ) {
          const noop = result.info.compressionStatus === CompressionStatus.NOOP;
          await this.commit({
            ...current,
            phase: 'settled',
            outcome: noop ? 'noop' : 'failed',
            failureCode: noop ? null : 'context_compression_failed',
            compactionRevision: null,
            run: {
              ...current.run,
              state: noop ? 'settled' : 'failed',
              reason: null,
            },
          });
          return;
        }
        if (!current.candidateRef)
          throw new Error('Compression candidate was not committed.');
        candidate = await this.read<PersistedCandidate>(current.candidateRef);
      }
      const session = this.options.session;
      const uuid = randomUUID();
      const record = {
        ...session.authority.recordEnvelope,
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'chat_compression',
        systemPayload: {
          info: candidate.info,
          compressedHistory: candidate.newHistory,
          summaryPrefixLength: candidate.newHistory.length,
          completedToolCallIds: request.completedToolCallIds,
          promptIds: candidate.promptIds,
          contextPrefixLength: candidate.contextPrefixLength,
        },
      };
      const summaryRef = await this.publish(record);
      await this.commit(
        {
          ...current,
          phase: 'settled',
          outcome: 'compressed',
          failureCode: null,
          compactionRevision: null,
          run: { ...current.run, state: 'settled', reason: null },
        },
        {
          summaryRef,
          compactionId: current.operationId,
          fromSequence: session.authority.compactedThroughSequence + 1,
          toSequence: current.historyCutSequence,
          replacedMessageIds: session.authority
            .eventsInSequenceRange(
              session.authority.compactedThroughSequence + 1,
              current.historyCutSequence,
            )
            .filter((event) => event.kind === 'message.committed')
            .map((event) => event.payload['messageId'] as string),
        },
      );
    } catch (cause) {
      if (this.options.session.authority.writesStopped) throw cause;
      const actual = this.record(current.operationId);
      if (actual?.phase === 'settled') return;
      current = actual ?? current;
      const blocked =
        this.options.hasPendingHooks() || current.candidateRef !== null;
      await this.commit({
        ...current,
        phase: blocked ? current.phase : 'settled',
        outcome: blocked ? null : 'failed',
        failureCode: blocked ? null : 'context_compression_failed',
        compactionRevision: null,
        run: {
          ...current.run,
          state: blocked ? 'recovery_blocked' : 'failed',
          reason: blocked ? 'handler_unavailable' : null,
        },
      });
    } finally {
      await config?.shutdown({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
    }
  }
}
