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
 *  3. Host playback has started but has not completed.
 * The negotiated Host playback protocol supplies the receipts used for (3).
 */

const QUIET_GAP_MS = 800;
const RECHECK_MIN_MS = 100;
const PROGRESS_THROTTLE_MS = 5 * 60_000;
const MAX_SPOKEN_CHARS = 280;
const MAX_CONTEXT_CHARS = 6_000;

export type InjectorItemKind =
  | 'complete'
  | 'progress'
  | 'permission'
  | 'error'
  | 'speak'
  | 'proactive';

export interface InjectorItem {
  kind: InjectorItemKind;
  /** Silent context body (without prefix). */
  context: string;
  /** Verbatim spoken line; omitted items inject silently. */
  spoken?: string;
  jobHandle?: string;
  /** For permission items: lets a remote resolution retract the ask. */
  requestId?: string;
  /** Stable scheduler delivery id for a queued Proactive announcement. */
  deliveryId?: string;
}

export interface InjectorSink {
  /** Silent context injection; false when the transport refused. */
  injectContext(text: string): boolean;
  /** Verbatim speech request; false when the transport refused. */
  injectSpeech(text: string): boolean;
  /** A model-authored Proactive response request; false when refused. */
  injectProactive?(text: string): boolean;
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
  private directResponsePending = false;
  private responseRequestPending = false;
  private playbackInProgress = false;
  private playbackCompletedAt = 0;
  private proactiveCycle:
    | {
        deliveryId?: string;
        responseStarted: boolean;
        responseDone: boolean;
        playbackStarted: boolean;
        playbackDone: boolean;
      }
    | undefined;
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

  noteSpeechStarted(): boolean {
    const outputWasPlaying = this.playbackInProgress;
    this.playbackInProgress = false;
    this.playbackCompletedAt = 0;
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
    return outputWasPlaying;
  }

  noteInputCommitted(responsePending = false): void {
    this.speechInProgress = false;
    this.directResponsePending = responsePending;
    this.poke();
  }

  noteResponseCreated(authority?: string): void {
    this.directResponsePending = false;
    this.responseRequestPending = false;
    this.responseInFlight = true;
    if (authority === 'proactive' && this.proactiveCycle) {
      this.proactiveCycle.responseStarted = true;
    }
  }

  noteResponseDone(authority?: string): void {
    this.responseInFlight = false;
    if (authority === 'proactive' && this.proactiveCycle) {
      this.proactiveCycle.responseDone = true;
      this.finishProactiveCycleIfComplete();
    }
    this.poke();
  }

  notePlaybackStarted(): void {
    this.playbackInProgress = true;
    this.playbackCompletedAt = 0;
    if (this.proactiveCycle?.responseStarted) {
      this.proactiveCycle.playbackStarted = true;
    }
  }

  notePlaybackCompleted(): void {
    this.playbackInProgress = false;
    this.playbackCompletedAt = this.now();
    if (this.proactiveCycle?.playbackStarted) {
      this.proactiveCycle.playbackDone = true;
      this.finishProactiveCycleIfComplete();
    }
    this.poke();
  }

  noteOutputCleared(): void {
    this.playbackInProgress = false;
    this.playbackCompletedAt = 0;
    this.poke();
  }

  /**
   * Release playback suppressed by an explicit user mute. A Proactive cycle
   * is completed only when the caller confirms that real response audio was
   * present; muting before any audio must not turn a silent response into a
   * successful delivery.
   */
  noteOutputSuppressed(completeProactive = false): void {
    this.playbackInProgress = false;
    this.playbackCompletedAt = 0;
    if (completeProactive && this.proactiveCycle) {
      this.proactiveCycle.playbackDone = true;
      this.finishProactiveCycleIfComplete();
    }
    this.poke();
  }

  // -- queue --------------------------------------------------------------

  enqueue(item: InjectorItem): boolean {
    if (this.disposed) return false;
    if (
      item.kind === 'permission' &&
      item.requestId !== undefined &&
      this.queue.some(
        (queued) =>
          queued.kind === 'permission' && queued.requestId === item.requestId,
      )
    ) {
      return true;
    }
    if (item.kind === 'progress') {
      // Throttle per job; jobless progress is keyed on its full context so
      // distinct notices (which may share a long common prefix) never
      // collide on one throttle window.
      const key = progressKeyOf(item);
      const last = this.lastProgressAt.get(key) ?? 0;
      if (this.now() - last < this.progressThrottleMs) return true;
      this.lastProgressAt.set(key, this.now());
      // At most one queued progress item per key.
      this.queue = this.queue.filter(
        (queued) =>
          !(queued.kind === 'progress' && progressKeyOf(queued) === key),
      );
    }
    this.queue.push(item);
    this.poke();
    return true;
  }

  /** Retract a queued permission ask that was resolved elsewhere. */
  retractPermission(requestId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      (item) => !(item.kind === 'permission' && item.requestId === requestId),
    );
    return this.queue.length !== before;
  }

  /** Retract a Proactive event that has not been submitted to Realtime yet. */
  retractProactive(deliveryId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      (item) => !(item.kind === 'proactive' && item.deliveryId === deliveryId),
    );
    return this.queue.length !== before;
  }

  /** Release an accepted Proactive cycle after cancellation or fatal failure. */
  abortProactive(deliveryId: string): boolean {
    if (this.proactiveCycle?.deliveryId !== deliveryId) return false;
    this.proactiveCycle = undefined;
    this.poke();
    return true;
  }

  /**
   * Atomically put an interrupted Proactive delivery back at the head of its
   * lane. Resetting the active cycle and prepending must be one operation;
   * otherwise aborting first could let the next queued delivery overtake it.
   */
  retryProactiveAtFront(item: InjectorItem): boolean {
    if (
      this.disposed ||
      item.kind !== 'proactive' ||
      !item.deliveryId ||
      this.proactiveCycle?.deliveryId !== item.deliveryId
    ) {
      return false;
    }
    this.proactiveCycle = undefined;
    this.queue = [
      item,
      ...this.queue.filter(
        (queued) =>
          queued.kind !== 'proactive' || queued.deliveryId !== item.deliveryId,
      ),
    ];
    this.poke();
    return true;
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
    if (this.speechInProgress || this.responseInFlight || this.proactiveCycle) {
      return -1;
    }
    if (
      this.queue[0]?.kind === 'proactive' &&
      (this.directResponsePending || this.responseRequestPending)
    ) {
      return -1;
    }
    if (this.playbackInProgress) return -1;
    if (this.playbackCompletedAt > 0) {
      const quietAt = this.playbackCompletedAt + this.quietGapMs;
      const wait = quietAt - this.now();
      return wait > 0 ? wait : 0;
    }
    return 0;
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
    const firstProactive = this.queue.findIndex(
      (item) => item.kind === 'proactive',
    );
    if (firstProactive === 0) {
      this.flushProactive();
      return;
    }
    const batchEnd = firstProactive < 0 ? this.queue.length : firstProactive;
    const pending = this.queue.slice(0, batchEnd);
    // Permission asks first: the context join is size-capped, and a
    // truncated [PERMISSION] entry would lose the handle the model needs
    // for respond_permission.
    const batch = [
      ...pending.filter((item) => item.kind === 'permission'),
      ...pending.filter((item) => item.kind !== 'permission'),
    ];
    this.queue = this.queue.slice(batchEnd);

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
      if (spokenAccepted) this.responseRequestPending = true;
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
    this.poke();
  }

  private flushProactive(): void {
    const item = this.queue[0];
    if (!item || item.kind !== 'proactive') return;
    this.proactiveCycle = {
      ...(item.deliveryId ? { deliveryId: item.deliveryId } : {}),
      responseStarted: false,
      responseDone: false,
      playbackStarted: false,
      playbackDone: false,
    };
    const accepted = this.sink.injectProactive
      ? this.sink.injectProactive(item.context)
      : this.sink.injectSpeech(item.context);
    if (!accepted) {
      this.proactiveCycle = undefined;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.poke();
      }, this.quietGapMs);
      this.timer.unref?.();
      return;
    }
    this.queue.shift();
    this.sink.onInjected?.(item, true);
  }

  private finishProactiveCycleIfComplete(): void {
    const cycle = this.proactiveCycle;
    if (!cycle || !cycle.responseDone || !cycle.playbackDone) return;
    this.proactiveCycle = undefined;
  }
}
