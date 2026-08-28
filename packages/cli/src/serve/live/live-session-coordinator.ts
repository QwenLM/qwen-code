/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  escapeXml,
  SessionService,
  stripTerminalControlSequences,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import type {
  AcpSessionBridge,
  BridgeSession,
} from '@qwen-code/acp-bridge/bridgeTypes';
import {
  SessionArchivedError,
  SessionNotFoundError,
} from '@qwen-code/acp-bridge/bridgeErrors';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  buildQwenRealtimeInstructions,
  openQwenRealtimeSession,
  QwenRealtimeError,
  type QwenRealtimeCallbacks,
  type RealtimeCloseInfo,
  type QwenRealtimeSession,
  type RealtimeDelegateCall,
  type RealtimeOutputTextEvent,
  type RealtimeTranscriptEntry,
} from './qwen-realtime-session.js';
import { buildRealtimeStartupContext } from './realtime-startup-context.js';
import type { LiveProviderCredential } from './provider-credentials.js';
import {
  isCompatibleLiveSessionSource,
  LIVE_SESSION_SOURCE_PREFIX,
} from '../../runtime/live-session-source.js';
import { normalizeSessionIdForLookup } from '../../config/session-id.js';
import type { LiveProviderReadiness, LiveSessionLocator } from './types.js';

export { LIVE_SESSION_SOURCE_PREFIX } from '../../runtime/live-session-source.js';

const MAX_COORDINATOR_REQUEST_CHARS = 32_000;
const MAX_COORDINATOR_RESULT_CHARS = 48_000;
const COORDINATOR_TURN_TIMEOUT_MS = 10 * 60_000;
const BACKEND_CONTEXT_FLUSH_MS = 200;
const DEFAULT_GRACEFUL_STOP_DRAIN_MS = 30_000;
const SESSION_SCAN_SIZE = 100;
const MAX_LIVE_CAPTION_CHARS = 8_192;

function writeLiveDiagnostic(
  event: string,
  details: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  if (process.env['QWEN_LIVE_DIAGNOSTICS'] !== '1') return;
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      source: 'live-session',
      event,
      ...details,
    })}\n`,
  );
}

interface LiveAudioCapture {
  source: 'provider-output' | 'daemon-input';
  path: string;
  stream: ReturnType<typeof createWriteStream>;
  hash: ReturnType<typeof createHash>;
  bytes: number;
}

function openLiveAudioCapture(
  source: LiveAudioCapture['source'],
  identifier: string,
): LiveAudioCapture | undefined {
  const directory = process.env['QWEN_LIVE_DIAGNOSTICS_DIR'];
  if (process.env['QWEN_LIVE_DIAGNOSTICS'] !== '1' || !directory?.trim()) {
    return undefined;
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const safeIdentifier = identifier.replace(/[^A-Za-z0-9_-]/g, '_');
    const path = join(
      directory,
      `${source}-${Date.now()}-${safeIdentifier}.pcm`,
    );
    const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    stream.on('error', () => undefined);
    return { source, path, stream, hash: createHash('sha256'), bytes: 0 };
  } catch {
    return undefined;
  }
}

function closeLiveAudioCapture(
  capture: LiveAudioCapture | undefined,
  reason: string,
): void {
  if (!capture) return;
  capture.stream.end();
  writeLiveDiagnostic('audio_capture_closed', {
    captureSource: capture.source,
    path: capture.path,
    bytes: capture.bytes,
    sha256: capture.hash.digest('hex'),
    reason,
  });
}

export interface LiveSessionHostControl {
  setCallState(
    epoch: number,
    state:
      | 'starting'
      | 'listening'
      | 'thinking'
      | 'speaking'
      | 'stopping'
      | 'error',
  ): boolean;
  setCoordinator(epoch: number, locator: LiveSessionLocator): boolean;
  setPendingPermission(epoch: number, pending: boolean): boolean;
  setWorkers(epoch: number, workers: readonly LiveSessionLocator[]): boolean;
  sendOutputAudio(epoch: number, pcm16: Uint8Array): boolean;
  clearOutput(epoch: number): void;
  failCall(epoch: number, message?: string): boolean;
  setProviderReachability(readiness?: LiveProviderReadiness): void;
  setTranscript?(epoch: number, transcript: string): boolean;
  setCaption(epoch: number, caption: string): boolean;
  setStatusText(epoch: number, statusText?: string): boolean;
}

export interface LiveSessionCoordinatorOptions {
  host: LiveSessionHostControl;
  ensureConversationRuntime: () => Promise<WorkspaceRuntime>;
  workspaceRegistry: WorkspaceRegistry;
  getProviderCredential: () => LiveProviderCredential;
  materializeConversationDirectory: (sessionId: string) => Promise<string>;
  discardEmptyConversationDirectory: (sessionId: string) => Promise<unknown>;
  openRealtimeSession?: typeof openQwenRealtimeSession;
  listRecentSessions?: (
    runtime: WorkspaceRuntime,
  ) => Promise<readonly SessionListItem[]>;
  interruptTaskWaits?: (callerSessionId: string) => void;
  coordinatorTurnTimeoutMs?: number;
  gracefulStopDrainMs?: number;
}

interface LiveCallContext {
  epoch: number;
  callId: string;
  mode: 'resume' | 'new';
  callAbort: AbortController;
  credential?: LiveProviderCredential;
  runtime?: WorkspaceRuntime;
  runtimePromise?: Promise<WorkspaceRuntime>;
  realtime?: QwenRealtimeSession;
  realtimeGeneration: number;
  connectedGeneration?: number;
  resumeCandidate?: SessionListItem;
  coordinator?: LiveSessionLocator;
  coordinatorPromise?: Promise<LiveSessionLocator>;
  coordinatorLease?: BridgeSession;
  coordinatorFresh: boolean;
  coordinatorPromptAdmitted: boolean;
  observerAbort?: AbortController;
  pendingPermissionRequestIds: Set<string>;
  workers: LiveSessionLocator[];
  workerIds: Set<string>;
  pendingWorkerIds: Set<string>;
  delegatesInFlight: number;
  delegateAdmissions: Map<string, DelegateAdmission>;
  activeHandoff?: ActiveHandoff;
  flushBackendContext?: () => void;
  completedInputTranscripts: Map<string, string>;
  partialInputTranscripts: Map<string, string>;
  activePartialInputItemId?: string;
  responseInFlight: boolean;
  speechInProgress: boolean;
  inputCommitPending: boolean;
  inputAwaitingResponse: boolean;
  outputCaption: string;
  outputCaptionResponseId?: string;
  outputCaptionSource?: RealtimeOutputTextEvent['source'];
  realtimeInstructions?: string;
  stopping: boolean;
  stopCompletion?: Promise<void | { error: string }>;
  finishStop?: (outcome?: { error: string }) => void;
  diagnosticInputCapture?: LiveAudioCapture;
  transcriptPersistence: Promise<void>;
  pendingCommittedInputItemIds: Set<string>;
  unattributedCommittedInputCount: number;
  stopDrainTimer?: ReturnType<typeof setTimeout>;
}

interface DelegateAdmission {
  state: 'scheduled' | 'dispatching' | 'admitted' | 'cancelled';
  promise: Promise<boolean>;
  settle: (admitted: boolean) => void;
}

interface ActiveHandoff {
  callId: string;
  generation: number;
  source: QwenRealtimeSession;
  admission: DelegateAdmission;
  turnComplete: Promise<void>;
  finishTurn: () => void;
}

function createTurnCompletion(): Pick<
  ActiveHandoff,
  'turnComplete' | 'finishTurn'
> {
  let resolve!: () => void;
  let settled = false;
  return {
    turnComplete: new Promise<void>((next) => {
      resolve = next;
    }),
    finishTurn: () => {
      if (settled) return;
      settled = true;
      resolve();
    },
  };
}

function createDelegateAdmission(): DelegateAdmission {
  let resolve!: (admitted: boolean) => void;
  let settled = false;
  const admission: DelegateAdmission = {
    state: 'scheduled',
    promise: new Promise<boolean>((next) => {
      resolve = next;
    }),
    settle: (admitted) => {
      if (settled) return;
      settled = true;
      resolve(admitted);
    },
  };
  return admission;
}

interface CollectedTurn {
  text: string;
  stopReason: string;
}

function errorMessage(error: unknown): string {
  return stripTerminalControlSequences(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 500);
}

type ProviderFailureBlocker =
  | 'provider_config'
  | 'provider_unreachable'
  | undefined;

function providerFailureBlocker(error: unknown): ProviderFailureBlocker {
  if (!(error instanceof QwenRealtimeError)) return undefined;
  if (error.kind === 'configuration') return 'provider_config';
  if (error.kind === 'transient') return 'provider_unreachable';
  return undefined;
}

function sessionUpdate(
  event: BridgeEvent,
): Record<string, unknown> | undefined {
  if (event.type !== 'session_update') return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return undefined;
  const update = (data as Record<string, unknown>)['update'];
  return update && typeof update === 'object' && !Array.isArray(update)
    ? (update as Record<string, unknown>)
    : undefined;
}

function updateSource(update: Record<string, unknown>): string | undefined {
  const meta = update['_meta'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta))
    return undefined;
  const source = (meta as Record<string, unknown>)['source'];
  return typeof source === 'string' ? source : undefined;
}

function updateBackgroundTaskId(
  update: Record<string, unknown>,
): string | undefined {
  const meta = update['_meta'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  const backgroundTask = (meta as Record<string, unknown>)['backgroundTask'];
  if (
    !backgroundTask ||
    typeof backgroundTask !== 'object' ||
    Array.isArray(backgroundTask)
  ) {
    return undefined;
  }
  const taskId = (backgroundTask as Record<string, unknown>)['taskId'];
  return typeof taskId === 'string' ? taskId : undefined;
}

function updateText(update: Record<string, unknown>): string {
  const content = update['content'];
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return '';
  }
  const text = (content as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : '';
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_COORDINATOR_RESULT_CHARS) return current;
  return `${current}${chunk.slice(0, MAX_COORDINATOR_RESULT_CHARS - current.length)}`;
}

function isCompatibleLiveSession(item: SessionListItem): boolean {
  return (
    item.parentSessionId === undefined &&
    isCompatibleLiveSessionSource({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
    })
  );
}

function buildDelegationPrompt(
  request: string,
  activeTranscript: readonly RealtimeTranscriptEntry[],
): string {
  const boundedRequest = request.slice(0, MAX_COORDINATOR_REQUEST_CHARS);
  const transcriptDelta = activeTranscript
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join('\n')
    .slice(0, MAX_COORDINATOR_REQUEST_CHARS);
  return [
    '<realtime_delegation>',
    `  <input>${escapeXml(boundedRequest)}</input>`,
    ...(transcriptDelta
      ? [`  <transcript_delta>${escapeXml(transcriptDelta)}</transcript_delta>`]
      : []),
    '</realtime_delegation>',
  ].join('\n');
}

function workerIdFromEvent(event: BridgeEvent): string | undefined {
  const update = sessionUpdate(event);
  if (
    update?.['sessionUpdate'] !== 'tool_call_update' ||
    update['status'] !== 'completed'
  ) {
    return undefined;
  }
  const meta = update['_meta'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  const metaRecord = meta as Record<string, unknown>;
  if (
    metaRecord['toolName'] !== 'create_sub_session' ||
    metaRecord['provenance'] !== 'builtin'
  ) {
    return undefined;
  }
  const rawOutput = update['rawOutput'];
  if (typeof rawOutput !== 'string') return undefined;
  const match =
    /^\[🧵 ([A-Za-z0-9._:-]{1,8})\]\(qwen-session:\/\/([A-Za-z0-9._:-]{1,128})\) (?:started|completed(?: \(stopReason: [A-Za-z0-9._:-]{1,64}\))?)$/.exec(
      rawOutput,
    );
  if (!match?.[1] || !match[2] || match[1] !== match[2].slice(0, 8)) {
    return undefined;
  }
  return match[2];
}

function toolPermissionEvent(
  event: BridgeEvent,
): { requestId: string; pending: boolean } | undefined {
  if (
    event.type !== 'permission_request' &&
    event.type !== 'permission_resolved'
  ) {
    return undefined;
  }
  if (
    typeof event.data !== 'object' ||
    event.data === null ||
    Array.isArray(event.data)
  ) {
    return undefined;
  }
  const data = event.data as Record<string, unknown>;
  const requestId = data['requestId'];
  if (typeof requestId !== 'string' || requestId.length > 256) return undefined;
  if (event.type === 'permission_request') {
    const toolCall = data['toolCall'];
    if (
      typeof toolCall === 'object' &&
      toolCall !== null &&
      !Array.isArray(toolCall)
    ) {
      const meta = (toolCall as Record<string, unknown>)['_meta'];
      if (
        typeof meta === 'object' &&
        meta !== null &&
        !Array.isArray(meta) &&
        (meta as Record<string, unknown>)['qwenInteractionKind'] ===
          'user_question'
      ) {
        return undefined;
      }
    }
  }
  return { requestId, pending: event.type === 'permission_request' };
}

export class LiveSessionCoordinator {
  private readonly openRealtime: typeof openQwenRealtimeSession;
  private readonly turnTimeoutMs: number;
  private readonly gracefulStopDrainMs: number;
  private readonly inFlightTurnAborts = new Set<AbortController>();
  private active?: LiveCallContext;

  constructor(private readonly options: LiveSessionCoordinatorOptions) {
    this.openRealtime = options.openRealtimeSession ?? openQwenRealtimeSession;
    this.turnTimeoutMs =
      options.coordinatorTurnTimeoutMs ?? COORDINATOR_TURN_TIMEOUT_MS;
    this.gracefulStopDrainMs = Math.max(
      1,
      options.gracefulStopDrainMs ?? DEFAULT_GRACEFUL_STOP_DRAIN_MS,
    );
  }

  async speakToUser(callerSessionId: string, message: string): Promise<void> {
    const context = this.active;
    if (
      !context ||
      !this.isActive(context) ||
      context.stopping ||
      context.coordinator?.sessionId !== callerSessionId ||
      !context.realtime
    ) {
      throw new Error('No active Live conversation owns this backend session.');
    }
    context.flushBackendContext?.();
    if (!context.realtime.speakToUser(message)) {
      throw new Error('The active Live conversation could not speak.');
    }
  }

  async start(call: {
    epoch: number;
    callId: string;
    mode: 'resume' | 'new';
  }): Promise<void> {
    await this.closeActiveNow();
    const context: LiveCallContext = {
      ...call,
      callAbort: new AbortController(),
      realtimeGeneration: 0,
      coordinatorFresh: false,
      coordinatorPromptAdmitted: false,
      pendingPermissionRequestIds: new Set(),
      workers: [],
      workerIds: new Set(),
      pendingWorkerIds: new Set(),
      delegatesInFlight: 0,
      delegateAdmissions: new Map(),
      completedInputTranscripts: new Map(),
      partialInputTranscripts: new Map(),
      responseInFlight: false,
      speechInProgress: false,
      inputCommitPending: false,
      inputAwaitingResponse: false,
      outputCaption: '',
      stopping: false,
      transcriptPersistence: Promise.resolve(),
      pendingCommittedInputItemIds: new Set(),
      unattributedCommittedInputCount: 0,
    };
    this.active = context;
    this.options.host.setProviderReachability({ state: 'checking' });
    try {
      context.credential = this.options.getProviderCredential();
      context.runtimePromise = this.prepareConversationRuntime(context);
      const coordinator = await this.ensureCoordinator(context);
      const runtime = context.runtime;
      const currentCwd = context.coordinatorLease?.currentCwd;
      if (!runtime || !currentCwd) {
        throw new Error('Live conversation workspace is unavailable.');
      }
      context.realtimeInstructions = buildQwenRealtimeInstructions(
        await buildRealtimeStartupContext({
          runtime,
          workspaceRegistry: this.options.workspaceRegistry,
          sessionId: coordinator.sessionId,
          currentCwd,
        }),
      );
      await this.connectRealtime(context);
      if (!this.isActive(context) || context.stopping) return;
      if (context.coordinatorFresh && context.coordinator) {
        try {
          context.runtime?.bridge.updateSessionMetadata(
            context.coordinator.sessionId,
            { displayName: 'Voice chat' },
          );
        } catch {
          /* the session remains usable when a title write fails */
        }
      }
      this.options.host.setProviderReachability(undefined);
      this.options.host.setCaption(context.epoch, '');
      this.options.host.setStatusText(context.epoch);
      this.options.host.setCallState(context.epoch, 'listening');
    } catch (error) {
      if (!this.isActive(context)) return;
      this.failContext(
        context,
        `Live Voice failed to start: ${errorMessage(error)}`,
        providerFailureBlocker(error),
      );
    }
  }

  private async prepareConversationRuntime(
    context: LiveCallContext,
  ): Promise<WorkspaceRuntime> {
    const runtime = await this.options.ensureConversationRuntime();
    if (!this.isActive(context)) {
      throw new DOMException('Live call ended.', 'AbortError');
    }
    context.runtime = runtime;
    if (context.mode === 'resume') {
      context.resumeCandidate = this.options.listRecentSessions
        ? (await this.options.listRecentSessions(runtime)).find(
            isCompatibleLiveSession,
          )
        : await this.findRecentCompatibleSession(runtime);
    }
    if (!this.isActive(context)) {
      throw new DOMException('Live call ended.', 'AbortError');
    }
    return runtime;
  }

  stop(call: {
    epoch: number;
    callId: string;
  }): Promise<void | { error: string }> {
    if (
      !this.active ||
      this.active.epoch !== call.epoch ||
      this.active.callId !== call.callId
    ) {
      return Promise.resolve();
    }
    return this.beginGracefulStop(this.active);
  }

  pushAudio(call: { epoch: number; callId: string; pcm16: Buffer }): boolean {
    if (
      !this.active ||
      this.active.epoch !== call.epoch ||
      this.active.callId !== call.callId ||
      this.active.stopping
    ) {
      return false;
    }
    const context = this.active;
    context.diagnosticInputCapture ??= openLiveAudioCapture(
      'daemon-input',
      call.callId,
    );
    if (context.diagnosticInputCapture) {
      context.diagnosticInputCapture.bytes += call.pcm16.byteLength;
      context.diagnosticInputCapture.hash.update(call.pcm16);
      context.diagnosticInputCapture.stream.write(Buffer.from(call.pcm16));
    }
    return context.realtime?.pushAudio(call.pcm16) ?? false;
  }

  dispose(): void {
    void this.closeActiveNow();
    for (const abort of this.inFlightTurnAborts) abort.abort();
  }

  private async findRecentCompatibleSession(
    runtime: WorkspaceRuntime,
  ): Promise<SessionListItem | undefined> {
    const service = new SessionService(runtime.workspaceCwd);
    let cursor: number | undefined;
    const seenCursors = new Set<number>();
    while (true) {
      const page = await service.listSessions({
        size: SESSION_SCAN_SIZE,
        archiveState: 'active',
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const match = page.items.find(isCompatibleLiveSession);
      if (match) return match;
      if (!page.hasMore || page.nextCursor === undefined) return undefined;
      if (seenCursors.has(page.nextCursor)) return undefined;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private callbacksFor(
    context: LiveCallContext,
    generation: number,
  ): QwenRealtimeCallbacks {
    let diagnosticResponseId: string | undefined;
    let diagnosticAudioFrames = 0;
    let diagnosticAudioBytes = 0;
    let diagnosticFirstAudioAt: number | undefined;
    let diagnosticAudioCapture: LiveAudioCapture | undefined;
    const diagnostic = (
      event: string,
      details: Readonly<
        Record<string, string | number | boolean | undefined>
      > = {},
    ): void => {
      writeLiveDiagnostic(event, {
        epoch: context.epoch,
        generation,
        ...details,
      });
    };
    return {
      onReady: () => diagnostic('realtime_ready'),
      onSpeechStarted: ({ itemId }) => {
        if (!this.isInteractiveSocket(context, generation)) return;
        diagnostic('speech_started', {
          hasItemId: itemId !== undefined,
          responseId: diagnosticResponseId,
          outputFrames: diagnosticAudioFrames,
          outputBytes: diagnosticAudioBytes,
          clearReason: 'speech_started',
        });
        context.speechInProgress = true;
        context.inputCommitPending = true;
        context.inputAwaitingResponse = false;
        const partialItemId = itemId ?? `partial:${randomUUID()}`;
        context.activePartialInputItemId = partialItemId;
        if (!context.partialInputTranscripts.has(partialItemId)) {
          context.partialInputTranscripts.set(partialItemId, '');
        }
        this.options.host.clearOutput(context.epoch);
        this.options.host.setCaption(context.epoch, '');
        this.options.host.setStatusText(context.epoch);
        this.options.host.setCallState(context.epoch, 'listening');
      },
      onSpeechStopped: () => {
        if (!this.isCurrentSocket(context, generation)) return;
        diagnostic('speech_stopped');
        context.speechInProgress = false;
        if (!context.stopping) {
          this.options.host.setStatusText(context.epoch);
          this.options.host.setCallState(context.epoch, 'thinking');
        }
      },
      onInputCommitted: ({ itemId }) => {
        if (!this.isCurrentSocket(context, generation)) return;
        diagnostic('input_committed');
        context.speechInProgress = false;
        context.inputCommitPending = false;
        context.inputAwaitingResponse = true;
        if (itemId) context.pendingCommittedInputItemIds.add(itemId);
        else context.unattributedCommittedInputCount += 1;
      },
      onInputTranscriptDelta: ({ itemId, text }) => {
        if (this.isCurrentSocket(context, generation)) {
          const partialItemId =
            itemId ??
            context.activePartialInputItemId ??
            `partial:${randomUUID()}`;
          context.activePartialInputItemId = partialItemId;
          context.partialInputTranscripts.set(partialItemId, text);
          this.options.host.setTranscript?.(context.epoch, text);
        }
      },
      onInputTranscriptDone: ({ itemId, text }) => {
        if (this.isCurrentSocket(context, generation)) {
          context.speechInProgress = false;
          context.inputCommitPending = false;
          const completedItemId =
            itemId ??
            context.activePartialInputItemId ??
            `unattributed:${randomUUID()}`;
          context.partialInputTranscripts.delete(completedItemId);
          if (context.activePartialInputItemId === completedItemId) {
            context.activePartialInputItemId = undefined;
          }
          this.options.host.setTranscript?.(context.epoch, text);
          if (text.trim()) {
            context.completedInputTranscripts.set(completedItemId, text);
          }
        }
      },
      onDelegateCall: (event) => {
        if (!this.isCurrentSocket(context, generation)) return;
        const source = context.realtime;
        if (!source) return;
        let trackedInputItemId = event.inputItemId;
        if (!trackedInputItemId) {
          const matchingInputs = [
            ...context.completedInputTranscripts.entries(),
          ].filter(([, transcript]) => transcript === event.request);
          trackedInputItemId =
            matchingInputs.length === 1
              ? matchingInputs[0]![0]
              : `delegate:${event.callId}`;
        }
        if (event.request.trim()) {
          context.completedInputTranscripts.set(
            trackedInputItemId,
            event.request,
          );
        }
        const admission = createDelegateAdmission();
        context.delegateAdmissions.set(trackedInputItemId, admission);
        context.delegatesInFlight += 1;
        const markPromptAdmitted = () => {
          admission.state = 'admitted';
          this.resolveCommittedInput(context, trackedInputItemId);
          admission.settle(true);
          this.maybeFinishGracefulStop(context);
        };
        const activeHandoff = context.activeHandoff;
        if (activeHandoff) {
          admission.state = 'dispatching';
          void this.handleSteering(
            context,
            event,
            generation,
            source,
            activeHandoff,
            markPromptAdmitted,
          )
            .then((persisted) => {
              if (!persisted) {
                admission.state = 'cancelled';
                admission.settle(false);
              } else {
                context.completedInputTranscripts.delete(trackedInputItemId);
              }
            })
            .catch(() => {
              admission.state = 'cancelled';
              admission.settle(false);
            })
            .finally(() => {
              if (admission.state === 'dispatching') {
                admission.state = 'cancelled';
              }
              admission.settle(admission.state === 'admitted');
              context.delegatesInFlight = Math.max(
                0,
                context.delegatesInFlight - 1,
              );
              if (
                context.delegateAdmissions.get(trackedInputItemId) === admission
              ) {
                context.delegateAdmissions.delete(trackedInputItemId);
              }
              this.maybeFinishGracefulStop(context);
            });
          return;
        }

        admission.state = 'dispatching';
        const handoff: ActiveHandoff = {
          callId: event.callId,
          generation,
          source,
          admission,
          ...createTurnCompletion(),
        };
        context.activeHandoff = handoff;
        void this.handleDelegate(
          context,
          event,
          generation,
          source,
          markPromptAdmitted,
        )
          .then((persisted) => {
            if (!persisted) {
              admission.state = 'cancelled';
              admission.settle(false);
              return;
            }
            context.completedInputTranscripts.delete(trackedInputItemId);
          })
          .catch(() => {
            admission.state = 'cancelled';
            admission.settle(false);
          })
          .finally(() => {
            handoff.finishTurn();
            if (context.activeHandoff === handoff) {
              context.activeHandoff = undefined;
            }
            if (admission.state === 'dispatching') {
              admission.state = 'cancelled';
            }
            admission.settle(admission.state === 'admitted');
            context.delegatesInFlight = Math.max(
              0,
              context.delegatesInFlight - 1,
            );
            if (
              context.delegateAdmissions.get(trackedInputItemId) === admission
            ) {
              context.delegateAdmissions.delete(trackedInputItemId);
            }
            this.maybeFinishGracefulStop(context);
          });
      },
      onDirectTranscript: ({ entries }) => {
        if (!this.isCurrentSocket(context, generation)) return;
        this.queueRealtimeTranscript(context, entries);
      },
      onResponseCreated: ({ responseId, authority }) => {
        if (!this.isCurrentSocket(context, generation)) return;
        closeLiveAudioCapture(diagnosticAudioCapture, 'next_response');
        diagnosticAudioCapture = openLiveAudioCapture(
          'provider-output',
          responseId,
        );
        diagnosticResponseId = responseId;
        diagnosticAudioFrames = 0;
        diagnosticAudioBytes = 0;
        diagnosticFirstAudioAt = undefined;
        diagnostic('response_created', { responseId, authority });
        context.speechInProgress = false;
        context.inputCommitPending = false;
        context.inputAwaitingResponse = false;
        context.responseInFlight = true;
        if (!context.stopping) {
          context.outputCaption = '';
          context.outputCaptionResponseId = responseId;
          context.outputCaptionSource = undefined;
          this.options.host.setCaption(context.epoch, '');
          this.options.host.setStatusText(context.epoch);
          this.options.host.setCallState(context.epoch, 'thinking');
        }
      },
      onOutputTextDelta: (event) => {
        this.updateOutputCaption(context, generation, event, false);
      },
      onOutputTextDone: (event) => {
        this.updateOutputCaption(context, generation, event, true);
      },
      onOutputAudioDelta: ({ responseId, audio }) => {
        if (!this.isInteractiveSocket(context, generation)) return;
        diagnosticAudioFrames += 1;
        diagnosticAudioBytes += audio.byteLength;
        if (diagnosticAudioCapture) {
          diagnosticAudioCapture.bytes += audio.byteLength;
          diagnosticAudioCapture.hash.update(audio);
          diagnosticAudioCapture.stream.write(Buffer.from(audio));
        }
        if (diagnosticFirstAudioAt === undefined) {
          diagnosticFirstAudioAt = Date.now();
          diagnostic('output_audio_first', {
            responseId,
            frameBytes: audio.byteLength,
          });
        }
        if (!this.options.host.sendOutputAudio(context.epoch, audio)) {
          diagnostic('output_audio_rejected', {
            responseId,
            outputFrames: diagnosticAudioFrames,
            outputBytes: diagnosticAudioBytes,
          });
          this.failContext(
            context,
            'Live Host could not accept realtime output audio.',
            undefined,
          );
          return;
        }
        this.options.host.setCallState(context.epoch, 'speaking');
      },
      onOutputAudioDone: ({ responseId }) => {
        if (!this.isCurrentSocket(context, generation)) return;
        diagnostic('output_audio_done', {
          responseId,
          outputFrames: diagnosticAudioFrames,
          outputBytes: diagnosticAudioBytes,
          outputDurationMs:
            diagnosticFirstAudioAt === undefined
              ? undefined
              : Date.now() - diagnosticFirstAudioAt,
        });
      },
      onAudioDropped: () => {
        if (!this.isInteractiveSocket(context, generation)) return;
        this.failContext(
          context,
          'Realtime input audio was dropped before reaching the provider.',
          undefined,
        );
      },
      onResponseDone: ({ responseId, inputItemId, status }) => {
        if (!this.isCurrentSocket(context, generation)) return;
        if (diagnosticResponseId !== responseId) {
          diagnostic('response_done_stale', { responseId, status });
          this.resolveCommittedInput(context, inputItemId);
          if (inputItemId) {
            context.completedInputTranscripts.delete(inputItemId);
          }
          this.maybeFinishGracefulStop(context);
          return;
        }
        diagnostic('response_done', {
          responseId,
          status,
          outputFrames: diagnosticAudioFrames,
          outputBytes: diagnosticAudioBytes,
          outputDurationMs:
            diagnosticFirstAudioAt === undefined
              ? undefined
              : Date.now() - diagnosticFirstAudioAt,
        });
        closeLiveAudioCapture(diagnosticAudioCapture, status ?? 'done');
        diagnosticAudioCapture = undefined;
        if (diagnosticResponseId === responseId) {
          diagnosticResponseId = undefined;
        }
        context.responseInFlight = false;
        context.inputAwaitingResponse = false;
        this.resolveCommittedInput(context, inputItemId);
        if (inputItemId) {
          context.completedInputTranscripts.delete(inputItemId);
        }
        if (!context.stopping && context.delegatesInFlight === 0) {
          this.options.host.setStatusText(context.epoch);
          this.options.host.setCallState(context.epoch, 'listening');
        }
        this.maybeFinishGracefulStop(context);
      },
      onBargeIn: ({ responseId }) => {
        if (!this.isInteractiveSocket(context, generation)) return;
        diagnostic('barge_in', {
          responseId,
          outputFrames: diagnosticAudioFrames,
          outputBytes: diagnosticAudioBytes,
          clearReason: 'barge_in',
        });
        this.options.host.clearOutput(context.epoch);
        this.options.host.setCaption(context.epoch, '');
        this.options.host.setStatusText(context.epoch);
        this.options.host.setCallState(context.epoch, 'listening');
      },
      onError: (error) => {
        if (!this.isCurrentSocket(context, generation) || !error.fatal) return;
        this.failContext(context, error.message, providerFailureBlocker(error));
      },
      onClose: (info) => {
        closeLiveAudioCapture(diagnosticAudioCapture, `socket_${info.reason}`);
        diagnosticAudioCapture = undefined;
        this.handleRealtimeClose(context, generation, info);
      },
    };
  }

  private async connectRealtime(context: LiveCallContext): Promise<void> {
    const credential = context.credential;
    if (!credential)
      throw new Error('Live provider credential is unavailable.');
    if (!this.isActive(context) || context.stopping) {
      throw new DOMException('Live call ended.', 'AbortError');
    }
    const generation = ++context.realtimeGeneration;
    const realtime = await this.openRealtime(
      {
        endpoint: credential.endpoint,
        apiKey: credential.apiKey,
        model: credential.realtimeModel,
        voice: credential.voice,
        callEpoch: context.epoch,
        instructions: context.realtimeInstructions,
      },
      this.callbacksFor(context, generation),
      { abortSignal: context.callAbort.signal },
    );
    if (
      !this.isActive(context) ||
      context.stopping ||
      context.realtimeGeneration !== generation
    ) {
      realtime.close();
      throw new DOMException('Live call ended.', 'AbortError');
    }
    context.realtime = realtime;
    context.connectedGeneration = generation;
    context.responseInFlight = false;
    context.speechInProgress = false;
    context.inputCommitPending = false;
    context.inputAwaitingResponse = false;
    context.activePartialInputItemId = undefined;
    context.outputCaption = '';
    context.outputCaptionResponseId = undefined;
    context.outputCaptionSource = undefined;
    context.partialInputTranscripts.clear();
    context.completedInputTranscripts.clear();
    context.delegateAdmissions.clear();
    context.pendingCommittedInputItemIds.clear();
    context.unattributedCommittedInputCount = 0;
  }

  private handleRealtimeClose(
    context: LiveCallContext,
    generation: number,
    info: RealtimeCloseInfo,
  ): void {
    if (
      info.reason === 'client' ||
      !this.isCurrentSocket(context, generation)
    ) {
      return;
    }
    if (context.stopping) return;
    this.failContext(
      context,
      info.error?.message ?? 'Realtime provider disconnected.',
      providerFailureBlocker(info.error),
    );
  }

  private beginGracefulStop(
    context: LiveCallContext,
  ): Promise<void | { error: string }> {
    if (context.stopCompletion) return context.stopCompletion;
    context.stopCompletion = new Promise((resolve) => {
      context.finishStop = resolve;
    });
    if (!this.isActive(context)) {
      context.finishStop?.();
      return context.stopCompletion;
    }
    context.stopping = true;
    closeLiveAudioCapture(context.diagnosticInputCapture, 'call_stopping');
    context.diagnosticInputCapture = undefined;
    this.options.host.clearOutput(context.epoch);
    if (!this.hasPendingStopTail(context)) {
      void this.finishGracefulStop(context);
      return context.stopCompletion;
    }
    context.stopDrainTimer = setTimeout(() => {
      void this.finishGracefulStop(
        context,
        {
          error:
            'Live Voice could not confirm the final spoken input before the stop deadline.',
        },
        true,
      );
    }, this.gracefulStopDrainMs);
    context.stopDrainTimer.unref?.();
    if (context.speechInProgress || context.inputCommitPending) {
      let committed = false;
      try {
        committed = context.realtime?.commitInputAudio() ?? false;
      } catch {
        committed = false;
      }
      if (!committed) {
        void this.finishGracefulStop(
          context,
          {
            error: 'Live Voice could not commit the final spoken input.',
          },
          true,
        );
      }
    }
    return context.stopCompletion;
  }

  private hasPendingStopTail(context: LiveCallContext): boolean {
    return (
      context.speechInProgress ||
      context.inputCommitPending ||
      context.pendingCommittedInputItemIds.size > 0 ||
      context.unattributedCommittedInputCount > 0 ||
      [...context.delegateAdmissions.values()].some(
        (admission) => admission.state === 'dispatching',
      )
    );
  }

  private resolveCommittedInput(
    context: LiveCallContext,
    itemId: string | undefined,
  ): void {
    if (itemId) context.pendingCommittedInputItemIds.delete(itemId);
    else if (context.unattributedCommittedInputCount > 0) {
      context.unattributedCommittedInputCount -= 1;
    }
  }

  private maybeFinishGracefulStop(context: LiveCallContext): void {
    if (
      !this.isActive(context) ||
      !context.stopping ||
      !context.finishStop ||
      this.hasPendingStopTail(context)
    ) {
      return;
    }
    void this.finishGracefulStop(context);
  }

  private queueRealtimeTranscript(
    context: LiveCallContext,
    transcript: readonly RealtimeTranscriptEntry[],
  ): void {
    if (transcript.length === 0) return;
    const next = context.transcriptPersistence.then(() =>
      this.persistRealtimeTranscript(context, transcript),
    );
    context.transcriptPersistence = next;
    void next.catch((error: unknown) => {
      if (context.stopping) return;
      this.failContext(
        context,
        `Live Voice could not persist the realtime transcript: ${errorMessage(error)}`,
        undefined,
      );
    });
  }

  private async persistRealtimeTranscript(
    context: LiveCallContext,
    transcript: readonly RealtimeTranscriptEntry[],
  ): Promise<void> {
    const runtime = context.runtime;
    const sessionId = context.coordinator?.sessionId;
    const model = context.credential?.realtimeModel;
    if (!runtime || !sessionId || !model || !this.isActive(context)) {
      throw new Error('Live conversation session is unavailable.');
    }
    await runtime.bridge.appendSessionLiveTranscript(
      sessionId,
      transcript,
      model,
    );
    context.coordinatorPromptAdmitted = true;
  }

  private async finishGracefulStop(
    context: LiveCallContext,
    outcome?: { error: string },
    discardPendingInput = false,
  ): Promise<void> {
    if (!this.isActive(context) || !context.finishStop) return;
    const finish = context.finishStop;
    context.finishStop = undefined;
    if (context.stopDrainTimer) {
      clearTimeout(context.stopDrainTimer);
      context.stopDrainTimer = undefined;
    }
    const realtime = context.realtime;
    const transcriptTail = realtime?.takeTranscriptTail() ?? [];
    try {
      await context.transcriptPersistence;
      if (transcriptTail.length > 0) {
        await this.persistRealtimeTranscript(context, transcriptTail);
      }
    } catch {
      outcome ??= {
        error: 'Live Voice could not persist the final transcript.',
      };
    }
    if (discardPendingInput) {
      this.invalidateRealtime(context);
      realtime?.close({ discardPendingInput: true });
    }
    await this.closeContext(context);
    finish?.(outcome);
  }

  private failContext(
    context: LiveCallContext,
    message: string,
    providerBlocker: ProviderFailureBlocker,
  ): void {
    if (!this.isActive(context)) return;
    if (context.stopping) {
      void this.finishGracefulStop(context, { error: message }, true);
    } else {
      context.stopping = true;
      this.options.host.failCall(context.epoch, message);
      void this.closeContext(context);
    }
    this.options.host.setProviderReachability(
      providerBlocker === 'provider_config'
        ? {
            state: 'unavailable',
            blocker: providerBlocker,
            message,
          }
        : undefined,
    );
  }

  private async handleSteering(
    context: LiveCallContext,
    event: RealtimeDelegateCall,
    generation: number,
    source: QwenRealtimeSession,
    activeHandoff: ActiveHandoff,
    onPromptAdmitted: () => void,
  ): Promise<boolean> {
    if (
      !this.isActive(context) ||
      context.activeHandoff !== activeHandoff ||
      activeHandoff.source !== source ||
      activeHandoff.generation !== generation
    ) {
      return false;
    }
    if (!(await activeHandoff.admission.promise)) return false;
    if (
      !this.isCurrentSocket(context, generation) ||
      context.realtime !== source
    ) {
      return false;
    }
    const locator = await this.ensureCoordinator(context);
    this.options.interruptTaskWaits?.(locator.sessionId);
    const runtime = context.runtime;
    if (!runtime) return false;
    const modelPrompt = buildDelegationPrompt(
      event.request,
      event.activeTranscript,
    );
    const runAsNextTurn = async (notifyAdmission: boolean) => {
      if (
        !this.isCurrentSocket(context, generation) ||
        context.realtime !== source
      ) {
        return false;
      }
      let admitted = false;
      await this.runCoordinatorTurn(
        context,
        locator,
        event.request,
        modelPrompt,
        () => {
          admitted = true;
          if (notifyAdmission) onPromptAdmitted();
        },
        (message) => {
          if (this.isCurrentSocket(context, generation)) {
            source.sendBackendContext(message);
          }
        },
      );
      return admitted;
    };
    // `queueOnly`: if the turn already settled, promotion would run this
    // steering as a bare prompt no coordinator collector subscribes to — the
    // response would never reach the Realtime source, and no turn deadline
    // would apply. Rejecting the idle case keeps the `runCoordinatorTurn`
    // fallback in charge of the next turn.
    const routed = runtime.bridge.enqueueMidTurnMessage(
      locator.sessionId,
      modelPrompt,
      undefined,
      undefined,
      {
        queueOnly: true,
        onSettledWithoutDrain: () => {
          void runAsNextTurn(false).catch((error: unknown) => {
            if (
              this.isCurrentSocket(context, generation) &&
              context.realtime === source
            ) {
              source.sendBackendContext(
                `The Qwen Code agent could not complete the request: ${errorMessage(error)}`,
              );
            }
          });
        },
      },
    );
    if (routed.accepted) {
      onPromptAdmitted();
      return true;
    }

    await activeHandoff.turnComplete;
    return runAsNextTurn(true);
  }

  private async handleDelegate(
    context: LiveCallContext,
    event: RealtimeDelegateCall,
    generation: number,
    source: QwenRealtimeSession,
    onPromptAdmitted: () => void,
  ): Promise<boolean> {
    if (!this.isActive(context)) return false;
    if (!context.stopping) {
      this.options.host.setStatusText(context.epoch);
      this.options.host.setCallState(context.epoch, 'thinking');
    }
    let persisted = false;
    try {
      await context.transcriptPersistence;
      const locator = await this.ensureCoordinator(context);
      if (!this.isActive(context)) return false;
      await this.runCoordinatorTurn(
        context,
        locator,
        event.request,
        buildDelegationPrompt(event.request, event.activeTranscript),
        onPromptAdmitted,
        (message) => {
          if (
            this.isCurrentSocket(context, generation) &&
            context.realtime === source
          ) {
            source.sendHandoffUpdate({
              callEpoch: context.epoch,
              callId: event.callId,
              output: message,
            });
          }
        },
      );
      persisted = true;
    } catch (error) {
      const message = `The Qwen Code agent could not complete the request: ${errorMessage(error)}`;
      if (
        this.isCurrentSocket(context, generation) &&
        context.realtime === source
      ) {
        source.sendHandoffUpdate({
          callEpoch: context.epoch,
          callId: event.callId,
          output: message,
        });
      }
    }
    if (
      this.isCurrentSocket(context, generation) &&
      context.realtime === source &&
      source.completeHandoff({
        callEpoch: context.epoch,
        callId: event.callId,
      })
    ) {
      return persisted;
    }
    return persisted;
  }

  private async ensureCoordinator(
    context: LiveCallContext,
  ): Promise<LiveSessionLocator> {
    if (context.coordinator) return context.coordinator;
    await context.runtimePromise;
    if (!this.isActive(context)) {
      throw new DOMException('Live call ended.', 'AbortError');
    }
    context.coordinatorPromise ??= this.createOrResumeCoordinator(
      context,
    ).catch((error) => {
      context.coordinatorPromise = undefined;
      throw error;
    });
    return context.coordinatorPromise;
  }

  private async createOrResumeCoordinator(
    context: LiveCallContext,
  ): Promise<LiveSessionLocator> {
    const runtime = context.runtime;
    if (!runtime) throw new Error('Conversation workspace is unavailable.');
    let sessionId: string | undefined;
    let sessionLease: BridgeSession | undefined;
    let sessionLeaseIsFresh = false;
    const candidate = context.resumeCandidate;
    if (candidate) {
      try {
        const resumed = await runtime.bridge.resumeSession({
          sessionId: normalizeSessionIdForLookup(candidate.sessionId),
          workspaceCwd: runtime.workspaceCwd,
          ...(candidate.parentSessionId
            ? { parentSessionId: candidate.parentSessionId }
            : {}),
          ...(candidate.sourceType ? { sourceType: candidate.sourceType } : {}),
          ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
        });
        await this.prepareCoordinatorSession(context, runtime, resumed, false);
        sessionId = resumed.sessionId;
        sessionLease = resumed;
      } catch (error) {
        context.resumeCandidate = undefined;
        if (!this.isActive(context)) throw error;
        if (
          !(error instanceof SessionNotFoundError) &&
          !(error instanceof SessionArchivedError)
        ) {
          this.failContext(
            context,
            `Resuming the Live conversation failed: ${errorMessage(error)}`,
            undefined,
          );
          throw error;
        }
      }
    }
    if (!sessionId) {
      const created = await runtime.bridge.spawnOrAttach({
        workspaceCwd: runtime.workspaceCwd,
        sessionScope: 'thread',
        sourceType: 'default',
        sourceId: `${LIVE_SESSION_SOURCE_PREFIX}${context.callId}`,
      });
      await this.prepareCoordinatorSession(context, runtime, created, true);
      sessionId = created.sessionId;
      sessionLease = created;
      sessionLeaseIsFresh = true;
    }
    const locator = {
      workspaceCwd: runtime.workspaceCwd,
      workspaceId: runtime.workspaceId,
      sessionId,
    };
    if (!this.isActive(context)) {
      if (sessionLease) {
        await this.rollbackPreparedCoordinator(
          runtime,
          sessionLease,
          sessionLeaseIsFresh,
        );
      }
      throw new DOMException('Live call ended.', 'AbortError');
    }
    if (!this.options.host.setCoordinator(context.epoch, locator)) {
      if (sessionLease) {
        await this.rollbackPreparedCoordinator(
          runtime,
          sessionLease,
          sessionLeaseIsFresh,
        );
      }
      throw new DOMException('Live call ended.', 'AbortError');
    }
    context.coordinator = locator;
    context.coordinatorLease = sessionLease;
    context.coordinatorFresh = sessionLeaseIsFresh;
    if (!context.stopping) {
      this.startBackgroundObserver(context, runtime.bridge, sessionId);
    }
    return locator;
  }

  private async prepareCoordinatorSession(
    context: LiveCallContext,
    runtime: WorkspaceRuntime,
    session: BridgeSession,
    requirePersistedSource: boolean,
  ): Promise<void> {
    try {
      if (requirePersistedSource && session.sourcePersisted !== true) {
        throw new Error(
          'Live session source metadata was not persisted safely.',
        );
      }
      const conversationCwd =
        await this.options.materializeConversationDirectory(session.sessionId);
      if (!this.isActive(context)) {
        throw new DOMException('Live call ended.', 'AbortError');
      }
      if (!requirePersistedSource && session.hasActivePrompt === true) {
        if (session.currentCwd !== conversationCwd) {
          throw new Error(
            'Active Live session is outside its isolated conversation directory.',
          );
        }
        await runtime.bridge.setSessionLiveConversationActive(
          session.sessionId,
          true,
        );
        return;
      }
      const changed = await runtime.bridge.changeSessionCwd(session.sessionId, {
        path: conversationCwd,
        allowedRoots: [runtime.workspaceCwd],
        managedRelocation: 'live-conversation',
      });
      if (changed.newCwd !== conversationCwd) {
        throw new Error('Live session directory relocation was rejected.');
      }
      session.currentCwd = changed.newCwd;
      await runtime.bridge.setSessionLiveConversationActive(
        session.sessionId,
        true,
      );
      if (!this.isActive(context)) {
        throw new DOMException('Live call ended.', 'AbortError');
      }
    } catch (error) {
      await this.rollbackPreparedCoordinator(
        runtime,
        session,
        requirePersistedSource,
      );
      throw error;
    }
  }

  private async rollbackPreparedCoordinator(
    runtime: WorkspaceRuntime,
    session: BridgeSession,
    removeFreshTranscript: boolean,
  ): Promise<void> {
    const bridge = runtime.bridge;
    let sessionClosed = false;
    try {
      if (session.hasActivePrompt === true) {
        if (session.clientId) {
          await bridge.detachClient(session.sessionId, session.clientId);
        }
      } else if (session.attached) {
        if (session.clientId) {
          await bridge.detachClient(session.sessionId, session.clientId);
        }
      } else {
        sessionClosed = await bridge.killSession(session.sessionId, {
          requireZeroAttaches: true,
        });
      }
    } catch {
      /* preserve the original setup failure */
    }
    if (!sessionClosed) return;
    if (removeFreshTranscript) {
      try {
        const transcriptRemoved = await new SessionService(
          runtime.workspaceCwd,
        ).removeSession(session.sessionId);
        if (transcriptRemoved) bridge.markSessionCatalogChanged();
      } catch {
        /* preserve the original setup failure */
      }
    }
    try {
      await this.options.discardEmptyConversationDirectory(session.sessionId);
    } catch {
      /* preserve the original setup failure */
    }
  }

  private async runCoordinatorTurn(
    context: LiveCallContext,
    locator: LiveSessionLocator,
    prompt: string,
    modelPrompt: string,
    onPromptAdmitted?: () => void,
    onAgentMessage?: (text: string) => void,
  ): Promise<CollectedTurn> {
    const runtime = context.runtime;
    if (!runtime) throw new Error('Conversation workspace is unavailable.');
    const bridge = runtime.bridge;
    const promptId = randomUUID();
    const lastEventId = bridge.getSessionLastEventId(locator.sessionId);
    const turnAbort = new AbortController();
    this.inFlightTurnAborts.add(turnAbort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      turnAbort.abort();
    }, this.turnTimeoutMs);
    timer.unref?.();
    const signal = turnAbort.signal;
    let text = '';
    let agentMessage = '';
    let agentMessageTimer: ReturnType<typeof setTimeout> | undefined;
    let stopReason: string | undefined;
    const flushAgentMessage = () => {
      if (agentMessageTimer) {
        clearTimeout(agentMessageTimer);
        agentMessageTimer = undefined;
      }
      if (!agentMessage.trim()) return;
      onAgentMessage?.(agentMessage);
      agentMessage = '';
    };
    const scheduleAgentMessageFlush = () => {
      if (agentMessageTimer || !agentMessage.trim()) return;
      agentMessageTimer = setTimeout(
        flushAgentMessage,
        BACKEND_CONTEXT_FLUSH_MS,
      );
      agentMessageTimer.unref?.();
    };
    context.flushBackendContext = flushAgentMessage;
    const collect = (async () => {
      for await (const event of bridge.subscribeEvents(locator.sessionId, {
        lastEventId,
        signal,
      })) {
        await this.captureWorker(context, event);
        if (event.promptId !== promptId) continue;
        const update = sessionUpdate(event);
        this.updateCoordinatorStatus(context, update);
        if (update?.['sessionUpdate'] === 'agent_message_chunk') {
          const chunk = updateText(update);
          text = appendBounded(text, chunk);
          agentMessage = appendBounded(agentMessage, chunk);
          scheduleAgentMessageFlush();
        } else if (update?.['sessionUpdate'] === 'tool_call') {
          flushAgentMessage();
        } else if (event.type === 'turn_complete') {
          flushAgentMessage();
          this.options.host.setStatusText(context.epoch);
          const data = event.data as { stopReason?: unknown };
          stopReason =
            typeof data?.stopReason === 'string' ? data.stopReason : 'end_turn';
          break;
        } else if (event.type === 'turn_error') {
          this.options.host.setStatusText(context.epoch);
          const data = event.data as { message?: unknown };
          if (typeof data?.message === 'string') {
            text = appendBounded(text, `${text ? '\n' : ''}${data.message}`);
            agentMessage = appendBounded(
              agentMessage,
              `${agentMessage ? '\n' : ''}${data.message}`,
            );
          }
          flushAgentMessage();
          stopReason = 'error';
          break;
        }
      }
    })();
    try {
      try {
        const turn = bridge.sendPrompt(
          locator.sessionId,
          {
            sessionId: locator.sessionId,
            prompt: [{ type: 'text', text: prompt }],
          },
          signal,
          {
            promptId,
            modelPrompt,
            deadlineMs: this.turnTimeoutMs,
            onPromptAdmitted: () => {
              context.coordinatorPromptAdmitted = true;
              onPromptAdmitted?.();
            },
          },
        );
        await turn;
        await collect;
      } catch (error) {
        if (timedOut) throw new Error('Live backend turn timed out.');
        throw error;
      }
      if (!stopReason) {
        if (timedOut) throw new Error('Live backend turn timed out.');
        if (signal.aborted) {
          throw new DOMException('Live backend turn cancelled.', 'AbortError');
        }
        throw new Error('Live backend event stream ended before the turn.');
      }
      return { text, stopReason };
    } finally {
      flushAgentMessage();
      if (context.flushBackendContext === flushAgentMessage) {
        context.flushBackendContext = undefined;
      }
      if (this.isActive(context)) {
        this.options.host.setStatusText(context.epoch);
      }
      clearTimeout(timer);
      turnAbort.abort();
      await collect.catch(() => undefined);
      this.inFlightTurnAborts.delete(turnAbort);
    }
  }

  private startBackgroundObserver(
    context: LiveCallContext,
    bridge: AcpSessionBridge,
    sessionId: string,
  ): void {
    context.observerAbort?.abort();
    const observerAbort = new AbortController();
    context.observerAbort = observerAbort;
    const signal = AbortSignal.any([
      context.callAbort.signal,
      observerAbort.signal,
    ]);
    const lastEventId = bridge.getSessionLastEventId(sessionId);
    context.pendingPermissionRequestIds.clear();
    for (const interaction of bridge.getSessionSummary(sessionId)
      .pendingInteractions ?? []) {
      if (interaction.kind === 'permission') {
        context.pendingPermissionRequestIds.add(interaction.requestId);
      }
    }
    this.options.host.setPendingPermission(
      context.epoch,
      context.pendingPermissionRequestIds.size > 0,
    );
    void (async () => {
      let announcement = '';
      let response = '';
      let backgroundTaskId: string | undefined;
      try {
        for await (const event of bridge.subscribeEvents(sessionId, {
          lastEventId,
          signal,
        })) {
          const permission = toolPermissionEvent(event);
          if (permission) {
            if (permission.pending) {
              context.pendingPermissionRequestIds.add(permission.requestId);
            } else {
              context.pendingPermissionRequestIds.delete(permission.requestId);
            }
            this.options.host.setPendingPermission(
              context.epoch,
              context.pendingPermissionRequestIds.size > 0,
            );
          }
          await this.captureWorker(context, event);
          const update = sessionUpdate(event);
          if (update?.['sessionUpdate'] === 'agent_message_chunk') {
            const source = updateSource(update);
            if (source === 'background_notification') {
              announcement = updateText(update);
              response = '';
              backgroundTaskId = updateBackgroundTaskId(update);
            } else if (source === 'background_notification_response') {
              response = appendBounded(response, updateText(update));
            }
          }
          if (event.type === 'background_notification_turn_complete') {
            const spoken = response.trim() || announcement.trim();
            if (
              spoken &&
              backgroundTaskId !== undefined &&
              context.workerIds.has(backgroundTaskId) &&
              this.isActive(context) &&
              !context.stopping &&
              context.realtime?.sendBackendContext(spoken)
            ) {
              this.options.host.setStatusText(context.epoch);
            }
            announcement = '';
            response = '';
            backgroundTaskId = undefined;
          }
        }
      } catch {
        /* call shutdown and session teardown both end this observer */
      } finally {
        if (context.observerAbort === observerAbort && this.isActive(context)) {
          context.pendingPermissionRequestIds.clear();
          this.options.host.setPendingPermission(context.epoch, false);
        }
      }
    })();
  }

  private async captureWorker(
    context: LiveCallContext,
    event: BridgeEvent,
  ): Promise<void> {
    if (!this.isActive(context)) return;
    const runtime = context.runtime;
    const coordinatorId = context.coordinator?.sessionId;
    const sessionId = workerIdFromEvent(event);
    if (!runtime || !coordinatorId || !sessionId) return;
    if (
      sessionId === coordinatorId ||
      context.workerIds.has(sessionId) ||
      context.pendingWorkerIds.has(sessionId)
    ) {
      return;
    }
    context.pendingWorkerIds.add(sessionId);
    try {
      const parentSessionId = await new SessionService(
        runtime.workspaceCwd,
      ).readParentSessionId(sessionId);
      if (
        !this.isActive(context) ||
        context.coordinator?.sessionId !== coordinatorId ||
        parentSessionId !== coordinatorId ||
        context.workerIds.has(sessionId)
      ) {
        return;
      }
      context.workerIds.add(sessionId);
      context.workers.push({
        workspaceCwd: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
        sessionId,
      });
      this.options.host.setWorkers(context.epoch, context.workers);
    } finally {
      context.pendingWorkerIds.delete(sessionId);
    }
  }

  private isActive(context: LiveCallContext): boolean {
    return this.active === context && !context.callAbort.signal.aborted;
  }

  private updateOutputCaption(
    context: LiveCallContext,
    generation: number,
    event: RealtimeOutputTextEvent,
    done: boolean,
  ): void {
    if (!this.isInteractiveSocket(context, generation)) return;
    if (context.outputCaptionResponseId !== event.responseId) {
      context.outputCaption = '';
      context.outputCaptionResponseId = event.responseId;
      context.outputCaptionSource = undefined;
    }
    if (
      context.outputCaptionSource === 'audio_transcript' &&
      event.source === 'text'
    ) {
      return;
    }
    if (
      context.outputCaptionSource === 'text' &&
      event.source === 'audio_transcript'
    ) {
      context.outputCaption = '';
    }
    context.outputCaptionSource = event.source;
    context.outputCaption = (
      done ? event.text : `${context.outputCaption}${event.text}`
    ).slice(0, MAX_LIVE_CAPTION_CHARS);
    this.options.host.setCaption(context.epoch, context.outputCaption);
  }

  private updateCoordinatorStatus(
    context: LiveCallContext,
    update: Record<string, unknown> | undefined,
  ): void {
    if (!update || context.stopping) return;
    const type = update['sessionUpdate'];
    if (type === 'tool_call') {
      const title = update['title'];
      this.options.host.setStatusText(
        context.epoch,
        typeof title === 'string'
          ? stripTerminalControlSequences(title).split(/\r?\n/, 1)[0]
          : undefined,
      );
      return;
    }
    if (type === 'tool_call_update') {
      const status = update['status'];
      if (status === 'completed' || status === 'failed') {
        this.options.host.setStatusText(context.epoch);
      }
      return;
    }
    if (type === 'agent_message_chunk') {
      this.options.host.setStatusText(context.epoch);
    }
  }

  private isCurrentSocket(
    context: LiveCallContext,
    generation: number,
  ): boolean {
    return (
      this.isActive(context) &&
      context.connectedGeneration === generation &&
      context.realtimeGeneration === generation &&
      context.realtime !== undefined
    );
  }

  private isInteractiveSocket(
    context: LiveCallContext,
    generation: number,
  ): boolean {
    return !context.stopping && this.isCurrentSocket(context, generation);
  }

  private invalidateRealtime(context: LiveCallContext): void {
    context.realtime = undefined;
    context.connectedGeneration = undefined;
    context.responseInFlight = false;
    context.speechInProgress = false;
    context.inputCommitPending = false;
    context.inputAwaitingResponse = false;
    context.outputCaption = '';
    context.outputCaptionResponseId = undefined;
    context.outputCaptionSource = undefined;
    context.realtimeGeneration += 1;
  }

  private discardProvisionalCoordinator(context: LiveCallContext): void {
    const runtime = context.runtime;
    const session = context.coordinatorLease;
    if (
      !runtime ||
      !session ||
      !context.coordinatorFresh ||
      context.coordinatorPromptAdmitted
    ) {
      return;
    }
    context.coordinatorLease = undefined;
    context.coordinatorFresh = false;
    context.coordinator = undefined;
    void this.rollbackPreparedCoordinator(runtime, session, true);
  }

  private closeContextNow(context: LiveCallContext): void {
    closeLiveAudioCapture(context.diagnosticInputCapture, 'context_closed');
    context.diagnosticInputCapture = undefined;
    this.discardProvisionalCoordinator(context);
    if (this.active === context) this.active = undefined;
    context.observerAbort?.abort();
    context.callAbort.abort();
    const realtime = context.realtime;
    this.invalidateRealtime(context);
    realtime?.close();
  }

  private async closeContext(context: LiveCallContext): Promise<void> {
    const runtime = context.runtime;
    const sessionId = context.coordinator?.sessionId;
    if (runtime && sessionId) {
      await runtime.bridge
        .setSessionLiveConversationActive(sessionId, false)
        .catch(() => undefined);
    }
    this.closeContextNow(context);
  }

  private async closeActiveNow(): Promise<void> {
    const context = this.active;
    if (!context) return;
    context.stopping = true;
    await this.closeContext(context);
  }
}
