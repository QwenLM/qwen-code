/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Result backflow: takes normalized backend happenings and injects them into
 * the realtime conversation at safe moments.
 *
 * Spoken/detail split: every item lands as silent context (the model can
 * answer follow-ups from it), and speech-worthy items additionally trigger a
 * short verbatim spoken line.
 *
 * The injection window is closed while any of these hold:
 *  1. the user is speaking (VAD),
 *  2. a realtime response is in flight,
 *  3. output audio is still estimated to be playing.
 * Protocol v6 has no playback acknowledgement from the Host, so (3) is a
 * conservative estimate: bytes sent ÷ 48,000 B/s (24 kHz mono PCM16) plus a
 * quiet gap. The v7 protocol upgrade replaces this with a real receipt.
 */

const QUIET_GAP_MS = 800;
const RECHECK_MIN_MS = 100;
const PROGRESS_THROTTLE_MS = 5 * 60_000;
const MAX_SPOKEN_CHARS = 280;
const MAX_CONTEXT_CHARS = 6_000;
/** 24 kHz mono PCM16. */
const PLAYBACK_BYTES_PER_MS = 48;

export type InjectorItemKind =
  | 'complete'
  | 'progress'
  | 'permission'
  | 'error'
  | 'speak';

export interface InjectorItem {
  kind: InjectorItemKind;
  /** Silent context body (without prefix). */
  context: string;
  /** Verbatim spoken line; omitted items inject silently. */
  spoken?: string;
  jobHandle?: string;
  /** For permission items: lets a remote resolution retract the ask. */
  requestId?: string;
}

export interface InjectorSink {
  /** Silent context injection; false when the transport refused. */
  injectContext(text: string): boolean;
  /** Verbatim speech request; false when the transport refused. */
  injectSpeech(text: string): boolean;
  onInjected?(item: InjectorItem, spoken: boolean): void;
}

export interface InjectorOptions {
  sink: InjectorSink;
  now?: () => number;
  quietGapMs?: number;
  progressThrottleMs?: number;
}

/**
 * Progress-throttle key: the job handle when the item has one, otherwise the
 * item's full context (the map is per-call and bounded in practice).
 */
function progressKeyOf(item: InjectorItem): string {
  return item.jobHandle ?? `ctx:${item.context}`;
}

export class Injector {
  private readonly sink: InjectorSink;
  private readonly now: () => number;
  private readonly quietGapMs: number;
  private readonly progressThrottleMs: number;

  private queue: InjectorItem[] = [];
  private speechInProgress = false;
  private responseInFlight = false;
  private playbackDeadline = 0;
  private lastProgressAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: InjectorOptions) {
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.quietGapMs = options.quietGapMs ?? QUIET_GAP_MS;
    this.progressThrottleMs =
      options.progressThrottleMs ?? PROGRESS_THROTTLE_MS;
  }

  // -- window state signals (fed by the orchestrator) ----------------------

  noteSpeechStarted(): void {
    this.speechInProgress = true;
    // Barge-in semantics: pending progress is stale the moment the user
    // speaks; conclusions and permission asks stay queued. A dropped item
    // was never delivered, so its throttle stamp must not stand — the job's
    // next progress report may come well within the window.
    const kept: InjectorItem[] = [];
    for (const item of this.queue) {
      if (item.kind === 'progress') {
        this.lastProgressAt.delete(progressKeyOf(item));
      } else {
        kept.push(item);
      }
    }
    this.queue = kept;
  }

  noteSpeechStopped(): void {
    this.speechInProgress = false;
    this.poke();
  }

  noteResponseCreated(): void {
    this.responseInFlight = true;
  }

  noteResponseDone(): void {
    this.responseInFlight = false;
    this.poke();
  }

  noteOutputAudio(bytes: number): void {
    const start = Math.max(this.now(), this.playbackDeadline);
    this.playbackDeadline = start + bytes / PLAYBACK_BYTES_PER_MS;
  }

  noteOutputCleared(): void {
    this.playbackDeadline = 0;
    this.poke();
  }

  // -- queue --------------------------------------------------------------

  enqueue(item: InjectorItem): void {
    if (this.disposed) return;
    if (item.kind === 'progress') {
      // Throttle per job; jobless progress is keyed on its full context so
      // distinct notices (which may share a long common prefix) never
      // collide on one throttle window.
      const key = progressKeyOf(item);
      const last = this.lastProgressAt.get(key) ?? 0;
      if (this.now() - last < this.progressThrottleMs) return;
      this.lastProgressAt.set(key, this.now());
      // At most one queued progress item per key.
      this.queue = this.queue.filter(
        (queued) =>
          !(queued.kind === 'progress' && progressKeyOf(queued) === key),
      );
    }
    this.queue.push(item);
    this.poke();
  }

  /** Retract a queued permission ask that was resolved elsewhere. */
  retractPermission(requestId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      (item) => !(item.kind === 'permission' && item.requestId === requestId),
    );
    return this.queue.length !== before;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // -- delivery -----------------------------------------------------------

  private windowClosedForMs(): number {
    if (this.speechInProgress || this.responseInFlight) return -1;
    const quietAt = this.playbackDeadline + this.quietGapMs;
    const wait = quietAt - this.now();
    return wait > 0 ? wait : 0;
  }

  private poke(): void {
    if (this.disposed || this.queue.length === 0) return;
    const wait = this.windowClosedForMs();
    if (wait < 0) return; // reopened by a state signal later
    if (wait === 0) {
      this.flush();
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.poke();
      },
      Math.max(wait, RECHECK_MIN_MS),
    );
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    // Permission asks first: the context join is size-capped, and a
    // truncated [PERMISSION] entry would lose the handle the model needs
    // for respond_permission.
    const batch = [
      ...this.queue.filter((item) => item.kind === 'permission'),
      ...this.queue.filter((item) => item.kind !== 'permission'),
    ];
    this.queue = [];

    // One combined silent context injection for the whole batch.
    const context = batch
      .map((item) => item.context)
      .join('\n')
      .slice(0, MAX_CONTEXT_CHARS);
    const contextAccepted = this.sink.injectContext(context);

    // One combined spoken line for the speech-worthy items — whole lines
    // only, since the model is told to read the text verbatim.
    const spokenLines = batch
      .map((item) => item.spoken)
      .filter((line): line is string => typeof line === 'string' && !!line);
    let spoken = '';
    for (const line of spokenLines) {
      const candidate = spoken ? `${spoken} ${line}` : line;
      if (candidate.length > MAX_SPOKEN_CHARS && spoken) break;
      spoken =
        candidate.length > MAX_SPOKEN_CHARS
          ? `${candidate.slice(0, MAX_SPOKEN_CHARS)}…`
          : candidate;
    }
    let spokenAccepted = false;
    if (spoken) {
      spokenAccepted = this.sink.injectSpeech(spoken);
    }

    if (!contextAccepted && !spokenAccepted) {
      // Transport refused (socket busy/closed): requeue and retry shortly.
      this.queue = [...batch, ...this.queue];
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.poke();
      }, this.quietGapMs);
      this.timer.unref?.();
      return;
    }
    for (const item of batch) {
      this.sink.onInjected?.(item, spokenLines.length > 0);
    }
  }
}
