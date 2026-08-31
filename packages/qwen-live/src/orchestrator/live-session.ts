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
import type { LiveScreenContextCapture } from '../host/live-host-coordinator.js';
import type { LiveState } from '../host/types.js';
import { buildLiveInstructions } from '../realtime/instructions.js';
import {
  openQwenRealtimeSession,
  QWEN_REALTIME_LIMITS,
  type QwenRealtimeSession,
  type RealtimeFunctionCall,
  type RealtimeTranscriptEntry,
} from '../realtime/realtime-session.js';
import type { SessionLog } from '../log/session-log.js';
import { PermissionBroker } from '../permissions/permission-broker.js';
import {
  APPSHOT_TOOL_NAME,
  HANDOFF_TOOL_NAME,
  LIVE_SESSION_TOOLS,
  RESPOND_PERMISSION_TOOL_NAME,
  SESSION_CREATE_TOOL_NAME,
  SESSION_LIST_TOOL_NAME,
  SESSION_MONITOR_TOOL_NAME,
  SESSION_STOP_TOOL_NAME,
} from '../tools/definitions.js';
import {
  ToolDispatcher,
  type ToolContext,
  type ToolHandler,
} from '../tools/dispatcher.js';
import { HandleRegistry, type JobRecord } from '../tools/handles.js';
import { Injector } from './injector.js';

const DEFAULT_GRACEFUL_STOP_DRAIN_MS = 30_000;
const MAX_ACCESSIBILITY_CHARS = 8_000;
const MAX_VOICE_CONTEXT_ENTRIES = 12;
const MAX_VOICE_CONTEXT_CHARS = 4_000;
const MAX_SPOKEN_SUMMARY_CHARS = 200;

/**
 * The Host surface LiveSession drives. Structurally satisfied by the ported
 * LiveHostCoordinator.
 */
export interface LiveHostControl {
  setCallState(
    epoch: number,
    state: Exclude<LiveState, 'unavailable' | 'idle'>,
  ): boolean;
  /** Registers the live session as the appshot-authorized caller. */
  setCoordinator(
    epoch: number,
    locator: { workspaceCwd: string; sessionId: string },
  ): boolean;
  sendOutputAudio(epoch: number, pcm16: Uint8Array): boolean;
  clearOutput(epoch: number): void;
  setCaption(epoch: number, caption: string): boolean;
  setStatusText(epoch: number, statusText?: string): boolean;
  setTranscript?(epoch: number, transcript: string): boolean;
  failCall(epoch: number, message?: string): boolean;
  captureScreenContext(
    callerSessionId: string,
  ): Promise<LiveScreenContextCapture>;
}

export interface LiveRealtimeConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  voice?: string;
}

export interface LiveSessionOptions {
  host: LiveHostControl;
  adaptor: BackendAdaptor;
  realtime: LiveRealtimeConfig;
  log: SessionLog;
  openRealtime?: typeof openQwenRealtimeSession;
  gracefulStopDrainMs?: number;
}

interface CallContext {
  epoch: number;
  callId: string;
  realtime?: QwenRealtimeSession;
  stopping: boolean;
  speechInProgress: boolean;
  responseInFlight: boolean;
  caption: string;
  defaultSessionHandle?: string;
  /** Per backend-session event pump cancellation. */
  pumps: Map<string, AbortController>;
  injector: Injector;
  broker: PermissionBroker;
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

/**
 * The spoken take-away from a long result: its closing sentence. Backend
 * summaries are tail-clamped, so the head may start mid-sentence — the
 * final sentence is the model's own conclusion and always complete.
 */
function lastSentence(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const parts = trimmed
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
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

export class LiveSession {
  private readonly host: LiveHostControl;
  private readonly adaptor: BackendAdaptor;
  private readonly log: SessionLog;
  private readonly openRealtime: typeof openQwenRealtimeSession;
  private readonly gracefulStopDrainMs: number;
  private readonly handles = new HandleRegistry();
  private active?: CallContext;

  constructor(private readonly options: LiveSessionOptions) {
    this.host = options.host;
    this.adaptor = options.adaptor;
    this.log = options.log;
    this.openRealtime = options.openRealtime ?? openQwenRealtimeSession;
    this.gracefulStopDrainMs =
      options.gracefulStopDrainMs ?? DEFAULT_GRACEFUL_STOP_DRAIN_MS;
  }

  /**
   * The adaptor that owns a backend handle. Single-adaptor today; becomes
   * registry routing when multiple backends coexist (M4).
   */
  private adaptorFor(handle: BackendHandle): BackendAdaptor {
    if (handle.adaptor !== this.adaptor.name) {
      throw new Error(
        `unknown backend '${handle.adaptor}' (this session runs '${this.adaptor.name}')`,
      );
    }
    return this.adaptor;
  }

  /** LiveCallHandlers.onStart */
  async start(call: {
    epoch: number;
    callId: string;
    mode: 'resume' | 'new';
  }): Promise<void> {
    this.closeActive();
    const context: CallContext = {
      epoch: call.epoch,
      callId: call.callId,
      stopping: false,
      speechInProgress: false,
      responseInFlight: false,
      caption: '',
      pumps: new Map(),
      injector: new Injector({
        sink: {
          injectContext: (text) => this.injectContext(context, text),
          injectSpeech: (text) => this.injectSpeech(context, text),
          onInjected: (item, spoken) => {
            this.log.write(spoken ? 'inject.speech' : 'inject.context', {
              kind: item.kind,
              job: item.jobHandle,
              chars: item.context.length,
            });
          },
        },
      }),
      broker: new PermissionBroker({
        adaptorFor: (backend) => this.adaptorFor(backend),
        log: (type, payload) => this.log.write(type, payload),
      }),
    };
    this.active = context;
    this.log.write('session.start', {
      callId: call.callId,
      epoch: call.epoch,
      mode: call.mode,
      adaptor: this.adaptor.name,
      model: this.options.realtime.model,
      voice: this.options.realtime.voice,
    });
    this.host.setCallState(call.epoch, 'starting');
    // Register the live call itself as the appshot-authorized caller; the
    // ported host coordinator gates screen capture on this locator.
    this.host.setCoordinator(call.epoch, {
      workspaceCwd: '/',
      sessionId: call.callId,
    });

    try {
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
          instructions: buildLiveInstructions(),
          tools: LIVE_SESSION_TOOLS,
        },
        this.callbacksFor(context),
      );
      if (this.active !== context || context.stopping) {
        realtime.close({ discardPendingInput: true });
        return;
      }
      context.realtime = realtime;
      this.host.setCallState(call.epoch, 'listening');
    } catch (error) {
      this.log.write('error', {
        source: 'realtime',
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.active === context) {
        this.host.failCall(call.epoch, 'Live Voice could not connect.');
        this.active = undefined;
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
            error: 'Live Voice could not commit the final spoken input.',
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
          error:
            'Live Voice could not confirm the final spoken input before the stop deadline.',
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
      return context.realtime.pushAudio(call.pcm16);
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.closeActive();
  }

  // -- realtime callbacks ---------------------------------------------------

  private callbacksFor(context: CallContext) {
    const current = (session?: QwenRealtimeSession): boolean =>
      this.active === context &&
      (context.realtime === undefined || session === undefined
        ? true
        : context.realtime === session);

    return {
      onReady: () => {
        if (!current()) return;
        this.log.write('session.start', { phase: 'realtime_ready' });
      },
      onSpeechStarted: () => {
        if (!current()) return;
        context.speechInProgress = true;
        context.injector.noteSpeechStarted();
        this.log.write('vad.speech_started', {});
      },
      onSpeechStopped: () => {
        if (!current()) return;
        context.speechInProgress = false;
        context.injector.noteSpeechStopped();
        this.log.write('vad.speech_stopped', {});
      },
      // The provider's input-commit ack: the utterance is out of the buffer,
      // so speech is no longer "in progress" for the stop drain / injector.
      // Once stopping, pushAudio drops frames, so this ack (or the transcript
      // final below) is the only remaining clearer.
      onInputCommitted: () => {
        if (!current()) return;
        context.speechInProgress = false;
        this.log.write('vad.speech_stopped', { phase: 'input_committed' });
      },
      onInputTranscriptDone: (event: { text: string }) => {
        if (!current()) return;
        context.speechInProgress = false;
        this.host.setTranscript?.(context.epoch, event.text);
        this.log.write('transcript.user', { text: event.text });
      },
      onOutputTextDelta: (event: { text: string; source: string }) => {
        if (!current()) return;
        context.caption = `${context.caption}${event.text}`;
        this.host.setCaption(context.epoch, context.caption);
      },
      onOutputTextDone: (event: { text: string }) => {
        if (!current()) return;
        context.caption = '';
        this.log.write('transcript.assistant', { text: event.text });
      },
      onOutputAudioDelta: (event: { audio: Uint8Array }) => {
        if (!current()) return;
        this.host.sendOutputAudio(context.epoch, event.audio);
        context.injector.noteOutputAudio(event.audio.byteLength);
      },
      onResponseCreated: (event: { responseId: string; authority: string }) => {
        if (!current()) return;
        context.responseInFlight = true;
        context.injector.noteResponseCreated();
        // During the stop drain the call state must stay 'stopping' — a
        // 'speaking' flip here would strand the coordinator (its finish/fail
        // paths early-return unless the call is still 'stopping').
        if (!context.stopping) {
          this.host.setCallState(context.epoch, 'speaking');
        }
        this.log.write('response.created', {
          responseId: event.responseId,
          authority: event.authority,
        });
      },
      onResponseDone: (event: { responseId: string }) => {
        if (!current()) return;
        context.responseInFlight = false;
        context.caption = '';
        context.injector.noteResponseDone();
        if (!context.stopping) {
          this.host.setCallState(context.epoch, 'listening');
        }
        this.log.write('response.done', { responseId: event.responseId });
      },
      onBargeIn: (event: { responseId: string }) => {
        if (!current()) return;
        this.host.clearOutput(context.epoch);
        this.host.setCaption(context.epoch, '');
        this.host.setStatusText(context.epoch);
        context.injector.noteOutputCleared();
        this.log.write('playback.cleared', {
          reason: 'barge_in',
          responseId: event.responseId,
        });
      },
      onFunctionCall: (event: RealtimeFunctionCall) => {
        if (!current()) return;
        void this.dispatchTool(context, event);
      },
      onDirectTranscript: (event: {
        entries: readonly RealtimeTranscriptEntry[];
      }) => {
        if (!current()) return;
        for (const entry of event.entries) {
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
        this.host.failCall(context.epoch, 'audio frames were dropped');
      },
      onError: (error: { message: string; fatal: boolean; code?: string }) => {
        if (!current()) return;
        this.log.write('error', {
          source: 'realtime',
          code: error.code,
          message: error.message,
          fatal: error.fatal,
        });
        if (error.fatal && context.stopping) {
          // The socket is done for; the stop drain would otherwise wait the
          // full budget for response/speech flags that can never settle.
          context.responseInFlight = false;
          context.speechInProgress = false;
        }
        if (error.fatal && !context.stopping) {
          this.host.failCall(context.epoch, 'Live Voice failed.');
          this.cleanupContext(context);
        }
      },
      onClose: (info: { reason: string }) => {
        if (this.active !== context) return;
        this.log.write('session.end', { reason: info.reason });
        if (context.stopping) {
          context.responseInFlight = false;
          context.speechInProgress = false;
          return;
        }
        if (info.reason !== 'client') {
          this.host.failCall(context.epoch, 'Live Voice disconnected.');
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
    const dispatcher = new ToolDispatcher({
      handlers: this.toolHandlers(context),
    });
    if (!context.stopping) {
      this.host.setCallState(context.epoch, 'thinking');
    }
    this.log.write('tool.call', {
      name: event.name,
      callId: event.callId,
      args: event.arguments.slice(0, 2_000),
    });
    const ctx: ToolContext = { activeTranscript: event.activeTranscript };
    const result = await dispatcher.dispatch(event.name, event.arguments, ctx);
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
    if (this.active !== context || !context.realtime) return;
    try {
      context.realtime.submitFunctionOutput(
        { callEpoch: context.epoch, callId: event.callId },
        receipt,
      );
    } catch (error) {
      this.log.write('error', {
        source: 'tool_output',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private toolHandlers(context: CallContext): ReadonlyMap<string, ToolHandler> {
    const handlers = new Map<string, ToolHandler>();

    handlers.set(APPSHOT_TOOL_NAME, async () => {
      const capture = await this.host.captureScreenContext(context.callId);
      const asset = this.handles.registerAsset({
        path: capture.screenshotPath,
        mimeType: 'image/png',
      });
      return {
        status: 'ok',
        app: capture.appName,
        ...(capture.windowTitle ? { window: capture.windowTitle } : {}),
        accessibility_text: capture.accessibilityText.slice(
          0,
          MAX_ACCESSIBILITY_CHARS,
        ),
        asset: asset.assetHandle,
      };
    });

    handlers.set(SESSION_LIST_TOOL_NAME, async () => {
      const sessions = await this.adaptor.listSessions();
      return {
        status: 'ok',
        sessions: sessions.map((summary) => {
          const handle = this.handles.session(summary.handle);
          // Reconcile stale non-terminal jobs: a turn_complete emitted
          // while no pump was subscribed (pumps are per-call and aborted
          // at call end) would otherwise keep session_list reporting a
          // running active_job forever. Gated on the backend's own idle
          // report so a genuinely busy session is never touched.
          if (
            summary.state !== 'busy' &&
            !this.adaptor.isBusy(summary.handle)
          ) {
            this.handles.reconcileIdleSession(handle);
          }
          const activeJob = this.handles.activeJobForSession(handle);
          return {
            handle,
            ...(summary.label ? { label: summary.label } : {}),
            ...(summary.cwd ? { cwd: summary.cwd } : {}),
            state: this.adaptor.isBusy(summary.handle) ? 'busy' : summary.state,
            ...(activeJob ? { active_job: activeJob.jobHandle } : {}),
          };
        }),
      };
    });

    handlers.set(SESSION_CREATE_TOOL_NAME, async (args) => {
      const backend = await this.adaptor.createSession({
        ...(typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {}),
        ...(typeof args['label'] === 'string' ? { label: args['label'] } : {}),
      });
      const handle = this.handles.session(backend);
      this.ensurePump(context, handle, backend);
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
      const busy = this.adaptor.isBusy(backend);
      const receipt = await this.adaptor.prompt(backend, blocks, {
        steer: busy,
      });
      if (receipt.status === 'rejected') {
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
      this.ensurePump(context, handle, backend);
      return {
        status: receipt.status,
        job: job.jobHandle,
        session: handle,
        ...(receipt.note ? { note: receipt.note } : {}),
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
      if (!this.adaptor.isBusy(backend)) {
        this.handles.reconcileIdleSession(sessionHandle);
      }
      const activeJob = job ?? this.handles.activeJobForSession(sessionHandle);
      return {
        status: 'ok',
        session: sessionHandle,
        state: this.adaptor.isBusy(backend) ? 'busy' : 'idle',
        ...(activeJob
          ? {
              job: activeJob.jobHandle,
              job_state: activeJob.state,
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
      await this.adaptor.cancel(backend);
      if (job) job.state = 'cancelled';
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
      const pending = context.broker.resolveHandle(requestHandle);
      const outcome = await context.broker.respond(
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
      // The vote channel carries no free text; a user constraint ("only this
      // file") would otherwise be silently discarded — the grant would be
      // broader than the user believes. Relay it as a user instruction to
      // the same backend session through the existing prompt/steer path.
      if (note && pending && outcome === 'delivered') {
        try {
          await this.adaptor.prompt(
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
            { steer: this.adaptor.isBusy(pending.backend) },
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
    const backend = await this.adaptor.createSession({ label: 'Voice chat' });
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

  private ensurePump(
    context: CallContext,
    sessionHandle: string,
    backend: BackendHandle,
  ): void {
    if (context.pumps.has(sessionHandle)) return;
    const abort = new AbortController();
    context.pumps.set(sessionHandle, abort);
    void this.pump(context, sessionHandle, backend, abort.signal).catch(
      (error) => {
        this.log.write('error', {
          source: 'pump',
          session: sessionHandle,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  private async pump(
    context: CallContext,
    sessionHandle: string,
    backend: BackendHandle,
    signal: AbortSignal,
  ): Promise<void> {
    // The SSE stream can end without a session_closed (daemon restart,
    // dropped connection). Resubscribe with backoff instead of leaving the
    // session permanently unobserved — completion events would be lost.
    let backoffMs = 1_000;
    while (this.active === context && !signal.aborted) {
      let sawEvent = false;
      try {
        for await (const event of this.adaptor.events(backend, { signal })) {
          if (this.active !== context) return;
          sawEvent = true;
          backoffMs = 1_000;
          this.log.write('backend.event', {
            session: sessionHandle,
            type: event.type,
            ...('jobRef' in event && event.jobRef !== undefined
              ? { jobRef: event.jobRef }
              : {}),
          });
          this.onBackendEvent(context, sessionHandle, backend, event);
          if (event.type === 'session_closed') {
            context.pumps.delete(sessionHandle);
            return;
          }
        }
      } catch (error) {
        if (signal.aborted || this.active !== context) break;
        this.log.write('error', {
          source: 'pump',
          session: sessionHandle,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal.aborted || this.active !== context) break;
      this.log.write('backend.event', {
        session: sessionHandle,
        type: 'stream_ended',
        resubscribeInMs: backoffMs,
        sawEvent,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs);
        timer.unref?.();
      });
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
    context.pumps.delete(sessionHandle);
  }

  private onBackendEvent(
    context: CallContext,
    sessionHandle: string,
    backend: BackendHandle,
    event: BackendEvent,
  ): void {
    switch (event.type) {
      case 'turn_started': {
        const job = event.jobRef
          ? this.handles.jobByRef(backend, event.jobRef)
          : undefined;
        if (job) job.state = 'running';
        return;
      }
      case 'progress': {
        const job = this.jobFor(sessionHandle, backend, event.jobRef);
        context.injector.enqueue({
          kind: 'progress',
          context: `[PROGRESS ${job?.jobHandle ?? sessionHandle}] ${event.summary}`,
          ...(job ? { jobHandle: job.jobHandle } : {}),
        });
        return;
      }
      case 'speak': {
        context.injector.enqueue({
          kind: 'speak',
          context: `[BACKEND ${sessionHandle}] ${event.text}`,
          spoken: event.text.slice(0, MAX_SPOKEN_SUMMARY_CHARS),
        });
        return;
      }
      case 'turn_complete': {
        const job = this.jobFor(sessionHandle, backend, event.jobRef);
        if (job) job.state = 'done';
        const label = job?.jobHandle ?? sessionHandle;
        const spokenSummary = lastSentence(
          event.summary,
          MAX_SPOKEN_SUMMARY_CHARS,
        );
        context.injector.enqueue({
          kind: 'complete',
          context: `[COMPLETE ${label}] ${event.detail ?? event.summary}`,
          spoken: spokenSummary
            ? `Task ${label} finished. ${spokenSummary}`
            : `Task ${label} finished.`,
          ...(job ? { jobHandle: job.jobHandle } : {}),
        });
        return;
      }
      case 'turn_error': {
        const job = this.jobFor(sessionHandle, backend, event.jobRef);
        if (job)
          job.state = event.error === 'cancelled' ? 'cancelled' : 'failed';
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
          spoken: `Task ${label} hit a problem. ${firstSentence(event.error, 120)}`,
          ...(job ? { jobHandle: job.jobHandle } : {}),
        });
        return;
      }
      case 'permission_request': {
        void context.broker
          .onRequest({
            requestId: event.requestId,
            backend,
            sessionHandle,
            title: event.title,
            options: event.options,
          })
          .then((ask) => {
            if (ask.autoAnswered || this.active !== context) return;
            context.injector.enqueue({
              kind: 'permission',
              requestId: event.requestId,
              context: `[PERMISSION ${ask.pending.requestHandle}] Session ${sessionHandle} wants to run: ${event.title}. Ask the user and relay their answer with respond_permission.`,
              spoken: `The task wants to ${event.title}. Should I allow it?`,
            });
          })
          .catch((error: unknown) => {
            // A rejected broker chain must never become an unhandled
            // rejection (it would take the whole daemon down mid-call).
            this.log.write('error', {
              source: 'permission',
              message: error instanceof Error ? error.message : String(error),
            });
            if (this.active === context) {
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
        const pending = context.broker.onResolved(backend, event.requestId);
        if (!event.byUs) {
          const retracted = context.injector.retractPermission(event.requestId);
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
        if (context.defaultSessionHandle === sessionHandle) {
          context.defaultSessionHandle = undefined;
        }
        return;
      }
      default:
        return;
    }
  }

  private jobFor(
    sessionHandle: string,
    backend: BackendHandle,
    jobRef: string | undefined,
  ): JobRecord | undefined {
    if (jobRef) {
      const byRef = this.handles.jobByRef(backend, jobRef);
      if (byRef) return byRef;
    }
    return this.handles.activeJobForSession(sessionHandle);
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
    if (this.active === context) this.active = undefined;
    context.injector.dispose();
    for (const abort of context.pumps.values()) abort.abort();
    context.pumps.clear();
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
