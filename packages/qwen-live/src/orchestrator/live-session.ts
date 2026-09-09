/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One live call, end to end: owns the realtime connection, routes audio
 * between the Host and the provider, dispatches the seven orchestration
 * tools, pumps backend events into the injector, and drains gracefully on
 * stop.
 *
 * The state-machine disciplines are ported from qwen-code's
 * live-session-coordinator (epoch + generation fences, bounded stop drain);
 * the backend seam is the BackendAdaptor port instead of the in-process
 * bridge.
 */

import { readFile } from 'node:fs/promises';
import type {
  BackendAdaptor,
  BackendEvent,
  BackendHandle,
  ContentBlock,
} from '../adaptor/types.js';
import type { BackendRegistry } from '../adaptor/registry.js';
import type { ProactiveConfig } from '../config.js';
import { liveMessage, type LiveMessageKey } from '../i18n/messages.js';
import type { MemoryService } from '../memory/service.js';
import { renderWmReceipt, type MemorySession } from '../memory/session.js';
import { MemoryDialogueCollector } from '../memory/dialogue.js';
import {
  MEMORY_SYSTEM_PROMPT,
  MEMORY_TOOLS,
  MEMORY_TOOL_NAMES,
} from '../memory/tools.js';
import type { LiveVisualCapture } from '../host/live-host-coordinator.js';
import type {
  LiveState,
  LiveVisualInput,
  LiveVisualSource,
} from '../host/types.js';
import { buildLiveInstructions } from '../realtime/instructions.js';
import {
  openQwenRealtimeSession,
  MAX_REALTIME_INSTRUCTIONS_CHARS,
  QwenRealtimeError,
  QWEN_REALTIME_LIMITS,
  type QwenRealtimeSession,
  type RealtimeCloseInfo,
  type RealtimeResponseDoneEvent,
  type RealtimeResponseAuthority,
  type RealtimeImageDroppedEvent,
  type RealtimeFunctionCall,
  type RealtimeTranscriptEntry,
} from '../realtime/realtime-session.js';
import type { SessionLog } from '../log/session-log.js';
import { LiveLogger } from '../logger.js';
import {
  PermissionBroker,
  type PendingPermission,
} from '../permissions/permission-broker.js';
import {
  ProactiveScheduler,
  type ProactiveDelivery,
  type ProactiveSchedulerControl,
  type ProactiveSchedulerOptions,
} from '../proactive/scheduler.js';
import type { ProactiveTask } from '../proactive/task-manager.js';
import {
  buildProactiveCancelReceipt,
  buildProactiveCreateReceipt,
  buildProactiveFailureReceipt,
  buildProactiveListReceipt,
  buildProactiveUpdateReceipt,
  renderProactiveToolReceipt,
  type ProactiveReceiptOperation,
  type ProactiveToolReceipt,
} from '../proactive/tool-receipt.js';
import {
  detectProactiveRepairIntent,
  PROACTIVE_CANCEL_REPAIR_INSTRUCTION,
  PROACTIVE_MUTATION_REPAIR_INSTRUCTION,
  type ProactiveRepairKind,
} from '../proactive/tool-repair.js';
import {
  APPSHOT_TOOL_NAME,
  buildLiveSessionTools,
  CANCEL_PROACTIVE_TASK_TOOL_NAME,
  CREATE_LIVE_NARRATION_TOOL_NAME,
  CREATE_PROACTIVE_MONITOR_TOOL_NAME,
  CREATE_PROACTIVE_TIMER_TOOL_NAME,
  HANDOFF_TOOL_NAME,
  LIST_PROACTIVE_TASKS_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  SESSION_CREATE_TOOL_NAME,
  SESSION_LIST_TOOL_NAME,
  SESSION_MONITOR_TOOL_NAME,
  SESSION_STOP_TOOL_NAME,
  UPDATE_PROACTIVE_TASK_TOOL_NAME,
} from '../tools/definitions.js';
import {
  ToolDispatcher,
  type ToolContext,
  type ToolDispatchResult,
  type ToolHandler,
} from '../tools/dispatcher.js';
import { HandleRegistry, type JobRecord } from '../tools/handles.js';
import { Injector } from './injector.js';
import { SubagentsLedger } from '../subagents/ledger.js';
import type { SubagentStatus, SubagentsSnapshot } from '../subagents/types.js';

const DEFAULT_GRACEFUL_STOP_DRAIN_MS = 30_000;
const MAX_ACCESSIBILITY_CHARS = 8_000;
const MAX_VOICE_CONTEXT_ENTRIES = 12;
const MAX_VOICE_CONTEXT_CHARS = 4_000;
const MAX_SPOKEN_SUMMARY_CHARS = 200;
const PERMISSION_REMINDER_DELAY_MS = 1_000;
const PROACTIVE_CANCELLATION_GRACE_MS = 250;

const PROACTIVE_MUTATION_TOOL_NAMES = new Set([
  CREATE_PROACTIVE_MONITOR_TOOL_NAME,
  CREATE_LIVE_NARRATION_TOOL_NAME,
  CREATE_PROACTIVE_TIMER_TOOL_NAME,
  UPDATE_PROACTIVE_TASK_TOOL_NAME,
  CANCEL_PROACTIVE_TASK_TOOL_NAME,
]);

const PROACTIVE_MUTATION_REPAIR_TOOLS = [
  CREATE_PROACTIVE_MONITOR_TOOL_NAME,
  CREATE_LIVE_NARRATION_TOOL_NAME,
  CREATE_PROACTIVE_TIMER_TOOL_NAME,
  UPDATE_PROACTIVE_TASK_TOOL_NAME,
  CANCEL_PROACTIVE_TASK_TOOL_NAME,
] as const;

interface ProactiveTaskContext {
  taskId: string;
  title: string;
}

interface PendingProactiveRepair {
  kind: ProactiveRepairKind;
  adjacentTask?: ProactiveTaskContext;
}

class ProactiveArgumentsError extends Error {
  readonly code = 'invalid_arguments';
}

function proactiveReceiptOperation(
  toolName: string,
): ProactiveReceiptOperation | undefined {
  switch (toolName) {
    case CREATE_PROACTIVE_MONITOR_TOOL_NAME:
    case CREATE_LIVE_NARRATION_TOOL_NAME:
    case CREATE_PROACTIVE_TIMER_TOOL_NAME:
      return 'create_task';
    case UPDATE_PROACTIVE_TASK_TOOL_NAME:
      return 'update_task';
    case CANCEL_PROACTIVE_TASK_TOOL_NAME:
      return 'cancel_task';
    case LIST_PROACTIVE_TASKS_TOOL_NAME:
      return 'list_tasks';
    default:
      return undefined;
  }
}

function parseProactiveArguments(
  toolName: string,
  raw: string,
): Record<string, unknown> {
  let parsed: unknown = {};
  try {
    if (raw.trim()) {
      parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown;
    }
  } catch {
    throw new ProactiveArgumentsError('Tool arguments must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProactiveArgumentsError('Tool arguments must be an object.');
  }
  const args = parsed as Record<string, unknown>;
  const allowed = new Set(
    toolName === CREATE_PROACTIVE_MONITOR_TOOL_NAME
      ? ['title', 'modalities', 'condition', 'trigger_response', 'repeat']
      : toolName === CREATE_LIVE_NARRATION_TOOL_NAME
        ? ['title', 'modalities', 'narration_focus', 'narration_style']
        : toolName === CREATE_PROACTIVE_TIMER_TOOL_NAME
          ? ['title', 'duration_sec', 'reminder_text']
          : toolName === UPDATE_PROACTIVE_TASK_TOOL_NAME
            ? [
                'target_title',
                'target_title_contains',
                'title',
                'modalities',
                'condition',
                'trigger_response',
                'narration_focus',
                'narration_style',
                'repeat',
                'duration_sec',
                'reminder_text',
              ]
            : toolName === CANCEL_PROACTIVE_TASK_TOOL_NAME
              ? ['target_title', 'target_title_contains', 'all']
              : [],
  );
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ProactiveArgumentsError(
      `Unknown Proactive argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`,
    );
  }
  return args;
}

/**
 * The Host surface LiveSession drives. Structurally satisfied by the ported
 * LiveHostCoordinator.
 */
export interface LiveHostControl {
  setCallState(
    epoch: number,
    state: Exclude<LiveState, 'unavailable' | 'idle'>,
  ): boolean;
  /** Registers the live session as the visual-capture-authorized caller. */
  setCoordinator(
    epoch: number,
    locator: { workspaceCwd: string; sessionId: string },
  ): boolean;
  sendOutputAudio(epoch: number, pcm16: Uint8Array): boolean;
  finishOutputAudio(epoch: number): void;
  isOutputMuted?(): boolean;
  clearOutput(epoch: number): void;
  setCaption(epoch: number, caption: string): boolean;
  setStatusText(epoch: number, statusText?: string): boolean;
  setTranscript?(epoch: number, transcript: string): boolean;
  failCall(epoch: number, message?: string): boolean;
  setProviderReachability?(readiness?: {
    state: 'ready' | 'checking' | 'unavailable';
    blocker?: 'provider_config' | 'provider_unreachable';
    message?: string;
  }): void;
  captureVisualContext(
    callerSessionId: string,
    options?: { persistAsset?: boolean },
  ): Promise<LiveVisualCapture>;
}

export interface LiveRealtimeConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  voice?: string;
}

export interface LiveSessionOptions {
  host: LiveHostControl;
  registry: BackendRegistry;
  realtime: LiveRealtimeConfig;
  log: SessionLog;
  logger?: LiveLogger;
  openRealtime?: typeof openQwenRealtimeSession;
  proactive?: ProactiveConfig;
  memory?: MemoryService;
  createProactiveScheduler?: (
    options: ProactiveSchedulerOptions,
  ) => ProactiveSchedulerControl;
  gracefulStopDrainMs?: number;
  onSubagentsChanged?: (snapshot: SubagentsSnapshot) => void;
}

interface ActiveProactiveDelivery {
  delivery: ProactiveDelivery;
  responseId: string;
  playbackStarted: boolean;
  playbackCompleted: boolean;
  audioProduced: boolean;
  audioForwarded: boolean;
  outputSuppressed: boolean;
  responseDone: boolean;
  cancellationGraceTimer?: ReturnType<typeof setTimeout>;
}

interface CallContext {
  epoch: number;
  callId: string;
  realtime?: QwenRealtimeSession;
  memory?: MemorySession;
  memoryDialogue?: MemoryDialogueCollector;
  stopping: boolean;
  speechInProgress: boolean;
  responseInFlight: boolean;
  visualInput: LiveVisualInput;
  inputAudioStarted: boolean;
  /** Ignore playback receipts for output cleared by an explicit mute. */
  playbackSuppressed: boolean;
  queuedVisualFrame?: {
    source: LiveVisualSource;
    image: string;
  };
  visualCaptureTail?: Promise<void>;
  /** Suppress asks until buffered backend events have drained on resume. */
  restoringBackendEvents: boolean;
  caption: string;
  loggedInputTranscripts: Map<string, string>;
  loggedResponseTranscripts: Map<string, string>;
  responseAuthorities: Map<string, RealtimeResponseAuthority>;
  pendingToolCalls: Set<{ responseId: string; responseFailed: boolean }>;
  realtimeUnavailable: boolean;
  proactive?: ProactiveSchedulerControl;
  proactiveDeliveries: Map<string, ProactiveDelivery>;
  invalidatedProactiveDeliveries: Set<string>;
  userInterruptedProactiveDeliveries: Set<string>;
  recentProactiveTask?: ProactiveTaskContext;
  proactiveTaskContextByResponse: Map<string, ProactiveTaskContext>;
  proactiveMutationResponses: Set<string>;
  proactiveCommittedMutationResponses: Set<string>;
  directAssistantTranscripts: Map<string, string>;
  pendingProactiveRepair?: PendingProactiveRepair;
  proactiveRepairAwaitingResponse?: PendingProactiveRepair;
  proactiveRepairReceiptPending: boolean;
  pendingProactiveDelivery?: ProactiveDelivery;
  activeProactiveDelivery?: ActiveProactiveDelivery;
  permissionReminderTimer?: ReturnType<typeof setTimeout>;
  defaultSessionHandle?: string;
  injector: Injector;
  stopResolve?: (outcome: void | { error: string }) => void;
}

/**
 * Sentence boundaries for spoken clamps. ASCII terminators count only when
 * followed by whitespace or end-of-string (a period inside a file path, IP,
 * or version must not end a "sentence"); CJK terminators (。！？) count
 * unconditionally — standard CJK typography puts no space after them.
 */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+|(?<=[。！？])\s*/;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstSentence(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const sentence = splitSentences(trimmed)[0] ?? trimmed;
  return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
}

/**
 * The spoken take-away from a long result: its closing sentence. Backend
 * summaries are tail-clamped, so the head may start mid-sentence — the
 * final sentence is the model's own conclusion and always complete.
 */
function lastSentence(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const parts = splitSentences(trimmed);
  const sentence = parts[parts.length - 1] ?? trimmed;
  return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
}

function formatVoiceContext(
  entries: readonly RealtimeTranscriptEntry[],
): string {
  const recent = entries.slice(-MAX_VOICE_CONTEXT_ENTRIES);
  let block = recent
    .map(
      (entry) =>
        `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`,
    )
    .join('\n');
  if (block.length > MAX_VOICE_CONTEXT_CHARS) {
    block = `…${block.slice(block.length - MAX_VOICE_CONTEXT_CHARS)}`;
  }
  return block;
}

function realtimeFailureMessage(
  error: unknown,
  fallback: LiveMessageKey,
): { message: string; configuration: boolean } {
  if (!(error instanceof QwenRealtimeError)) {
    return {
      message: liveMessage(fallback, { detail: '' }),
      configuration: false,
    };
  }
  const detail = error.message.trim();
  if (error.kind !== 'configuration') {
    return {
      message: liveMessage(fallback, { detail: detail ? ` ${detail}` : '' }),
      configuration: false,
    };
  }
  const authenticationFailure =
    error.status === 401 ||
    error.status === 403 ||
    /api[ _.-]?key|auth|unauthori[sz]ed|forbidden/iu.test(
      `${error.code ?? ''} ${detail}`,
    );
  return {
    message: authenticationFailure
      ? detail
        ? liveMessage('runtime.realtimeAuth', { detail })
        : liveMessage('runtime.realtimeAuthEmpty')
      : detail
        ? liveMessage('runtime.realtimeConfig', { detail })
        : liveMessage('runtime.realtimeConfigEmpty'),
    configuration: true,
  };
}

export class LiveSession {
  private readonly host: LiveHostControl;
  private readonly registry: BackendRegistry;
  private readonly log: SessionLog;
  private readonly logger: LiveLogger;
  private readonly openRealtime: typeof openQwenRealtimeSession;
  private readonly createProactiveScheduler: (
    options: ProactiveSchedulerOptions,
  ) => ProactiveSchedulerControl;
  private readonly gracefulStopDrainMs: number;
  private readonly handles = new HandleRegistry();
  private readonly broker: PermissionBroker;
  /** Stream sessions explicitly observed by this Live daemon across calls. */
  private readonly observedSessions = new Map<string, BackendHandle>();
  private readonly backendPumps = new Map<string, AbortController>();
  private readonly pendingSubmissions = new Map<
    string,
    {
      count: number;
      events: BackendEvent[];
    }
  >();
  private readonly subagents: SubagentsLedger;
  private disposed = false;
  private active?: CallContext;

  constructor(private readonly options: LiveSessionOptions) {
    this.host = options.host;
    this.registry = options.registry;
    this.log = options.log;
    this.subagents = new SubagentsLedger(options.onSubagentsChanged);
    this.logger = options.logger ?? new LiveLogger();
    this.openRealtime = options.openRealtime ?? openQwenRealtimeSession;
    this.createProactiveScheduler =
      options.createProactiveScheduler ??
      ((schedulerOptions) => new ProactiveScheduler(schedulerOptions));
    this.gracefulStopDrainMs =
      options.gracefulStopDrainMs ?? DEFAULT_GRACEFUL_STOP_DRAIN_MS;
    this.broker = new PermissionBroker({
      adaptorFor: (backend) => this.adaptorFor(backend),
      log: (type, payload) => this.log.write(type, payload),
    });
  }

  /** The adaptor that owns a backend handle (registry routing). */
  private adaptorFor(handle: BackendHandle): BackendAdaptor {
    return this.registry.adaptorFor(handle);
  }

  /** LiveCallHandlers.onStart */
  async start(call: {
    epoch: number;
    callId: string;
    mode: 'resume' | 'new';
    visualInput: LiveVisualInput;
  }): Promise<void> {
    this.closeActive();
    const context: CallContext = {
      epoch: call.epoch,
      callId: call.callId,
      stopping: false,
      speechInProgress: false,
      responseInFlight: false,
      visualInput: { ...call.visualInput },
      inputAudioStarted: false,
      playbackSuppressed: this.host.isOutputMuted?.() === true,
      restoringBackendEvents: true,
      caption: '',
      loggedInputTranscripts: new Map(),
      loggedResponseTranscripts: new Map(),
      responseAuthorities: new Map(),
      pendingToolCalls: new Set(),
      realtimeUnavailable: false,
      proactiveDeliveries: new Map(),
      invalidatedProactiveDeliveries: new Set(),
      userInterruptedProactiveDeliveries: new Set(),
      proactiveTaskContextByResponse: new Map(),
      proactiveMutationResponses: new Set(),
      proactiveCommittedMutationResponses: new Set(),
      directAssistantTranscripts: new Map(),
      proactiveRepairReceiptPending: false,
      injector: new Injector({
        sink: {
          injectContext: (text) => this.injectContext(context, text),
          injectSpeech: (text) => this.injectSpeech(context, text),
          injectProactive: (event) => this.injectProactiveEvent(context, event),
          onInjected: (item, spoken) => {
            if (item.kind === 'proactive' && item.deliveryId) {
              context.pendingProactiveDelivery =
                context.proactiveDeliveries.get(item.deliveryId);
            }
            this.log.write(spoken ? 'inject.speech' : 'inject.context', {
              kind: item.kind,
              job: item.jobHandle,
              chars: item.context.length,
            });
          },
        },
      }),
    };
    this.active = context;
    this.options.memory?.setLocked(true);
    this.log.write('session.start', {
      callId: call.callId,
      epoch: call.epoch,
      mode: call.mode,
      backends: this.registry.names().join(','),
      model: this.options.realtime.model,
      voice: this.options.realtime.voice,
    });
    this.host.setCallState(call.epoch, 'starting');
    // Register the live call itself as the visual-capture-authorized caller.
    this.host.setCoordinator(call.epoch, {
      workspaceCwd: '/',
      sessionId: call.callId,
    });
    this.debug('realtime.connecting', {
      epoch: call.epoch,
      model: this.options.realtime.model,
    });

    try {
      this.attachMemory(context);
      const realtime = await this.openRealtime(
        {
          endpoint: this.options.realtime.endpoint,
          ...(this.options.realtime.apiKey
            ? { apiKey: this.options.realtime.apiKey }
            : {}),
          model: this.options.realtime.model,
          callEpoch: call.epoch,
          ...(this.options.realtime.voice
            ? { voice: this.options.realtime.voice }
            : {}),
          instructions: this.instructions(context),
          tools: this.sessionTools(context),
        },
        this.callbacksFor(context),
      );
      if (this.active !== context || context.stopping) {
        realtime.close({ discardPendingInput: true });
        return;
      }
      context.realtime = realtime;
      this.syncMemorySettings();
      if (this.options.proactive?.enabled) {
        context.proactive = this.createProactiveScheduler({
          config: this.options.proactive,
          realtime: {
            endpoint: this.options.realtime.endpoint,
            ...(this.options.realtime.apiKey
              ? { apiKey: this.options.realtime.apiKey }
              : {}),
            model: this.options.realtime.model,
          },
          onEvent: (delivery) =>
            this.enqueueProactiveDelivery(context, delivery),
          onDeliveryInvalidated: (delivery) =>
            this.invalidateProactiveDelivery(context, delivery),
          onTaskFailed: (task, error) =>
            this.onProactiveTaskFailed(context, task, error),
          onTaskChanged: (task, notification) =>
            this.observeProactive(context, task, notification),
          captureVision: () => this.captureProactiveVision(context),
          debug: (event, details) => this.debug(event, details),
        });
      }
      if (
        context.visualInput.source !== call.visualInput.source ||
        context.visualInput.mode !== call.visualInput.mode
      ) {
        this.sendVisualSettings(context);
      }
      this.host.setCallState(call.epoch, 'listening');
      for (const [sessionHandle, backend] of this.observedSessions) {
        this.ensurePump(sessionHandle, backend);
      }
      // Let in-flight resolutions settle before replaying pending asks. The
      // daemon observer remains subscribed while the voice call is down.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.active !== context || context.stopping) return;
      context.restoringBackendEvents = false;
      for (const pending of this.broker.pendingUserRequests) {
        this.enqueuePermission(context, pending);
      }
    } catch (error) {
      const failure = realtimeFailureMessage(
        error,
        'runtime.realtimeConnectDetail',
      );
      this.debug('realtime.connect_failed', {
        epoch: call.epoch,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof QwenRealtimeError
          ? {
              code: error.code,
              kind: error.kind,
              status: error.status,
            }
          : {}),
      });
      this.log.write('error', {
        source: 'realtime',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof QwenRealtimeError
          ? {
              code: error.code,
              kind: error.kind,
              status: error.status,
            }
          : {}),
      });
      if (this.active === context) {
        this.host.failCall(call.epoch, failure.message);
        if (failure.configuration) {
          this.host.setProviderReachability?.({
            state: 'unavailable',
            blocker: 'provider_config',
            message: failure.message,
          });
        }
        if (this.active === context) this.cleanupContext(context);
      }
      throw error;
    }
  }

  /** LiveCallHandlers.onStop */
  stop(call: {
    epoch: number;
    callId: string;
  }): Promise<void | { error: string }> {
    const context = this.active;
    if (!context || context.epoch !== call.epoch) return Promise.resolve();
    if (context.stopping) {
      return new Promise((resolve) => {
        const previous = context.stopResolve;
        context.stopResolve = (outcome) => {
          previous?.(outcome);
          resolve(outcome);
        };
      });
    }
    context.stopping = true;
    this.clearProactiveCancellationGrace(context.activeProactiveDelivery);
    context.proactive?.dispose();
    context.proactive = undefined;
    this.host.clearOutput(context.epoch);
    this.host.setCallState(context.epoch, 'stopping');

    return new Promise((resolve) => {
      context.stopResolve = resolve;
      const finish = (outcome: void | { error: string }) => {
        if (this.active === context) this.finishStop(context, outcome);
      };
      // Commit any trailing speech so the provider transcribes it, then wait
      // for the in-flight response to settle — bounded by the drain budget.
      // The commit ack (onInputCommitted) clears speechInProgress, so the
      // drain settles deterministically instead of burning the full budget.
      if (context.speechInProgress) {
        let committed = false;
        try {
          committed = context.realtime?.commitInputAudio() ?? false;
        } catch {
          committed = false;
        }
        if (!committed) {
          finish({
            error: liveMessage('runtime.finalInputCommit'),
          });
          return;
        }
      }
      if (!context.responseInFlight && !context.speechInProgress) {
        finish(undefined);
        return;
      }
      const timer = setTimeout(() => {
        finish({
          error: liveMessage('runtime.finalInputTimeout'),
        });
      }, this.gracefulStopDrainMs);
      timer.unref?.();
      context.injector.dispose();
      const poll = setInterval(() => {
        if (this.active !== context) {
          clearInterval(poll);
          clearTimeout(timer);
          return;
        }
        if (!context.responseInFlight && !context.speechInProgress) {
          clearInterval(poll);
          clearTimeout(timer);
          finish(undefined);
        }
      }, 100);
      poll.unref?.();
    });
  }

  /** LiveCallHandlers.onInputAudio */
  pushAudio(call: { epoch: number; callId: string; pcm16: Buffer }): boolean {
    const context = this.active;
    if (!context || context.epoch !== call.epoch || context.stopping) {
      return true; // stale frames are dropped, not fatal
    }
    if (!context.realtime) return true; // still connecting
    try {
      // Propagate the provider's backpressure signal: a false return
      // means the socket buffer is over its cap and frames are being
      // dropped — the port source fails the call rather than letting VAD
      // and transcription run on a gappy utterance.
      const accepted = context.realtime.pushAudio(call.pcm16);
      if (!accepted) return false;
      context.proactive?.feedAudio(call.pcm16);
      context.inputAudioStarted = true;
      const queued = context.queuedVisualFrame;
      context.queuedVisualFrame = undefined;
      if (
        queued &&
        context.visualInput.mode === 'live-feed' &&
        context.visualInput.source === queued.source
      ) {
        this.forwardVisualFrame(context, queued.source, queued.image);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** LiveCallHandlers.onPlaybackStarted */
  playbackStarted(call: { epoch: number }): void {
    const context = this.active;
    if (!context || context.epoch !== call.epoch || context.stopping) return;
    if (context.playbackSuppressed || this.host.isOutputMuted?.() === true) {
      this.debug('playback.started_ignored', {
        epoch: call.epoch,
        reason: 'output_muted',
      });
      return;
    }
    context.injector.notePlaybackStarted();
    const active = context.activeProactiveDelivery;
    if (active && !active.playbackStarted) {
      active.playbackStarted = true;
    }
    this.debug('playback.started', { epoch: call.epoch });
  }

  /** LiveCallHandlers.onPlaybackCompleted */
  playbackCompleted(call: { epoch: number }): void {
    const context = this.active;
    if (!context || context.epoch !== call.epoch || context.stopping) return;
    if (context.playbackSuppressed) {
      this.debug('playback.completed_ignored', {
        epoch: call.epoch,
        reason: 'output_muted',
      });
      return;
    }
    const active = context.activeProactiveDelivery;
    if (active?.playbackStarted && !active.playbackCompleted) {
      active.playbackCompleted = true;
      if (active.responseDone) {
        context.proactive?.acknowledgeDelivery(active.delivery);
        context.proactiveDeliveries.delete(active.delivery.deliveryId);
        context.activeProactiveDelivery = undefined;
      }
    }
    // A completed Proactive cycle may synchronously release the next FIFO
    // item, so settle its scheduler state before reopening the Injector.
    context.injector.notePlaybackCompleted();
    this.debug('playback.completed', { epoch: call.epoch });
  }

  /** LiveCallHandlers.onOutputMuted */
  outputMuted(call: { epoch: number }): void {
    const context = this.active;
    if (!context || context.epoch !== call.epoch || context.stopping) return;
    context.playbackSuppressed = true;
    const active = context.activeProactiveDelivery;
    if (
      active &&
      (active.audioProduced || active.audioForwarded || active.playbackStarted)
    ) {
      this.suppressProactiveOutput(context, active);
    } else {
      context.injector.noteOutputSuppressed();
    }
    this.debug('playback.suppressed', { epoch: call.epoch });
  }

  /** LiveCallHandlers.onInputImage */
  pushImage(call: {
    epoch: number;
    callId: string;
    source: LiveVisualSource;
    image: string;
  }): boolean {
    const context = this.active;
    if (!context || context.epoch !== call.epoch || context.stopping) {
      return true;
    }
    if (
      context.visualInput.mode !== 'live-feed' ||
      context.visualInput.source !== call.source
    ) {
      return true;
    }
    context.proactive?.feedImage(call.image);
    context.memory?.feedImage(call.image, call.source);
    if (!context.realtime || !context.inputAudioStarted) {
      context.queuedVisualFrame = {
        source: call.source,
        image: call.image,
      };
      this.debug('visual.frame_queued', {
        epoch: call.epoch,
        source: call.source,
        reason: context.realtime ? 'audio_not_started' : 'realtime_connecting',
      });
      return true;
    }
    return this.forwardVisualFrame(context, call.source, call.image);
  }

  setVisualSettings(call: {
    epoch: number;
    callId: string;
    visualInput: LiveVisualInput;
  }): void {
    const context = this.active;
    if (!context || context.epoch !== call.epoch || context.stopping) return;
    const sourceChanged =
      context.visualInput.source !== call.visualInput.source;
    if (sourceChanged || context.visualInput.mode !== call.visualInput.mode) {
      context.queuedVisualFrame = undefined;
    }
    context.visualInput = { ...call.visualInput };
    if (sourceChanged) context.proactive?.resetVisualSource();
    if (sourceChanged) context.memory?.setVisualSource(call.visualInput.source);
    this.debug('visual.settings', {
      epoch: call.epoch,
      source: call.visualInput.source,
      mode: call.visualInput.mode,
    });
    if (context.realtime) this.sendVisualSettings(context);
  }

  dispose(): void {
    this.disposed = true;
    this.closeActive();
    for (const abort of this.backendPumps.values()) abort.abort();
    this.backendPumps.clear();
    this.subagents.dispose();
  }

  getSubagentsSnapshot(): SubagentsSnapshot {
    return this.subagents.snapshot();
  }

  private observeJob(job: JobRecord, status: SubagentStatus): void {
    if (job.state === 'done') status = 'completed';
    if (
      job.state === 'failed' ||
      job.state === 'cancelled' ||
      job.state === 'interrupted'
    )
      status = job.state;
    this.debug('subagents.job_state', {
      sessionHandle: job.sessionHandle,
      jobHandle: job.jobHandle,
      kind: 'harness',
      status,
    });
    this.subagents.upsert({
      id: `harness:${job.jobHandle}`,
      kind: 'harness',
      title: firstSentence(job.task, 180),
      request: job.task,
      status,
      createdAt: job.createdAt,
      updatedAt: Date.now(),
      backend: job.backend.adaptor,
      sessionId: job.sessionHandle,
    });
  }

  private reconcileSubagentSession(sessionHandle: string): void {
    for (const job of this.handles.reconcileIdleSession(sessionHandle)) {
      this.subagents.update(`harness:${job.jobHandle}`, {
        status: 'interrupted',
        activity: liveMessage('subagents.outcomeUnknown'),
      });
    }
  }

  private observeProactive(
    context: CallContext,
    task: ProactiveTask,
    notification?: 'queued' | 'speaking' | 'delivered',
  ): void {
    const statuses: Record<ProactiveTask['status'], SubagentStatus> = {
      provisioning: 'starting',
      running: 'monitoring',
      delivering: 'delivering',
      completed: 'completed',
      cancelled: 'cancelled',
      failed: 'failed',
    };
    const id = `proactive:${task.taskId}`;
    this.subagents.upsert({
      id,
      kind: 'proactive',
      title: task.title,
      status: statuses[task.status],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      request:
        task.taskType === 'perception_monitor'
          ? task.taskDescription
          : task.reminderText,
      source:
        task.taskType === 'time_reminder'
          ? 'timer'
          : task.modalities
              .map((modality) =>
                modality === 'vision' ? context.visualInput.source : 'audio',
              )
              .join(', '),
      activity:
        task.status === 'cancelled' && context.stopping
          ? liveMessage('subagents.callEnded')
          : (task.error ?? task.lastSummary ?? ''),
      ...(task.lastSummary ? { output: task.lastSummary } : {}),
      triggerCount: task.triggerCount,
      pendingNotifications: task.pendingDeliveryCount ?? 0,
      notification,
      ...(task.taskType === 'time_reminder' && task.remainingSec !== undefined
        ? { remainingSec: task.remainingSec }
        : {}),
    });
    if (task.lastSummary || task.error)
      this.subagents.update(
        id,
        {},
        {
          kind: task.error ? 'status' : 'observation',
          text: task.error ?? task.lastSummary!,
        },
      );
  }

  syncMemorySettings(): void {
    const service = this.options.memory;
    const context = this.active;
    if (!service || !context) return;
    if (!service.settings.enabled) this.detachMemory(context);
    else if (!context.memory && !context.stopping) this.attachMemory(context);
    context.memory?.setObserverEnabled(service.settings.observer.enabled);
    if (context.realtime) {
      this.publishMemoryInstructions(context);
      if (!context.stopping) context.memory?.startObserver();
    }
  }

  private instructions(context: CallContext): string {
    const base = buildLiveInstructions(
      context.visualInput,
      undefined,
      this.options.proactive?.enabled === true,
    );
    return context.memory
      ? [
          base,
          MEMORY_SYSTEM_PROMPT,
          'For omnibio and omniretrieve, follow their tool-specific timing: call before answering without surrounding text, instead of the ordinary orchestration pre-tool acknowledgement.',
          context.memory.promptBlocks(),
        ].join('\n\n')
      : base;
  }

  private sessionTools(context: CallContext) {
    const tools = buildLiveSessionTools(
      this.options.proactive?.enabled === true,
    );
    return context.memory ? [...tools, ...MEMORY_TOOLS] : tools;
  }

  private publishMemoryInstructions(context: CallContext): void {
    if (this.active !== context || !context.realtime) return;
    context.realtime.configure({
      instructions: this.instructions(context),
      tools: this.sessionTools(context),
    });
  }

  private attachMemory(context: CallContext): void {
    if (!this.options.memory || context.memory) return;
    const memory = this.options.memory.attach({
      sessionId: context.callId,
      maxPromptChars:
        MAX_REALTIME_INSTRUCTIONS_CHARS -
        buildLiveInstructions(
          context.visualInput,
          undefined,
          this.options.proactive?.enabled === true,
        ).length -
        MEMORY_SYSTEM_PROMPT.length -
        1_000,
      visualSource: context.visualInput.source,
      captureVision: async () => {
        const source = context.visualInput.source;
        const image = await this.captureProactiveVision(context);
        return image ? { image, source } : undefined;
      },
    });
    if (!memory) return;
    context.memory = memory;
    context.memoryDialogue = new MemoryDialogueCollector({
      recordUser: (text) => memory.recordUser(text),
      recordAssistant: (text, options) => memory.recordAssistant(text, options),
    });
  }

  private detachMemory(context: CallContext): void {
    if (context.memory) context.realtime?.flushDialogue?.();
    context.memoryDialogue?.close();
    context.memoryDialogue = undefined;
    if (context.memory) this.options.memory?.finish(context.memory);
    context.memory = undefined;
  }

  // -- realtime callbacks ---------------------------------------------------

  private callbacksFor(context: CallContext) {
    const current = (session?: QwenRealtimeSession): boolean =>
      this.active === context &&
      (context.realtime === undefined || session === undefined
        ? true
        : context.realtime === session);

    return {
      onDialogue: (event: {
        inputItemId: string;
        role: 'user' | 'assistant';
        text: string;
        source?: 'normal' | 'filler';
        interrupted?: boolean;
      }) => {
        if (current()) context.memoryDialogue?.accept(event);
      },
      onReady: () => {
        if (!current()) return;
        this.debug('realtime.ready', { epoch: context.epoch });
        this.log.write('session.start', { phase: 'realtime_ready' });
      },
      onProtocolDebug: (details: Record<string, unknown>) => {
        if (current()) this.debug('realtime.protocol', details);
      },
      onSpeechStarted: () => {
        if (!current()) return;
        context.speechInProgress = true;
        context.pendingProactiveRepair = undefined;
        context.proactiveRepairAwaitingResponse = undefined;
        const activeProactive = context.activeProactiveDelivery;
        const interruptedProactive =
          activeProactive?.delivery ?? context.pendingProactiveDelivery;
        if (interruptedProactive) {
          context.userInterruptedProactiveDeliveries.add(
            interruptedProactive.deliveryId,
          );
        }
        const outputWasPlaying = context.injector.noteSpeechStarted();
        if (context.proactiveRepairReceiptPending) {
          context.proactiveRepairReceiptPending = false;
          context.responseInFlight = false;
          context.injector.noteResponseDone();
        }
        if (context.responseInFlight || outputWasPlaying) {
          context.playbackSuppressed = true;
          this.host.clearOutput(context.epoch);
          this.host.setCaption(context.epoch, '');
          this.host.setStatusText(context.epoch);
          context.injector.noteOutputCleared();
          this.log.write('playback.cleared', {
            reason: 'speech_started',
          });
        }
        if (
          activeProactive &&
          (activeProactive.responseDone ||
            activeProactive.cancellationGraceTimer !== undefined) &&
          !activeProactive.playbackCompleted
        ) {
          this.deferInterruptedProactiveDelivery(
            context,
            activeProactive.delivery,
          );
        }
        this.enqueuePendingPermissions(context);
        this.log.write('vad.speech_started', {});
      },
      onSpeechStopped: () => {
        if (!current()) return;
        this.log.write('vad.speech_stopped', {});
      },
      // The provider's input-commit ack: the utterance is out of the buffer,
      // so speech is no longer "in progress" for the stop drain / injector.
      // Once stopping, pushAudio drops frames, so this ack (or the transcript
      // final below) is the only remaining clearer.
      onInputCommitted: (event: {
        responsePending: boolean;
        itemId?: string;
      }) => {
        if (!current()) return;
        if (event.itemId) context.memoryDialogue?.beginInput(event.itemId);
        context.speechInProgress = false;
        context.injector.noteInputCommitted(event.responsePending);
        this.log.write('vad.speech_stopped', { phase: 'input_committed' });
      },
      onInputTranscriptDone: (event: { itemId?: string; text: string }) => {
        if (!current()) return;
        context.speechInProgress = false;
        this.host.setTranscript?.(context.epoch, event.text);
        this.log.write('transcript.user', { text: event.text });
        if (event.itemId) {
          context.loggedInputTranscripts.set(event.itemId, event.text);
        }
      },
      onOutputTextDelta: (event: { text: string; source: string }) => {
        if (!current()) return;
        context.caption = `${context.caption}${event.text}`;
        this.host.setCaption(context.epoch, context.caption);
      },
      onOutputTextDone: (event: { responseId: string; text: string }) => {
        if (!current()) return;
        context.caption = '';
        this.log.write('transcript.assistant', { text: event.text });
        context.loggedResponseTranscripts.set(event.responseId, event.text);
      },
      onOutputAudioDelta: (event: {
        responseId: string;
        audio: Uint8Array;
      }) => {
        if (!current()) return;
        const proactive =
          context.activeProactiveDelivery?.responseId === event.responseId
            ? context.activeProactiveDelivery
            : undefined;
        if (proactive) proactive.audioProduced = true;
        if (this.host.isOutputMuted?.() === true) {
          context.playbackSuppressed = true;
          if (proactive) this.suppressProactiveOutput(context, proactive);
          else context.injector.noteOutputSuppressed();
          return;
        }
        const forwarded = this.host.sendOutputAudio(context.epoch, event.audio);
        if (!forwarded) return;
        context.playbackSuppressed = false;
        if (proactive) proactive.audioForwarded = true;
        // Mark playback optimistically until the Host's playback receipt
        // arrives, so an early backend event cannot interrupt queued audio.
        context.injector.notePlaybackStarted();
      },
      onResponseCreated: (event: {
        responseId: string;
        authority: RealtimeResponseAuthority;
        inputItemId?: string;
      }) => {
        if (!current()) return;
        let cancelledInvalidatedProactive = false;
        context.responseInFlight = true;
        context.injector.noteResponseCreated(event.authority);
        context.responseAuthorities.set(event.responseId, event.authority);
        const cancelledProactive = context.activeProactiveDelivery;
        if (
          cancelledProactive?.cancellationGraceTimer !== undefined &&
          cancelledProactive.responseId !== event.responseId
        ) {
          this.failProactiveResponse(
            context,
            cancelledProactive.delivery,
            'Foreground Realtime cancelled a Proactive event.',
          );
        }
        if (
          event.authority === 'tool_continuation' &&
          context.proactiveRepairReceiptPending
        ) {
          context.proactiveRepairReceiptPending = false;
        }
        if (event.authority === 'direct' && event.inputItemId) {
          const adjacentTask = context.recentProactiveTask;
          context.recentProactiveTask = undefined;
          if (adjacentTask) {
            context.proactiveTaskContextByResponse.set(
              event.responseId,
              adjacentTask,
            );
          }
        } else if (event.authority === 'proactive_repair') {
          const repair = context.proactiveRepairAwaitingResponse;
          context.proactiveRepairAwaitingResponse = undefined;
          if (repair?.adjacentTask) {
            context.proactiveTaskContextByResponse.set(
              event.responseId,
              repair.adjacentTask,
            );
          }
        }
        if (event.authority === 'proactive') {
          const delivery = context.pendingProactiveDelivery;
          context.pendingProactiveDelivery = undefined;
          if (
            delivery &&
            context.invalidatedProactiveDeliveries.has(delivery.deliveryId)
          ) {
            context.invalidatedProactiveDeliveries.delete(delivery.deliveryId);
            context.proactiveDeliveries.delete(delivery.deliveryId);
            context.injector.abortProactive(delivery.deliveryId);
            cancelledInvalidatedProactive = true;
            context.realtime?.cancelResponse();
            context.playbackSuppressed = true;
            this.host.clearOutput(context.epoch);
            context.injector.noteOutputCleared();
          } else if (delivery) {
            context.activeProactiveDelivery = {
              delivery,
              responseId: event.responseId,
              playbackStarted: false,
              playbackCompleted: false,
              audioProduced: false,
              audioForwarded: false,
              outputSuppressed: false,
              responseDone: false,
            };
            // Match the source Proactive runtime: response.created is the
            // bounded-delivery boundary. Waiting for a Host playback-start
            // receipt here could wedge the FIFO forever if that receipt is
            // lost.
            context.proactive?.announcementStarted(delivery);
          }
        }
        // During the stop drain the call state must stay 'stopping' — a
        // 'speaking' flip here would strand the coordinator (its finish/fail
        // paths early-return unless the call is still 'stopping').
        // cancelResponse() may synchronously deliver response.done. Do not
        // overwrite the listening state restored by that nested callback.
        if (
          !context.stopping &&
          !cancelledInvalidatedProactive &&
          event.authority !== 'proactive_repair'
        ) {
          this.host.setCallState(context.epoch, 'speaking');
        }
        this.log.write('response.created', {
          responseId: event.responseId,
          authority: event.authority,
        });
      },
      onResponseDone: (event: RealtimeResponseDoneEvent) => {
        if (!current()) return;
        if (event.status === 'failed') {
          for (const call of context.pendingToolCalls.values()) {
            if (call.responseId === event.responseId) {
              call.responseFailed = true;
            }
          }
        }
        // Some provider terminal paths omit response.audio.done. Closing the
        // stream here is an idempotent fallback; Host playback may still drain
        // afterwards before the completion barrier opens.
        this.host.finishOutputAudio(context.epoch);
        context.caption = '';
        const authority =
          context.responseAuthorities.get(event.responseId) ?? event.authority;
        const awaitingRepairReceipt =
          authority === 'proactive_repair' &&
          context.proactiveRepairReceiptPending;
        context.responseInFlight = awaitingRepairReceipt;
        const repair = this.proactiveRepairForResponse(
          context,
          event,
          authority,
        );
        if (repair) {
          this.requestProactiveRepair(context, repair);
        } else if (
          authority === 'tool_continuation' &&
          context.proactiveMutationResponses.has(event.responseId)
        ) {
          context.pendingProactiveRepair = undefined;
        }
        let completeProactiveCycle = true;
        if (authority === 'proactive') {
          completeProactiveCycle = this.settleProactiveResponse(context, event);
        }
        this.restoreAdjacentTaskAfterIncompleteTurn(context, event);
        if (!awaitingRepairReceipt) {
          context.injector.noteResponseDone(
            completeProactiveCycle ? authority : undefined,
          );
        }
        context.responseAuthorities.delete(event.responseId);
        context.proactiveTaskContextByResponse.delete(event.responseId);
        context.proactiveMutationResponses.delete(event.responseId);
        context.proactiveCommittedMutationResponses.delete(event.responseId);
        context.directAssistantTranscripts.delete(event.responseId);
        if (!repair) this.retryPendingProactiveRepair(context);
        if (!context.stopping && !awaitingRepairReceipt) {
          this.host.setCallState(context.epoch, 'listening');
        }
        this.log.write('response.done', {
          responseId: event.responseId,
          status: event.status,
          authority,
        });
        context.loggedResponseTranscripts.delete(event.responseId);
        if (event.inputItemId) {
          context.loggedInputTranscripts.delete(event.inputItemId);
        }
        if (authority === 'direct') {
          this.schedulePermissionReminder(context);
        }
      },
      onBargeIn: (event: { responseId: string }) => {
        if (!current()) return;
        if (context.activeProactiveDelivery?.responseId === event.responseId) {
          context.userInterruptedProactiveDeliveries.add(
            context.activeProactiveDelivery.delivery.deliveryId,
          );
        }
        if (!context.speechInProgress) {
          context.playbackSuppressed = true;
          this.host.clearOutput(context.epoch);
          this.host.setCaption(context.epoch, '');
          this.host.setStatusText(context.epoch);
          context.injector.noteOutputCleared();
          this.log.write('playback.cleared', {
            reason: 'barge_in',
            responseId: event.responseId,
          });
        } else {
          this.log.write('response.cancelled', {
            responseId: event.responseId,
          });
        }
      },
      onFunctionCall: (event: RealtimeFunctionCall) => {
        if (!current()) return;
        if (
          context.responseAuthorities.get(event.responseId) ===
          'proactive_repair'
        ) {
          context.proactiveRepairReceiptPending = true;
        }
        if (PROACTIVE_MUTATION_TOOL_NAMES.has(event.name)) {
          context.proactiveMutationResponses.add(event.responseId);
        }
        if (
          event.name === RESPOND_PERMISSION_TOOL_NAME &&
          context.permissionReminderTimer !== undefined
        ) {
          clearTimeout(context.permissionReminderTimer);
          context.permissionReminderTimer = undefined;
        }
        void this.dispatchTool(context, event);
      },
      onDirectTranscript: (event: {
        responseId?: string;
        inputItemId?: string;
        entries: readonly RealtimeTranscriptEntry[];
      }) => {
        if (!current()) return;
        const assistantTranscript = event.entries
          .filter((entry) => entry.role === 'assistant')
          .map((entry) => entry.text)
          .join('\n')
          .trim();
        if (event.responseId && assistantTranscript) {
          context.directAssistantTranscripts.set(
            event.responseId,
            assistantTranscript,
          );
        }
        for (const entry of event.entries) {
          const alreadyLogged =
            entry.role === 'user'
              ? event.inputItemId !== undefined &&
                context.loggedInputTranscripts.get(event.inputItemId) ===
                  entry.text
              : event.responseId !== undefined &&
                context.loggedResponseTranscripts.get(event.responseId) ===
                  entry.text;
          if (alreadyLogged) continue;
          this.log.write(
            entry.role === 'user' ? 'transcript.user' : 'transcript.assistant',
            { text: entry.text, direct: true },
          );
        }
      },
      onAudioDropped: () => {
        // The provider is dropping mic frames (socket buffer over its
        // cap): speech would run on a gappy utterance with no error
        // surfaced — fail the call instead, mirroring the port source.
        if (this.active !== context) return;
        this.log.write('error', {
          source: 'realtime',
          message: 'audio frames were dropped: provider socket backpressured',
        });
        this.host.failCall(context.epoch, liveMessage('runtime.audioDropped'));
      },
      onImageDropped: (event: RealtimeImageDroppedEvent) => {
        if (!current()) return;
        this.debug('realtime.image_dropped', {
          epoch: context.epoch,
          reason: event.reason,
          bufferedBytes: event.bufferedBytes,
        });
      },
      onError: (error: QwenRealtimeError) => {
        if (!current()) return;
        this.debug('realtime.error', {
          epoch: context.epoch,
          message: error.message,
          fatal: error.fatal,
          ...(error.code ? { code: error.code } : {}),
          ...(error.kind ? { kind: error.kind } : {}),
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(error.providerType ? { providerType: error.providerType } : {}),
          ...(error.param ? { param: error.param } : {}),
          ...(error.closeCode !== undefined
            ? { closeCode: error.closeCode }
            : {}),
        });
        this.log.write('error', {
          source: 'realtime',
          code: error.code,
          message: error.message,
          fatal: error.fatal,
          kind: error.kind,
          status: error.status,
          providerType: error.providerType,
          param: error.param,
          closeCode: error.closeCode,
        });
        if (error.fatal) {
          context.realtimeUnavailable = true;
          // The socket is done for. Clear the drain flags before failCall()
          // asks this session to stop, or a live utterance would replace the
          // provider failure with a misleading final-input commit error.
          context.responseInFlight = false;
          context.speechInProgress = false;
        }
        if (error.fatal && !context.stopping) {
          const failure = realtimeFailureMessage(
            error,
            'runtime.realtimeFailed',
          );
          this.host.failCall(context.epoch, failure.message);
          if (failure.configuration) {
            this.host.setProviderReachability?.({
              state: 'unavailable',
              blocker: 'provider_config',
              message: failure.message,
            });
          }
          this.cleanupContext(context);
        }
      },
      onClose: (info: RealtimeCloseInfo) => {
        if (this.active !== context) return;
        context.realtimeUnavailable = true;
        this.debug('realtime.closed', {
          epoch: context.epoch,
          reason: info.reason,
        });
        this.log.write('session.end', { reason: info.reason });
        if (context.stopping) {
          context.responseInFlight = false;
          context.speechInProgress = false;
          return;
        }
        if (info.reason !== 'client') {
          const failure = realtimeFailureMessage(
            info.error,
            'runtime.realtimeDisconnected',
          );
          this.host.failCall(context.epoch, failure.message);
          if (failure.configuration) {
            this.host.setProviderReachability?.({
              state: 'unavailable',
              blocker: 'provider_config',
              message: failure.message,
            });
          }
          this.cleanupContext(context);
        }
      },
    };
  }

  // -- tools ----------------------------------------------------------------

  private async dispatchTool(
    context: CallContext,
    event: RealtimeFunctionCall,
  ): Promise<void> {
    const call = { responseId: event.responseId, responseFailed: false };
    context.pendingToolCalls.add(call);
    if (!context.stopping) {
      this.host.setCallState(context.epoch, 'thinking');
    }
    this.log.write('tool.call', {
      name: event.name,
      callId: event.callId,
      ...(MEMORY_TOOL_NAMES.has(event.name)
        ? { argumentChars: event.arguments.length }
        : { args: event.arguments.slice(0, 2_000) }),
    });
    const operation = proactiveReceiptOperation(event.name);
    let result: ToolDispatchResult;
    if (MEMORY_TOOL_NAMES.has(event.name)) {
      result = await this.dispatchMemoryTool(context, event);
    } else if (operation) {
      result = this.dispatchProactiveTool(context, event, operation);
    } else {
      const dispatcher = new ToolDispatcher({
        handlers: this.toolHandlers(context),
      });
      const ctx: ToolContext = { activeTranscript: event.activeTranscript };
      result = await dispatcher.dispatch(event.name, event.arguments, ctx);
    }
    // The realtime session rejects empty or oversized outputs; a stranded
    // call would hang that response's arbitration. Clamp defensively.
    let receipt = result.receipt;
    if (receipt.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars) {
      receipt = JSON.stringify({
        status: 'error',
        note: 'The result was too large to return; check the session on screen.',
      });
    }
    if (!receipt.trim()) receipt = '{}';
    this.log.write('tool.result', {
      name: event.name,
      callId: event.callId,
      ok: result.ok,
      receipt: receipt.slice(0, 2_000),
    });
    context.pendingToolCalls.delete(call);
    if (this.active !== context || !context.realtime) return;
    try {
      const submitted = context.realtime.submitFunctionOutput(
        { callEpoch: context.epoch, callId: event.callId },
        receipt,
      );
      if (!submitted) {
        // A failed response has already retired its pending tool calls; the
        // backend side effect can finish after that nonfatal provider error.
        if (call.responseFailed && !context.realtimeUnavailable) {
          this.debug('tool.output_ignored', {
            callId: event.callId,
            responseId: event.responseId,
            reason: 'response_failed',
          });
          return;
        }
        throw new Error('Realtime rejected the tool result.');
      }
    } catch (error) {
      this.log.write('error', {
        source: 'tool_output',
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.active === context) {
        this.host.failCall(
          context.epoch,
          liveMessage('runtime.toolResultFailed'),
        );
        this.cleanupContext(context);
      }
    }
  }

  private async dispatchMemoryTool(
    context: CallContext,
    event: RealtimeFunctionCall,
  ): Promise<ToolDispatchResult> {
    const memory = context.memory;
    const failed = {
      ok: false,
      receipt:
        event.name === 'omnibio'
          ? 'Failed to update memory.'
          : 'Failed to search memory.',
    };
    if (!memory || memory.closed) return failed;
    try {
      let args: unknown = JSON.parse(event.arguments);
      if (typeof args === 'string') args = JSON.parse(args);
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return failed;
      const values = args as Record<string, unknown>;
      const allowed =
        event.name === 'omnibio'
          ? ['operations']
          : ['query', 'source', 'time_range'];
      if (Object.keys(values).some((key) => !allowed.includes(key)))
        return failed;
      let result: ToolDispatchResult;
      if (event.name === 'omnibio') {
        const applied = memory.applyOmnibio(values['operations']);
        result = { ok: applied.succeeded, receipt: renderWmReceipt(applied) };
      } else {
        if (values['source'] !== 'dialogue' && values['source'] !== 'env')
          return failed;
        const retrieved = await memory.retrieve({
          query: values['query'],
          source: values['source'],
          timeRange: values['time_range'],
        });
        result = {
          ok: retrieved.count !== undefined,
          receipt: retrieved.receipt,
        };
      }
      if (context.memory !== memory || memory.closed) return failed;
      this.publishMemoryInstructions(context);
      return result;
    } catch (error) {
      this.debug('memory.tool_failed', {
        name: event.name,
        kind: error instanceof Error ? error.name : 'unknown',
      });
      return failed;
    }
  }

  private dispatchProactiveTool(
    context: CallContext,
    event: RealtimeFunctionCall,
    operation: ProactiveReceiptOperation,
  ): ToolDispatchResult {
    const proactive = context.proactive;
    let receipt: ProactiveToolReceipt;
    try {
      if (!proactive) throw new Error('Proactive is disabled.');
      const args = parseProactiveArguments(event.name, event.arguments);
      switch (event.name) {
        case CREATE_PROACTIVE_MONITOR_TOOL_NAME: {
          const task = proactive.createPerceptionMonitor({
            title: args['title'],
            modalities: args['modalities'],
            condition: args['condition'],
            triggerResponse: args['trigger_response'],
            repeat: args['repeat'],
          });
          this.assertProactiveMutationSucceeded(task);
          receipt = buildProactiveCreateReceipt(task, proactive.listTasks());
          this.recordCommittedProactiveMutation(
            context,
            event.responseId,
            task,
          );
          break;
        }
        case CREATE_LIVE_NARRATION_TOOL_NAME: {
          const task = proactive.createLiveNarration({
            title: args['title'],
            modalities: args['modalities'],
            narrationFocus: args['narration_focus'],
            narrationStyle: args['narration_style'],
          });
          this.assertProactiveMutationSucceeded(task);
          receipt = buildProactiveCreateReceipt(task, proactive.listTasks());
          this.recordCommittedProactiveMutation(
            context,
            event.responseId,
            task,
          );
          break;
        }
        case CREATE_PROACTIVE_TIMER_TOOL_NAME: {
          const task = proactive.createTimer({
            title: args['title'],
            durationSec: args['duration_sec'],
            reminderText: args['reminder_text'],
          });
          this.assertProactiveMutationSucceeded(task);
          receipt = buildProactiveCreateReceipt(task, proactive.listTasks());
          this.recordCommittedProactiveMutation(
            context,
            event.responseId,
            task,
          );
          break;
        }
        case UPDATE_PROACTIVE_TASK_TOOL_NAME: {
          const adjacent = this.adjacentProactiveTask(
            context,
            event.responseId,
          );
          const hasSelector =
            args['target_title'] !== undefined ||
            args['target_title_contains'] !== undefined;
          if (!hasSelector) {
            if (Object.keys(args).length !== 1 || args['repeat'] !== true) {
              throw new ProactiveArgumentsError(
                'An adjacent selector-less update may only set repeat=true.',
              );
            }
            if (!adjacent) {
              throw new ProactiveArgumentsError(
                'Selector-less update has no adjacent active task.',
              );
            }
          }
          const task = proactive.updateTask({
            ...(args['target_title'] !== undefined
              ? { targetTitle: args['target_title'] }
              : args['target_title_contains'] === undefined && adjacent
                ? { targetTitle: adjacent.title }
                : {}),
            ...(args['target_title_contains'] !== undefined
              ? { targetTitleContains: args['target_title_contains'] }
              : {}),
            ...(args['title'] !== undefined ? { title: args['title'] } : {}),
            ...(args['modalities'] !== undefined
              ? { modalities: args['modalities'] }
              : {}),
            ...(args['condition'] !== undefined
              ? { condition: args['condition'] }
              : {}),
            ...(args['trigger_response'] !== undefined
              ? { triggerResponse: args['trigger_response'] }
              : {}),
            ...(args['narration_focus'] !== undefined
              ? { narrationFocus: args['narration_focus'] }
              : {}),
            ...(args['narration_style'] !== undefined
              ? { narrationStyle: args['narration_style'] }
              : {}),
            ...(args['repeat'] !== undefined ? { repeat: args['repeat'] } : {}),
            ...(args['duration_sec'] !== undefined
              ? { durationSec: args['duration_sec'] }
              : {}),
            ...(args['reminder_text'] !== undefined
              ? { reminderText: args['reminder_text'] }
              : {}),
          });
          this.assertProactiveMutationSucceeded(task);
          receipt = buildProactiveUpdateReceipt(task, proactive.listTasks());
          this.recordCommittedProactiveMutation(
            context,
            event.responseId,
            task,
          );
          break;
        }
        case CANCEL_PROACTIVE_TASK_TOOL_NAME: {
          const adjacent = this.adjacentProactiveTask(
            context,
            event.responseId,
          );
          const hasSelector =
            args['target_title'] !== undefined ||
            args['target_title_contains'] !== undefined ||
            args['all'] === true;
          if (!hasSelector) {
            if (Object.keys(args).length !== 0) {
              throw new ProactiveArgumentsError(
                'An adjacent selector-less cancel must have no arguments.',
              );
            }
            if (!adjacent) {
              throw new ProactiveArgumentsError(
                'Selector-less cancel has no adjacent active task.',
              );
            }
          }
          const cancelled = proactive.cancelTasks({
            ...(args['target_title'] !== undefined
              ? { targetTitle: args['target_title'] }
              : args['target_title_contains'] === undefined &&
                  args['all'] !== true &&
                  adjacent
                ? { targetTitle: adjacent.title }
                : {}),
            ...(args['target_title_contains'] !== undefined
              ? { targetTitleContains: args['target_title_contains'] }
              : {}),
            ...(args['all'] !== undefined ? { all: args['all'] } : {}),
          });
          receipt = buildProactiveCancelReceipt(
            cancelled,
            proactive.listTasks(),
          );
          if (receipt.committed) {
            this.recordCommittedProactiveMutation(context, event.responseId);
          }
          break;
        }
        case LIST_PROACTIVE_TASKS_TOOL_NAME:
          receipt = buildProactiveListReceipt(proactive.listTasks());
          break;
        default:
          throw new Error(`Unsupported Proactive tool: ${event.name}.`);
      }
    } catch (error) {
      this.log.write('error', {
        source: 'proactive_tool',
        tool: event.name,
        message: error instanceof Error ? error.message : String(error),
      });
      let activeTasks: ProactiveTask[] = [];
      try {
        activeTasks = proactive?.listTasks() ?? [];
      } catch {
        /* the original failure remains authoritative */
      }
      receipt = buildProactiveFailureReceipt(operation, error, activeTasks);
    }
    return {
      ok: receipt.committed,
      receipt: renderProactiveToolReceipt(receipt),
    };
  }

  private toolHandlers(context: CallContext): ReadonlyMap<string, ToolHandler> {
    const handlers = new Map<string, ToolHandler>();

    handlers.set(APPSHOT_TOOL_NAME, async () => {
      if (context.visualInput.mode !== 'on-demand') {
        throw new Error(
          'Appshot is disabled while visual input uses Live Feed mode.',
        );
      }
      const capture = await this.captureVisualContext(context, true);
      if (capture.source !== context.visualInput.source) {
        throw new Error('The visual source changed while Appshot was running.');
      }
      const asset = capture.screenshotPath
        ? this.handles.registerAsset({
            path: capture.screenshotPath,
            mimeType: capture.source === 'screen' ? 'image/png' : 'image/jpeg',
          })
        : undefined;
      this.debug('visual.snapshot_captured', {
        epoch: context.epoch,
        source: capture.source,
        width: capture.width,
        height: capture.height,
        bytes: Buffer.byteLength(capture.image, 'base64'),
      });
      return {
        status: 'ok',
        source: capture.source,
        width: capture.width,
        height: capture.height,
        ...(capture.appName ? { app: capture.appName } : {}),
        ...(capture.windowTitle ? { window: capture.windowTitle } : {}),
        ...(capture.accessibilityText
          ? {
              accessibility_text: capture.accessibilityText.slice(
                0,
                MAX_ACCESSIBILITY_CHARS,
              ),
            }
          : {}),
        ...(asset ? { asset: asset.assetHandle } : {}),
      };
    });

    handlers.set(SESSION_LIST_TOOL_NAME, async () => {
      const rows: Array<Record<string, unknown>> = [];
      for (const entry of this.registry.all()) {
        // One dead backend must not empty the whole list.
        let summaries;
        try {
          summaries = await entry.adaptor.listSessions();
        } catch (error) {
          this.log.write('error', {
            source: 'session_list',
            backend: entry.adaptor.name,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        for (const summary of summaries) {
          const handle = this.handles.session(summary.handle);
          const pending = this.broker.pendingForSession(handle);
          // A lost terminal event cannot prove success. Retire a stale job
          // as interrupted only when the backend also reports idle.
          if (
            summary.state !== 'busy' &&
            !entry.adaptor.isBusy(summary.handle)
          ) {
            this.reconcileSubagentSession(handle);
          }
          const activeJob = this.handles.activeJobForSession(handle);
          rows.push({
            handle,
            backend: entry.adaptor.name,
            ...(summary.label ? { label: summary.label } : {}),
            ...(summary.cwd ? { cwd: summary.cwd } : {}),
            state: pending
              ? 'waiting_for_permission'
              : entry.adaptor.isBusy(summary.handle)
                ? 'busy'
                : summary.state,
            ...(pending
              ? {
                  pending_permission: {
                    request_id: pending.requestHandle,
                    title: pending.title,
                  },
                }
              : {}),
            ...(activeJob ? { active_job: activeJob.jobHandle } : {}),
          });
        }
      }
      return { status: 'ok', sessions: rows };
    });

    handlers.set(SESSION_CREATE_TOOL_NAME, async (args) => {
      let adaptor = this.registry.defaultAdaptor;
      if (typeof args['backend'] === 'string' && args['backend'].trim()) {
        const named = this.registry.byAdaptorName(args['backend'].trim());
        if (!named) {
          return {
            status: 'error',
            note: `unknown backend '${args['backend']}'; configured backends: ${this.registry.names().join(', ')}.`,
          };
        }
        if (named.status !== 'ready') {
          return {
            status: 'error',
            note: `backend '${named.adaptor.name}' is unavailable: ${named.lastError ?? 'preflight failed'}.`,
          };
        }
        adaptor = named.adaptor;
      }
      const backend = await adaptor.createSession({
        ...(typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {}),
        ...(typeof args['label'] === 'string' ? { label: args['label'] } : {}),
      });
      const handle = this.handles.session(backend);
      this.ensurePump(handle, backend);
      return { status: 'ok', handle };
    });

    handlers.set(HANDOFF_TOOL_NAME, async (args, ctx) => {
      const task = typeof args['task'] === 'string' ? args['task'].trim() : '';
      if (!task) {
        return { status: 'error', note: 'handoff needs a task.' };
      }
      const target = await this.resolveHandoffTarget(context, args['session']);
      if ('error' in target) return { status: 'error', note: target.error };
      const { handle, backend } = target;

      const blocks = await this.buildHandoffBlocks(
        task,
        ctx.activeTranscript,
        args['input_refs'],
      );
      const adaptor = this.adaptorFor(backend);
      const caps = adaptor.capabilities();
      const busy = adaptor.isBusy(backend);
      // Image-capable backends only: strip image blocks the backend cannot
      // take and say so in the receipt — silently dropping them would let
      // the model claim the screenshot was delivered.
      let sentBlocks = blocks;
      let imageNote: string | undefined;
      if (!caps.imageInput && blocks.some((b) => b.type === 'image')) {
        sentBlocks = blocks.filter((b) => b.type !== 'image');
        imageNote = 'this session cannot take images; sent the text only';
      }
      const pending = this.pendingSubmissions.get(handle) ?? {
        count: 0,
        events: [],
      };
      pending.count += 1;
      this.pendingSubmissions.set(handle, pending);
      this.ensurePump(handle, backend);
      const finishSubmission = (jobRef?: string) => {
        pending.count -= 1;
        if (pending.count === 0) this.pendingSubmissions.delete(handle);
        const buffered = pending.events.filter(
          (event) =>
            pending.count === 0 ||
            (jobRef !== undefined &&
              'jobRef' in event &&
              event.jobRef === jobRef),
        );
        pending.events = pending.events.filter(
          (event) => !buffered.includes(event),
        );
        for (const event of buffered) {
          this.onBackendEvent(handle, backend, event);
        }
      };
      let receipt;
      try {
        receipt = await adaptor.prompt(backend, sentBlocks, {
          steer: busy && caps.steering !== 'none',
        });
      } catch (error) {
        finishSubmission();
        throw error;
      }
      if (receipt.status === 'rejected') {
        finishSubmission();
        return {
          status: 'rejected',
          session: handle,
          note: receipt.note ?? 'the session refused the task',
        };
      }
      // A steer that joined the running turn comes back with that turn's
      // jobRef: the instruction became part of the EXISTING job. Creating a
      // second record would orphan the first in 'running' forever (nothing
      // would ever transition it out).
      const existing =
        receipt.jobRef !== undefined
          ? this.handles.jobByRef(backend, receipt.jobRef)
          : undefined;
      const job =
        existing ??
        this.handles.createJob({
          sessionHandle: handle,
          backend,
          ...(receipt.jobRef !== undefined ? { jobRef: receipt.jobRef } : {}),
          task,
        });
      this.observeJob(
        job,
        receipt.status === 'queued'
          ? 'queued'
          : job.state === 'running'
            ? 'running'
            : 'starting',
      );
      finishSubmission(receipt.jobRef);
      this.ensurePump(handle, backend);
      const notes = [receipt.note, imageNote].filter(Boolean).join('. ');
      return {
        status: receipt.status,
        job: job.jobHandle,
        session: handle,
        ...(notes ? { note: notes } : {}),
      };
    });

    handlers.set(SESSION_MONITOR_TOOL_NAME, (args) => {
      const job =
        typeof args['job'] === 'string'
          ? this.handles.resolveJob(args['job'])
          : undefined;
      const sessionHandle =
        job?.sessionHandle ??
        (typeof args['session'] === 'string' ? args['session'].trim() : '');
      const backend = this.handles.resolveSession(sessionHandle);
      if (!backend) {
        return {
          status: 'error',
          note: 'unknown session; call session_list first.',
        };
      }
      if (!this.adaptorFor(backend).isBusy(backend)) {
        this.reconcileSubagentSession(sessionHandle);
      }
      const activeJob = job ?? this.handles.activeJobForSession(sessionHandle);
      const sessionPending = this.broker.pendingForSession(sessionHandle);
      const jobPending =
        activeJob?.jobRef !== undefined
          ? this.broker.pendingForJob(backend, activeJob.jobRef)
          : undefined;
      const pending = job ? jobPending : sessionPending;
      return {
        status: 'ok',
        session: sessionHandle,
        state: pending
          ? 'waiting_for_permission'
          : this.adaptorFor(backend).isBusy(backend)
            ? 'busy'
            : 'idle',
        ...(pending
          ? {
              pending_permission: {
                request_id: pending.requestHandle,
                title: pending.title,
              },
            }
          : {}),
        ...(activeJob
          ? {
              job: activeJob.jobHandle,
              job_state: jobPending
                ? 'waiting_for_permission'
                : activeJob.state,
              task: activeJob.task.slice(0, 200),
            }
          : {}),
      };
    });

    handlers.set(SESSION_STOP_TOOL_NAME, async (args) => {
      const job =
        typeof args['job'] === 'string'
          ? this.handles.resolveJob(args['job'])
          : undefined;
      const sessionHandle =
        job?.sessionHandle ??
        (typeof args['session'] === 'string' ? args['session'].trim() : '');
      const backend =
        job?.backend ?? this.handles.resolveSession(sessionHandle);
      if (!backend) {
        return {
          status: 'error',
          note: 'unknown session or job; call session_list first.',
        };
      }
      await this.adaptorFor(backend).cancel(backend);
      if (job) job.state = 'cancelled';
      if (job)
        this.subagents.update(`harness:${job.jobHandle}`, {
          status: 'cancelled',
          activity: '',
        });
      return { status: 'cancelling', session: sessionHandle };
    });

    handlers.set(RESPOND_PERMISSION_TOOL_NAME, async (args) => {
      const requestHandle =
        typeof args['request_id'] === 'string' ? args['request_id'] : '';
      const decision = args['decision'];
      if (
        decision !== 'allow' &&
        decision !== 'allow_always' &&
        decision !== 'deny'
      ) {
        return {
          status: 'error',
          note: 'decision must be allow, allow_always, or deny.',
        };
      }
      const note = typeof args['note'] === 'string' ? args['note'].trim() : '';
      // Resolve before respond(): a delivered vote clears the pending entry,
      // and the backend handle is needed to relay the user's constraint.
      const pending = this.broker.resolveHandle(requestHandle);
      const outcome = await this.broker.respond(
        requestHandle,
        decision,
        note || undefined,
      );
      if (outcome === 'not_found') {
        return {
          status: 'error',
          note: `no pending request ${requestHandle}.`,
        };
      }
      if (pending) {
        const job = pending.jobRef
          ? this.handles.jobByRef(pending.backend, pending.jobRef)
          : this.handles.activeJobForSession(pending.sessionHandle);
        if (job)
          this.subagents.update(`harness:${job.jobHandle}`, {
            status: 'running',
            activity: '',
          });
        context.injector.retractPermission(
          this.scopedPermissionId(pending.backend, pending.requestId),
        );
      }
      // The vote channel carries no free text; a user constraint ("only this
      // file") would otherwise be silently discarded — the grant would be
      // broader than the user believes. Relay it as a user instruction to
      // the same backend session through the existing prompt/steer path.
      if (note && pending && outcome === 'delivered') {
        try {
          await this.adaptorFor(pending.backend).prompt(
            pending.backend,
            [
              {
                type: 'text',
                text:
                  `The user answered the permission request "${pending.title}" ` +
                  `with "${decision}" and added this constraint, which you must ` +
                  `follow: ${note}`,
              },
            ],
            { steer: this.adaptorFor(pending.backend).isBusy(pending.backend) },
          );
        } catch (error) {
          this.log.write('error', {
            source: 'permission',
            message: error instanceof Error ? error.message : String(error),
          });
          return {
            status: outcome,
            note:
              'The vote was delivered, but the added constraint could not ' +
              'be relayed to the session; tell the user to check it on screen.',
          };
        }
      }
      return { status: outcome };
    });

    return handlers;
  }

  private async resolveHandoffTarget(
    context: CallContext,
    sessionArg: unknown,
  ): Promise<{ handle: string; backend: BackendHandle } | { error: string }> {
    if (typeof sessionArg === 'string' && sessionArg.trim()) {
      const backend = this.handles.resolveSession(sessionArg);
      if (!backend) {
        return { error: `unknown session ${sessionArg}; call session_list.` };
      }
      return { handle: sessionArg.trim(), backend };
    }
    if (context.defaultSessionHandle) {
      const backend = this.handles.resolveSession(context.defaultSessionHandle);
      if (backend) {
        return { handle: context.defaultSessionHandle, backend };
      }
    }
    const backend = await this.registry.defaultAdaptor.createSession({
      label: 'Voice chat',
    });
    const handle = this.handles.session(backend);
    context.defaultSessionHandle = handle;
    return { handle, backend };
  }

  private async buildHandoffBlocks(
    task: string,
    activeTranscript: readonly RealtimeTranscriptEntry[],
    inputRefs: unknown,
  ): Promise<ContentBlock[]> {
    const parts = [task];
    const voiceContext = formatVoiceContext(activeTranscript);
    if (voiceContext) {
      parts.push(
        `<recent_voice_context>\nRelayed from the user's live voice conversation; use it only to resolve references in the task.\n${voiceContext}\n</recent_voice_context>`,
      );
    }
    const blocks: ContentBlock[] = [{ type: 'text', text: parts.join('\n\n') }];
    if (Array.isArray(inputRefs)) {
      for (const ref of inputRefs) {
        if (typeof ref !== 'string') continue;
        const asset = this.handles.resolveAsset(ref);
        if (!asset) continue;
        try {
          const data = await readFile(asset.path);
          blocks.push({
            type: 'image',
            mimeType: asset.mimeType,
            data: new Uint8Array(data),
            name: `${asset.assetHandle}.png`,
          });
        } catch {
          /* the capture expired; the text task still stands */
        }
      }
    }
    return blocks;
  }

  // -- backend event pump ---------------------------------------------------

  private ensurePump(sessionHandle: string, backend: BackendHandle): void {
    if (this.disposed || this.backendPumps.has(sessionHandle)) return;
    const caps = this.adaptorFor(backend).capabilities();
    if (caps.eventDelivery !== 'stream') {
      // A per-turn/poll backend has no long-lived stream to pump; its
      // completions arrive another way. Guard so such an adaptor never
      // spins a broken resubscribe loop.
      this.log.write('error', {
        source: 'pump',
        session: sessionHandle,
        message: `backend '${backend.adaptor}' does not stream events (${caps.eventDelivery}); not observed`,
      });
      return;
    }
    this.observedSessions.set(sessionHandle, backend);
    const abort = new AbortController();
    this.backendPumps.set(sessionHandle, abort);
    void this.pump(sessionHandle, backend, abort.signal).catch((error) => {
      this.log.write('error', {
        source: 'pump',
        session: sessionHandle,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async pump(
    sessionHandle: string,
    backend: BackendHandle,
    signal: AbortSignal,
  ): Promise<void> {
    // The SSE stream can end without a session_closed (daemon restart,
    // dropped connection). Resubscribe with backoff instead of leaving the
    // session permanently unobserved — completion events would be lost.
    let backoffMs = 1_000;
    while (!this.disposed && !signal.aborted) {
      let sawEvent = false;
      try {
        for await (const event of this.adaptorFor(backend).events(backend, {
          signal,
        })) {
          if (this.disposed || signal.aborted) return;
          sawEvent = true;
          backoffMs = 1_000;
          this.log.write('backend.event', {
            session: sessionHandle,
            type: event.type,
            ...('jobRef' in event && event.jobRef !== undefined
              ? { jobRef: event.jobRef }
              : {}),
          });
          this.onBackendEvent(sessionHandle, backend, event);
          if (event.type === 'session_closed') {
            this.backendPumps.delete(sessionHandle);
            return;
          }
        }
      } catch (error) {
        if (signal.aborted || this.disposed) break;
        this.log.write('error', {
          source: 'pump',
          session: sessionHandle,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal.aborted || this.disposed) break;
      const job = this.handles.activeJobForSession(sessionHandle);
      if (job)
        this.subagents.update(`harness:${job.jobHandle}`, {
          activity: liveMessage('subagents.reconnecting'),
        });
      this.log.write('backend.event', {
        session: sessionHandle,
        type: 'stream_ended',
        resubscribeInMs: backoffMs,
        sawEvent,
      });
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, backoffMs);
        signal.addEventListener('abort', finish, { once: true });
        timer.unref?.();
      });
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
    this.backendPumps.delete(sessionHandle);
  }

  private onBackendEvent(
    sessionHandle: string,
    backend: BackendHandle,
    event: BackendEvent,
  ): void {
    const context =
      this.active && !this.active.stopping && this.active.realtime
        ? this.active
        : undefined;
    const observedJob =
      'jobRef' in event && event.jobRef
        ? this.handles.jobByRef(backend, event.jobRef)
        : this.handles.activeJobForSession(sessionHandle);
    const pending = this.pendingSubmissions.get(sessionHandle);
    const buffered =
      !observedJob &&
      'jobRef' in event &&
      Boolean(event.jobRef) &&
      pending !== undefined;
    this.debug('backend.lifecycle', {
      sessionHandle,
      ...(observedJob ? { jobHandle: observedJob.jobHandle } : {}),
      type: event.type,
      activeCall: context !== undefined,
      buffered,
      ...(event.type === 'activity' ? { kind: event.kind } : {}),
      ...('text' in event ? { textChars: event.text.length } : {}),
      ...('summary' in event ? { summaryChars: event.summary.length } : {}),
      ...('detail' in event ? { detailChars: event.detail?.length ?? 0 } : {}),
      ...(event.type === 'turn_error'
        ? { errorChars: event.error.length }
        : {}),
      ...(event.type === 'permission_request'
        ? { permissionPending: true, permissionOptions: event.options.length }
        : {}),
      ...(event.type === 'permission_resolved'
        ? { permissionPending: false, resolvedByUs: event.byUs }
        : {}),
    });
    if (pending && event.type === 'permission_resolved') {
      const unresolved = pending.events.filter(
        (entry) =>
          entry.type !== 'permission_request' ||
          entry.requestId !== event.requestId,
      );
      if (unresolved.length !== pending.events.length) {
        // The request never reached the broker. Retire the buffered ask so
        // a later receipt cannot reopen a vote already handled elsewhere.
        pending.events = unresolved;
        return;
      }
    }
    if (!observedJob && 'jobRef' in event && event.jobRef && pending) {
      pending.events.push(event);
      if (pending.events.length > 128) {
        const advisory = pending.events.findIndex(
          (entry) => entry.type === 'activity' || entry.type === 'progress',
        );
        pending.events.splice(advisory === -1 ? 0 : advisory, 1);
      }
      return;
    }
    const id = observedJob ? `harness:${observedJob.jobHandle}` : undefined;
    switch (event.type) {
      case 'turn_started': {
        const job = observedJob;
        if (job && !['accepted', 'running'].includes(job.state)) return;
        if (job) job.state = 'running';
        if (id) this.subagents.update(id, { status: 'running', activity: '' });
        return;
      }
      case 'activity': {
        if (id) this.subagents.append(id, event.kind, event.text);
        return;
      }
      case 'progress': {
        if (id) this.subagents.append(id, 'tool', event.summary);
        if (!context) return;
        const job = observedJob;
        context.injector.enqueue({
          kind: 'progress',
          context: `[PROGRESS ${job?.jobHandle ?? sessionHandle}] ${event.summary}`,
          ...(job ? { jobHandle: job.jobHandle } : {}),
        });
        return;
      }
      case 'speak': {
        if (id) this.subagents.append(id, 'message', event.text);
        if (!context) return;
        context.injector.enqueue({
          kind: 'speak',
          context: `[BACKEND ${sessionHandle}] ${event.text}`,
          spoken: event.text.slice(0, MAX_SPOKEN_SUMMARY_CHARS),
        });
        return;
      }
      case 'turn_complete': {
        const job = observedJob;
        if (job) job.state = 'done';
        if (id)
          this.subagents.result(id, 'completed', event.detail ?? event.summary);
        if (!context) return;
        const label = job?.jobHandle ?? sessionHandle;
        const spokenSummary = lastSentence(
          event.summary,
          MAX_SPOKEN_SUMMARY_CHARS,
        );
        context.injector.enqueue({
          kind: 'complete',
          context: `[COMPLETE ${label}] ${event.detail ?? event.summary}`,
          spoken: spokenSummary
            ? `${this.spokenTaskLabel(job)} finished. ${spokenSummary}`
            : `${this.spokenTaskLabel(job)} finished.`,
          ...(job ? { jobHandle: job.jobHandle } : {}),
        });
        return;
      }
      case 'turn_error': {
        const job = observedJob;
        if (job)
          job.state = event.error === 'cancelled' ? 'cancelled' : 'failed';
        if (id)
          this.subagents.result(
            id,
            event.error === 'cancelled' ? 'cancelled' : 'failed',
            event.error,
          );
        if (!context) return;
        const label = job?.jobHandle ?? sessionHandle;
        if (event.error === 'cancelled') {
          context.injector.enqueue({
            kind: 'complete',
            context: `[COMPLETE ${label}] cancelled at the user's request.`,
          });
          return;
        }
        context.injector.enqueue({
          kind: 'error',
          context: `[ERROR ${label}] ${event.error}`,
          spoken: `${this.spokenTaskLabel(job)} hit a problem. ${firstSentence(event.error, 120)}`,
          ...(job ? { jobHandle: job.jobHandle } : {}),
        });
        return;
      }
      case 'permission_request': {
        if (id)
          this.subagents.update(
            id,
            { status: 'waiting', activity: event.title },
            { kind: 'status', text: event.title },
          );
        void this.broker
          .onRequest({
            requestId: event.requestId,
            backend,
            sessionHandle,
            ...(event.jobRef !== undefined ? { jobRef: event.jobRef } : {}),
            title: event.title,
            options: event.options,
            allowAutoAnswer: context !== undefined,
          })
          .then((ask) => {
            if (ask.autoAnswered && id)
              this.subagents.update(id, { status: 'running', activity: '' });
            if (
              ask.autoAnswered ||
              ask.alreadyPending ||
              !context ||
              context.restoringBackendEvents ||
              this.active !== context ||
              context.stopping
            ) {
              return;
            }
            this.enqueuePermission(context, ask.pending);
          })
          .catch((error: unknown) => {
            // A rejected broker chain must never become an unhandled
            // rejection (it would take the whole daemon down mid-call).
            this.log.write('error', {
              source: 'permission',
              message: error instanceof Error ? error.message : String(error),
            });
            if (context && this.active === context && !context.stopping) {
              context.injector.enqueue({
                kind: 'error',
                context: `[ERROR ${sessionHandle}] A permission request could not be processed; the task may be stuck waiting for approval.`,
                spoken:
                  'A task is waiting for an approval I could not process. You may need to check it on screen.',
              });
            }
          });
        return;
      }
      case 'permission_resolved': {
        const pending = this.broker.onResolved(backend, event.requestId);
        const pendingJob = pending?.jobRef
          ? this.handles.jobByRef(backend, pending.jobRef)
          : observedJob;
        if (pendingJob)
          this.subagents.update(`harness:${pendingJob.jobHandle}`, {
            status: 'running',
            activity: '',
          });
        if (!context) return;
        const retracted = context.injector.retractPermission(
          this.scopedPermissionId(backend, event.requestId),
        );
        if (!event.byUs) {
          if (!retracted && pending) {
            context.injector.enqueue({
              kind: 'progress',
              context: `[BACKEND ${sessionHandle}] The permission request (${pending.requestHandle}) was already handled elsewhere; no answer needed.`,
            });
          }
        }
        return;
      }
      case 'session_closed': {
        // A closed session must not keep resolving every session-less
        // handoff to a dead target for the rest of the call (WebShell
        // deletion, daemon restart, idle reaper): stop resolving its
        // handle entirely and clear the default so
        // resolveHandoffTarget's createSession fall-through rebuilds.
        this.handles.closeSession(sessionHandle);
        this.reconcileSubagentSession(sessionHandle);
        this.broker.clearSession(sessionHandle);
        this.observedSessions.delete(sessionHandle);
        if (context?.defaultSessionHandle === sessionHandle) {
          context.defaultSessionHandle = undefined;
        }
        return;
      }
      default:
        return;
    }
  }

  private enqueuePermission(
    context: CallContext,
    pending: PendingPermission,
  ): void {
    context.injector.enqueue({
      kind: 'permission',
      requestId: this.scopedPermissionId(pending.backend, pending.requestId),
      context: `[PERMISSION ${pending.requestHandle}] Session ${pending.sessionHandle} wants to run: ${pending.title}. Ask the user and relay their answer with respond_permission in this response. Do not claim it was allowed until that tool returns status delivered.`,
      spoken: `The task wants to ${pending.title}. Should I allow it?`,
    });
  }

  private enqueuePendingPermissions(context: CallContext): void {
    if (this.active !== context || context.stopping) return;
    for (const pending of this.broker.pendingUserRequests) {
      this.enqueuePermission(context, pending);
    }
  }

  private schedulePermissionReminder(context: CallContext): void {
    if (this.broker.pendingUserRequests.length === 0) return;
    if (context.permissionReminderTimer !== undefined) {
      clearTimeout(context.permissionReminderTimer);
    }
    context.permissionReminderTimer = setTimeout(() => {
      context.permissionReminderTimer = undefined;
      this.enqueuePendingPermissions(context);
    }, PERMISSION_REMINDER_DELAY_MS);
    context.permissionReminderTimer.unref?.();
  }

  private scopedPermissionId(
    backend: BackendHandle,
    requestId: string,
  ): string {
    return `${backend.adaptor}:${requestId}`;
  }

  private spokenTaskLabel(job: JobRecord | undefined): string {
    if (!job) return 'A task';
    const task = firstSentence(job.task, 80);
    return task ? `The task to ${task}` : 'A task';
  }

  private proactiveTaskContext(task: ProactiveTask): ProactiveTaskContext {
    return { taskId: task.taskId, title: task.title };
  }

  private recordCommittedProactiveMutation(
    context: CallContext,
    responseId: string,
    task?: ProactiveTask,
  ): void {
    context.proactiveCommittedMutationResponses.add(responseId);
    context.recentProactiveTask = task
      ? this.proactiveTaskContext(task)
      : undefined;
  }

  private restoreAdjacentTaskAfterIncompleteTurn(
    context: CallContext,
    event: RealtimeResponseDoneEvent,
  ): void {
    const failedMutation =
      context.proactiveMutationResponses.has(event.responseId) &&
      !context.proactiveCommittedMutationResponses.has(event.responseId);
    if (event.cancellationReason !== 'superseded' && !failedMutation) return;
    const prior = context.proactiveTaskContextByResponse.get(event.responseId);
    if (prior) context.recentProactiveTask = prior;
  }

  private assertProactiveMutationSucceeded(task: ProactiveTask): void {
    if (task.status === 'failed') {
      throw new Error(task.error || 'Proactive task failed to start.');
    }
  }

  private adjacentProactiveTask(
    context: CallContext,
    responseId: string,
  ): ProactiveTaskContext | undefined {
    return context.proactiveTaskContextByResponse.get(responseId);
  }

  private proactiveRepairForResponse(
    context: CallContext,
    event: RealtimeResponseDoneEvent,
    authority: RealtimeResponseAuthority | undefined,
  ): PendingProactiveRepair | undefined {
    if (
      !context.proactive ||
      authority !== 'direct' ||
      !event.inputItemId ||
      event.status !== 'completed' ||
      context.proactiveMutationResponses.has(event.responseId)
    ) {
      return undefined;
    }
    const kind = detectProactiveRepairIntent(
      context.directAssistantTranscripts.get(event.responseId),
    );
    if (!kind) return undefined;
    const adjacentTask = context.proactiveTaskContextByResponse.get(
      event.responseId,
    );
    return {
      kind,
      ...(adjacentTask ? { adjacentTask } : {}),
    };
  }

  private requestProactiveRepair(
    context: CallContext,
    repair: PendingProactiveRepair,
  ): void {
    if (this.active !== context || context.stopping || !context.realtime)
      return;
    const instruction =
      repair.kind === 'cancel'
        ? PROACTIVE_CANCEL_REPAIR_INSTRUCTION
        : PROACTIVE_MUTATION_REPAIR_INSTRUCTION;
    const allowedTools =
      repair.kind === 'cancel'
        ? [CANCEL_PROACTIVE_TASK_TOOL_NAME]
        : PROACTIVE_MUTATION_REPAIR_TOOLS;
    let accepted = false;
    try {
      accepted = context.realtime.requestProactiveRepair(
        instruction,
        allowedTools,
      );
    } catch (error) {
      this.log.write('error', {
        source: 'proactive_repair',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (accepted) {
      context.pendingProactiveRepair = undefined;
      context.proactiveRepairAwaitingResponse = repair;
      this.debug('proactive.repair_requested', {
        epoch: context.epoch,
        kind: repair.kind,
      });
      return;
    }
    context.pendingProactiveRepair = repair;
    this.debug('proactive.repair_deferred', {
      epoch: context.epoch,
      kind: repair.kind,
    });
  }

  private retryPendingProactiveRepair(context: CallContext): void {
    const repair = context.pendingProactiveRepair;
    if (
      !repair ||
      context.speechInProgress ||
      context.responseInFlight ||
      context.responseAuthorities.size > 0
    )
      return;
    this.requestProactiveRepair(context, repair);
  }

  private onProactiveTaskFailed(
    context: CallContext,
    task: ProactiveTask,
    error: string,
  ): void {
    this.log.write('error', {
      source: 'proactive_task',
      taskId: task.taskId,
      message: error,
    });
    this.debug('proactive.task_failed', {
      epoch: context.epoch,
      taskId: task.taskId,
      reason: 'task_failed',
      errorChars: error.length,
    });
    if (this.active !== context || context.stopping) return;
    const normalizedTitle = firstSentence(task.title, 80).replace(
      /[\p{C}"“”<>[\]{}]/gu,
      '',
    );
    const notice = normalizedTitle
      ? `“${normalizedTitle}”这项后台监控未能继续运行，请重新设置。`
      : '有一项后台监控未能继续运行，请重新设置。';
    context.injector.enqueue({
      kind: 'error',
      context: `[PROACTIVE_TASK_FAILED] ${notice}`,
      spoken: notice,
    });
  }

  private settleProactiveResponse(
    context: CallContext,
    event: RealtimeResponseDoneEvent,
  ): boolean {
    const active =
      context.activeProactiveDelivery?.responseId === event.responseId
        ? context.activeProactiveDelivery
        : undefined;
    const delivery = active?.delivery ?? context.pendingProactiveDelivery;
    if (!delivery) return false;

    const deliveryId = delivery.deliveryId;
    const invalidated =
      context.invalidatedProactiveDeliveries.delete(deliveryId);
    const userInterrupted =
      event.cancellationReason === 'user_interrupted' ||
      context.userInterruptedProactiveDeliveries.has(deliveryId);

    if (invalidated) {
      if (context.pendingProactiveDelivery?.deliveryId === deliveryId) {
        context.pendingProactiveDelivery = undefined;
      }
      if (active) {
        this.clearProactiveCancellationGrace(active);
        context.activeProactiveDelivery = undefined;
      }
      context.userInterruptedProactiveDeliveries.delete(deliveryId);
      context.proactiveDeliveries.delete(deliveryId);
      context.injector.abortProactive(deliveryId);
      return false;
    }

    if (
      event.status === 'cancelled' &&
      userInterrupted &&
      !active?.playbackCompleted
    ) {
      this.deferInterruptedProactiveDelivery(context, delivery);
      return false;
    }

    if (event.status === 'failed') {
      this.failProactiveResponse(
        context,
        delivery,
        'Foreground Realtime failed while delivering a Proactive event.',
      );
      return false;
    }

    if (event.status === 'cancelled') {
      if (
        active &&
        !active.playbackCompleted &&
        !context.stopping &&
        event.cancellationReason === undefined
      ) {
        if (active.cancellationGraceTimer === undefined) {
          // Provider cancellation can precede its VAD event. Keep the FIFO
          // closed briefly without treating cancelled playback as completed.
          active.cancellationGraceTimer = setTimeout(() => {
            if (this.active !== context || context.stopping) return;
            if (context.activeProactiveDelivery !== active) return;
            this.debug('proactive.cancel_grace_expired', {
              epoch: context.epoch,
              taskId: delivery.taskId,
              deliveryId,
              responseId: active.responseId,
            });
            this.failProactiveResponse(
              context,
              delivery,
              'Foreground Realtime cancelled a Proactive event.',
            );
          }, PROACTIVE_CANCELLATION_GRACE_MS);
          active.cancellationGraceTimer.unref?.();
          this.debug('proactive.cancel_grace_wait', {
            epoch: context.epoch,
            taskId: delivery.taskId,
            deliveryId,
            responseId: active.responseId,
            graceMs: PROACTIVE_CANCELLATION_GRACE_MS,
          });
        }
        return false;
      }
      this.failProactiveResponse(
        context,
        delivery,
        'Foreground Realtime cancelled a Proactive event.',
      );
      return false;
    }

    if (active?.outputSuppressed && active.audioProduced) {
      active.responseDone = true;
      context.proactive?.acknowledgeDelivery(delivery);
      context.proactiveDeliveries.delete(deliveryId);
      context.userInterruptedProactiveDeliveries.delete(deliveryId);
      context.activeProactiveDelivery = undefined;
      return true;
    }

    if (!active || (!active.audioForwarded && !active.playbackStarted)) {
      this.failProactiveResponse(
        context,
        delivery,
        'Foreground Realtime completed a Proactive event without audio.',
      );
      return false;
    }

    active.responseDone = true;
    context.userInterruptedProactiveDeliveries.delete(deliveryId);
    if (active.playbackCompleted) {
      context.proactive?.acknowledgeDelivery(delivery);
      context.proactiveDeliveries.delete(deliveryId);
      context.activeProactiveDelivery = undefined;
    }
    return true;
  }

  private clearProactiveCancellationGrace(
    active: ActiveProactiveDelivery | undefined,
  ): boolean {
    if (active?.cancellationGraceTimer === undefined) return false;
    clearTimeout(active.cancellationGraceTimer);
    active.cancellationGraceTimer = undefined;
    return true;
  }

  private deferInterruptedProactiveDelivery(
    context: CallContext,
    delivery: ProactiveDelivery,
  ): boolean {
    const deliveryId = delivery.deliveryId;
    if (context.pendingProactiveDelivery?.deliveryId === deliveryId) {
      context.pendingProactiveDelivery = undefined;
    }
    if (context.activeProactiveDelivery?.delivery.deliveryId === deliveryId) {
      this.clearProactiveCancellationGrace(context.activeProactiveDelivery);
      context.activeProactiveDelivery = undefined;
    }
    context.userInterruptedProactiveDeliveries.delete(deliveryId);
    const deferred = context.proactive?.deferDelivery(delivery) === true;
    const requeued =
      deferred &&
      context.injector.retryProactiveAtFront({
        kind: 'proactive',
        context: delivery.event,
        deliveryId,
      });
    if (requeued) {
      this.debug('proactive.delivery_requeued', {
        epoch: context.epoch,
        taskId: delivery.taskId,
        deliveryId,
        reason: 'user_interrupted',
      });
      return true;
    }
    this.failProactiveResponse(
      context,
      delivery,
      'Interrupted Proactive delivery could not be queued again.',
    );
    return false;
  }

  private suppressProactiveOutput(
    context: CallContext,
    active: ActiveProactiveDelivery,
  ): void {
    if (active.outputSuppressed) return;
    active.outputSuppressed = true;
    if (active.responseDone) {
      context.proactive?.acknowledgeDelivery(active.delivery);
      context.proactiveDeliveries.delete(active.delivery.deliveryId);
      context.activeProactiveDelivery = undefined;
    }
    // Releasing the Injector can synchronously submit the next FIFO item.
    // Settle the completed delivery above before reopening that gate.
    context.injector.noteOutputSuppressed(true);
  }

  private failProactiveResponse(
    context: CallContext,
    delivery: ProactiveDelivery,
    error: string,
  ): void {
    const deliveryId = delivery.deliveryId;
    if (context.pendingProactiveDelivery?.deliveryId === deliveryId) {
      context.pendingProactiveDelivery = undefined;
    }
    if (context.activeProactiveDelivery?.delivery.deliveryId === deliveryId) {
      this.clearProactiveCancellationGrace(context.activeProactiveDelivery);
      context.activeProactiveDelivery = undefined;
    }
    context.invalidatedProactiveDeliveries.delete(deliveryId);
    context.userInterruptedProactiveDeliveries.delete(deliveryId);
    context.proactiveDeliveries.delete(deliveryId);
    context.proactive?.failDelivery(delivery, error);
    context.playbackSuppressed = true;
    this.host.clearOutput(context.epoch);
    context.injector.noteOutputCleared();
    context.injector.abortProactive(deliveryId);
  }

  private enqueueProactiveDelivery(
    context: CallContext,
    delivery: ProactiveDelivery,
  ): boolean {
    if (this.active !== context || context.stopping || !context.realtime) {
      return false;
    }
    context.proactiveDeliveries.set(delivery.deliveryId, delivery);
    const accepted = context.injector.enqueue({
      kind: 'proactive',
      context: delivery.event,
      deliveryId: delivery.deliveryId,
    });
    if (!accepted) {
      context.proactiveDeliveries.delete(delivery.deliveryId);
    }
    return accepted;
  }

  private invalidateProactiveDelivery(
    context: CallContext,
    delivery: ProactiveDelivery,
  ): void {
    if (this.active !== context) return;
    if (context.injector.retractProactive(delivery.deliveryId)) {
      context.proactiveDeliveries.delete(delivery.deliveryId);
      context.userInterruptedProactiveDeliveries.delete(delivery.deliveryId);
      return;
    }
    if (context.pendingProactiveDelivery?.deliveryId === delivery.deliveryId) {
      context.invalidatedProactiveDeliveries.add(delivery.deliveryId);
      // Keep the Injector cycle closed until the provider assigns this
      // already-submitted request a response id. Releasing it here could let
      // the next FIFO item overwrite pendingProactiveDelivery and claim the
      // cancelled response.
      return;
    }
    if (
      context.activeProactiveDelivery?.delivery.deliveryId ===
      delivery.deliveryId
    ) {
      const responseAlreadyCancelled = this.clearProactiveCancellationGrace(
        context.activeProactiveDelivery,
      );
      context.activeProactiveDelivery = undefined;
      context.proactiveDeliveries.delete(delivery.deliveryId);
      context.userInterruptedProactiveDeliveries.delete(delivery.deliveryId);
      context.playbackSuppressed = true;
      this.host.clearOutput(context.epoch);
      context.injector.noteOutputCleared();
      context.injector.abortProactive(delivery.deliveryId);
      if (!responseAlreadyCancelled) context.realtime?.cancelResponse();
    }
  }

  private async captureProactiveVision(
    context: CallContext,
  ): Promise<string | undefined> {
    if (
      this.active !== context ||
      context.stopping ||
      context.visualInput.mode !== 'on-demand'
    ) {
      return undefined;
    }
    const source = context.visualInput.source;
    const capture = await this.captureVisualContext(context, false);
    if (
      this.active !== context ||
      context.stopping ||
      context.visualInput.mode !== 'on-demand' ||
      context.visualInput.source !== source ||
      capture.source !== source
    ) {
      return undefined;
    }
    return capture.image;
  }

  private captureVisualContext(
    context: CallContext,
    persistAsset: boolean,
  ): Promise<LiveVisualCapture> {
    const beginCapture = () => {
      if (
        this.active !== context ||
        context.stopping ||
        context.visualInput.mode !== 'on-demand'
      ) {
        throw new Error('Visual capture is no longer available.');
      }
      return this.host.captureVisualContext(context.callId, { persistAsset });
    };
    const capture = context.visualCaptureTail
      ? context.visualCaptureTail.then(beginCapture)
      : beginCapture();
    const tail = capture.then(
      () => undefined,
      () => undefined,
    );
    context.visualCaptureTail = tail;
    void tail.then(() => {
      if (context.visualCaptureTail === tail) {
        context.visualCaptureTail = undefined;
      }
    });
    return capture;
  }

  // -- injection sinks -------------------------------------------------------

  private injectContext(context: CallContext, text: string): boolean {
    if (this.active !== context || !context.realtime || context.stopping) {
      return false;
    }
    try {
      return context.realtime.sendBackendContext(text);
    } catch {
      return false;
    }
  }

  private injectSpeech(context: CallContext, text: string): boolean {
    if (this.active !== context || !context.realtime || context.stopping) {
      return false;
    }
    try {
      return context.realtime.speakToUser(text);
    } catch {
      return false;
    }
  }

  private injectProactiveEvent(context: CallContext, event: string): boolean {
    if (this.active !== context || !context.realtime || context.stopping) {
      return false;
    }
    try {
      return context.realtime.respondToProactiveEvent(event);
    } catch {
      return false;
    }
  }

  private sendVisualSettings(context: CallContext): void {
    try {
      const sent = context.realtime?.sendBackendContext(
        `[VISUAL_INPUT] source=${context.visualInput.source} mode=${context.visualInput.mode}.`,
      );
      this.debug('visual.settings_forwarded', {
        epoch: context.epoch,
        source: context.visualInput.source,
        mode: context.visualInput.mode,
        sent: sent === true,
      });
    } catch (error) {
      this.debug('visual.settings_forwarded', {
        epoch: context.epoch,
        source: context.visualInput.source,
        mode: context.visualInput.mode,
        sent: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private forwardVisualFrame(
    context: CallContext,
    source: LiveVisualSource,
    image: string,
  ): boolean {
    try {
      const accepted = context.realtime?.pushImage(image) ?? false;
      this.debug(accepted ? 'visual.frame_forwarded' : 'visual.frame_dropped', {
        epoch: context.epoch,
        source,
        bytes: Buffer.byteLength(image, 'base64'),
        ...(accepted ? {} : { reason: 'realtime_rejected' }),
      });
      return accepted;
    } catch (error) {
      this.debug('visual.frame_dropped', {
        epoch: context.epoch,
        source,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private debug(event: string, details: Record<string, unknown>): void {
    try {
      this.logger.debug(`${event} ${JSON.stringify(details)}`);
    } catch {
      // A diagnostic sink must not interrupt background observation or calls.
    }
  }

  // -- teardown ---------------------------------------------------------------

  private finishStop(
    context: CallContext,
    outcome: void | { error: string },
  ): void {
    const resolve = context.stopResolve;
    context.stopResolve = undefined;
    this.cleanupContext(context);
    this.log.write('session.end', {
      callId: context.callId,
      ...(outcome && 'error' in outcome ? { error: outcome.error } : {}),
    });
    resolve?.(outcome);
  }

  private cleanupContext(context: CallContext): void {
    this.clearProactiveCancellationGrace(context.activeProactiveDelivery);
    this.detachMemory(context);
    if (this.active === context) {
      this.active = undefined;
      this.options.memory?.setLocked(false);
    }
    if (context.permissionReminderTimer !== undefined) {
      clearTimeout(context.permissionReminderTimer);
      context.permissionReminderTimer = undefined;
    }
    context.proactive?.dispose();
    context.proactive = undefined;
    context.proactiveDeliveries.clear();
    context.invalidatedProactiveDeliveries.clear();
    context.userInterruptedProactiveDeliveries.clear();
    context.recentProactiveTask = undefined;
    context.proactiveTaskContextByResponse.clear();
    context.proactiveMutationResponses.clear();
    context.proactiveCommittedMutationResponses.clear();
    context.directAssistantTranscripts.clear();
    context.pendingToolCalls.clear();
    context.pendingProactiveRepair = undefined;
    context.proactiveRepairAwaitingResponse = undefined;
    context.proactiveRepairReceiptPending = false;
    context.pendingProactiveDelivery = undefined;
    context.activeProactiveDelivery = undefined;
    context.injector.dispose();
    try {
      context.realtime?.close({ discardPendingInput: true });
    } catch {
      /* already closed */
    }
    // A stop() waiter must never be left hanging when the context is torn
    // down through another path (daemon shutdown, fatal error).
    const resolve = context.stopResolve;
    context.stopResolve = undefined;
    resolve?.(undefined);
  }

  private closeActive(): void {
    const context = this.active;
    if (!context) return;
    this.cleanupContext(context);
  }
}
