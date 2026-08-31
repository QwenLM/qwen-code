import { randomUUID } from 'node:crypto';
import type {
  ChannelOutputSegmentContext,
  ChannelTaskCancellationReason,
} from '@qwen-code/channel-base';
import {
  STATUS_CARD_TEMPLATE_ID,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
import type { DingtalkCardCallbackResult } from './interactive-card-types.js';
import { escapeDingTalkMarkdown } from './markdown.js';
import { sanitizeStreamingImageMarkers } from './outbound-image.js';
import {
  isChinesePresentationLanguage,
  presentationPhaseLabel,
  type DingtalkPresentationPhase,
} from './presentation-phase.js';

const FLUSH_INTERVAL_MS = 500;
const STATUS_REFRESH_INTERVAL_MS = 1_000;
const BREAKER_PROBE_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_STATUS_FAILURES = 3;
export const CONTENT_LIMIT = 20_000;
export const TRUNCATION_MARKER = '[Earlier output truncated]\n';

type StatusState = 'Running' | 'Completed' | 'Failed' | 'Stopped' | 'Cancelled';

interface StatusRecord {
  segmentId: string;
  runId: string;
  sessionId: string;
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  outTrackId: string;
  content: string;
  sourcePrefix?: string;
  phase: DingtalkPresentationPhase;
  startedAt: number;
  lastStatusSecond: number;
  ready: Promise<boolean>;
  terminal: boolean;
  streamFailed: boolean;
  consecutiveStatusFailures: number;
  stopClaimed: boolean;
  forbiddenActors: Set<string>;
  lastWriteAt: number;
  pendingSnapshot?: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  statusTimer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  writeChain: Promise<void>;
}

export interface StatusCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  cancelRun(sessionId: string, runId: string): Promise<boolean>;
  model?: string;
  language?: string;
  onError?(operation: string, error: unknown): void;
}

function boundContent(content: string): string {
  if (content.length <= CONTENT_LIMIT) return content;
  return `${TRUNCATION_MARKER}${content.slice(
    content.length - (CONTENT_LIMIT - TRUNCATION_MARKER.length),
  )}`;
}

function activeContent(
  phase: DingtalkPresentationPhase,
  content: string,
  language?: string,
  sourcePrefix?: string,
): string {
  const label = presentationPhaseLabel(phase, language);
  const sanitized = sanitizeStreamingImageMarkers(content);
  const renderedSourcePrefix =
    sourcePrefix &&
    (sanitized === sourcePrefix || sanitized.startsWith(`${sourcePrefix}\n\n`))
      ? sourcePrefix
      : undefined;
  const body = renderedSourcePrefix
    ? sanitized.slice(
        renderedSourcePrefix.length +
          (sanitized.length === renderedSourcePrefix.length ? 0 : 2),
      )
    : sanitized;
  const prefix = [label, renderedSourcePrefix].filter(Boolean).join('\n\n');
  if (!body) return prefix;

  const separator = '\n\n';
  const available = CONTENT_LIMIT - prefix.length - separator.length;
  if (body.length <= available) return `${prefix}${separator}${body}`;
  return `${prefix}${separator}${TRUNCATION_MARKER}${body.slice(
    body.length - (available - TRUNCATION_MARKER.length),
  )}`;
}

export class StatusCardController {
  private readonly recordsBySegment = new Map<string, StatusRecord>();
  private readonly recordsByOutTrack = new Map<string, StatusRecord>();
  private readonly segmentIdsByRun = new Map<string, Set<string>>();
  private readonly terminalSegmentIds = new Set<string>();

  constructor(private readonly options: StatusCardControllerOptions) {}

  ensure(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
  ): void {
    if (this.terminalSegmentIds.has(segment.segmentId)) return;
    if (!this.recordsBySegment.has(segment.segmentId)) {
      this.createRecord(segment, target);
    }
  }

  replace(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
    content: string,
  ): void {
    if (this.terminalSegmentIds.has(segment.segmentId)) return;
    const record = this.recordsBySegment.get(segment.segmentId);
    if (!record) {
      this.createRecord(segment, target, content);
      return;
    }
    if (record.terminal) return;
    record.content = boundContent(content);
    if (record.streamFailed) return;
    record.pendingSnapshot = activeContent(
      record.phase,
      record.content,
      this.options.language,
      record.sourcePrefix,
    );
    this.scheduleFlush(record);
  }

  /**
   * Whether a created, still-running status card is displaying content for
   * this segment. Awaits the in-flight creation so a boundary decision made
   * while creation is pending does not race it. A latched stream failure
   * means the card can never show further content, so it is not live.
   */
  async isCardLive(segmentId: string): Promise<boolean> {
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal || record.streamFailed) return false;
    return record.ready;
  }

  /**
   * Drain any pending snapshot so callers can treat the card's current
   * content as delivered. Returns false when there is no live record, the
   * card never became ready, or the stream failed during the drain, so the
   * caller can fall back instead of claiming delivery.
   */
  async flushPending(segmentId: string): Promise<boolean> {
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal) return false;
    if (!(await record.ready)) return false;
    while (!record.terminal && !record.streamFailed) {
      if (record.flushTimer) {
        clearTimeout(record.flushTimer);
        record.flushTimer = undefined;
      }
      this.flush(record);
      await record.writeChain;
      if (record.pendingSnapshot === undefined) break;
    }
    return !record.terminal && !record.streamFailed;
  }

  private createRecord(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
    initialContent = '',
  ): StatusRecord {
    const outTrackId = `qwen-status-${randomUUID()}`;
    const record: StatusRecord = {
      segmentId: segment.segmentId,
      runId: segment.runId,
      sessionId: segment.sessionId,
      ownerId: segment.owner.id,
      target,
      outTrackId,
      content: boundContent(initialContent),
      ...(segment.sourceLabel
        ? { sourcePrefix: escapeDingTalkMarkdown(segment.sourceLabel) }
        : {}),
      phase: 'thinking',
      startedAt: Date.now(),
      lastStatusSecond: 0,
      ready: Promise.resolve(false),
      terminal: false,
      streamFailed: false,
      consecutiveStatusFailures: 0,
      stopClaimed: false,
      forbiddenActors: new Set(),
      lastWriteAt: Date.now(),
      writeChain: Promise.resolve(),
    };
    this.recordsBySegment.set(record.segmentId, record);
    this.recordsByOutTrack.set(outTrackId, record);
    const segmentIds =
      this.segmentIdsByRun.get(record.runId) ?? new Set<string>();
    segmentIds.add(record.segmentId);
    this.segmentIdsByRun.set(record.runId, segmentIds);
    record.ready = this.create(record, target);
    void record.ready.then((ready) => {
      if (ready) this.scheduleStatusRefresh(record);
    });
    return record;
  }

  complete(
    segmentId: string,
    text: string,
    retainedContent?: (content: string) => string,
  ): Promise<boolean> {
    return this.finalize(
      segmentId,
      boundContent(text),
      'Completed',
      false,
      retainedContent,
    );
  }

  async updateRunPhase(
    runId: string,
    phase: DingtalkPresentationPhase,
  ): Promise<void> {
    const updates: Array<Promise<void>> = [];
    for (const segmentId of this.segmentIdsByRun.get(runId) ?? []) {
      const record = this.recordsBySegment.get(segmentId);
      if (
        !record ||
        record.terminal ||
        record.streamFailed ||
        record.phase === phase
      ) {
        continue;
      }
      record.phase = phase;
      if (record.pendingSnapshot !== undefined) {
        record.pendingSnapshot = activeContent(
          record.phase,
          record.content,
          this.options.language,
          record.sourcePrefix,
        );
      }
      updates.push(this.updateActiveContent(record));
    }
    await Promise.all(updates);
  }

  fail(segmentId: string, error: string): void {
    void this.finalize(segmentId, boundContent(error), 'Failed', true);
  }

  cancelRun(runId: string, reason: ChannelTaskCancellationReason): void {
    for (const segmentId of [...(this.segmentIdsByRun.get(runId) ?? [])]) {
      const record = this.recordsBySegment.get(segmentId);
      if (!record) continue;
      void this.finalize(
        segmentId,
        sanitizeStreamingImageMarkers(record.content),
        reason === 'cancel_command' ? 'Stopped' : 'Cancelled',
        false,
      );
    }
  }

  claimStop(outTrackId: string, actorId: string): DingtalkCardCallbackResult {
    const record = this.recordsByOutTrack.get(outTrackId);
    if (!record || record.terminal || record.stopClaimed) {
      return { kind: 'ignored', actorId };
    }
    if (record.ownerId !== actorId) {
      if (record.forbiddenActors.has(actorId)) {
        return { kind: 'ignored' };
      }
      record.forbiddenActors.add(actorId);
      return { kind: 'forbidden', actorId, target: record.target };
    }
    record.stopClaimed = true;
    return {
      kind: 'accepted',
      execute: async () => {
        const cancelled = await this.options.cancelRun(
          record.sessionId,
          record.runId,
        );
        if (
          this.recordsByOutTrack.get(outTrackId) !== record ||
          record.terminal
        ) {
          return;
        }
        if (!cancelled) {
          record.stopClaimed = false;
          return;
        }
        this.cancelRun(record.runId, 'cancel_command');
      },
    };
  }

  private async create(
    record: StatusRecord,
    target: { chatId: string; isGroup: boolean },
  ): Promise<boolean> {
    try {
      const initialContent = activeContent(
        record.phase,
        record.content,
        this.options.language,
        record.sourcePrefix,
      );
      await this.options.client.createAndDeliver({
        templateId: STATUS_CARD_TEMPLATE_ID,
        outTrackId: record.outTrackId,
        target,
        cardParamMap: {
          content: initialContent,
          flowStatus: 2,
          statusLine: this.statusLine(record).text,
          hasAction: 'true',
          stop_action: 'true',
        },
      });
      await this.options.client.openOrUpdateStream({
        outTrackId: record.outTrackId,
        key: 'content',
        content: initialContent,
        finalize: false,
      });
      return true;
    } catch (error) {
      this.options.onError?.('status card creation', error);
      await this.options.client
        .updateInstance({
          outTrackId: record.outTrackId,
          cardParamMap: {
            flowStatus: 3,
            statusLine: this.statusStateLabel('Unavailable'),
            hasAction: 'false',
            stop_action: 'false',
          },
        })
        .catch(() => {});
      return false;
    }
  }

  private scheduleFlush(record: StatusRecord): void {
    if (record.flushTimer || record.inFlight || record.terminal) return;
    const delay = Math.max(
      0,
      FLUSH_INTERVAL_MS - (Date.now() - record.lastWriteAt),
    );
    record.flushTimer = setTimeout(() => {
      record.flushTimer = undefined;
      this.flush(record);
    }, delay);
  }

  private flush(record: StatusRecord): void {
    if (
      record.terminal ||
      record.inFlight ||
      record.pendingSnapshot === undefined
    )
      return;
    const content = record.pendingSnapshot;
    record.pendingSnapshot = undefined;
    const write = record.writeChain
      .then(async () => {
        const ready = await record.ready;
        if (!ready || record.terminal) return;
        await this.options.client.openOrUpdateStream({
          outTrackId: record.outTrackId,
          key: 'content',
          content,
          finalize: false,
        });
        await this.updateActiveStatus(record);
      })
      .catch((error) => this.latchStreamFailure(record, error));
    const tracked = write.finally(() => {
      if (record.inFlight === tracked) {
        record.inFlight = undefined;
      }
      record.lastWriteAt = Date.now();
      if (record.pendingSnapshot !== undefined) this.scheduleFlush(record);
    });
    record.inFlight = tracked;
    record.writeChain = tracked;
  }

  private async finalize(
    segmentId: string,
    content: string,
    state: Exclude<StatusState, 'Running'>,
    isError: boolean,
    retainedContent?: (content: string) => string,
  ): Promise<boolean> {
    const record = this.recordsBySegment.get(segmentId);
    if (!record || record.terminal) return false;
    record.terminal = true;
    this.terminalSegmentIds.add(segmentId);
    while (this.terminalSegmentIds.size > 1000) {
      const oldest = this.terminalSegmentIds.values().next().value;
      if (oldest === undefined) break;
      this.terminalSegmentIds.delete(oldest);
    }
    if (record.flushTimer) clearTimeout(record.flushTimer);
    record.flushTimer = undefined;
    if (record.statusTimer) clearTimeout(record.statusTimer);
    record.statusTimer = undefined;
    record.pendingSnapshot = undefined;
    try {
      if (!(await record.ready)) return false;
      await record.writeChain;
      const retained =
        content ||
        (retainedContent ? retainedContent(record.content) : record.content);
      const finalContent = boundContent(
        sanitizeStreamingImageMarkers(retained),
      );
      await this.options.client.openOrUpdateStream({
        outTrackId: record.outTrackId,
        key: 'content',
        content: '',
        finalize: true,
        isError,
      });
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          blockList: JSON.stringify([
            {
              type: 0,
              markdown: finalContent,
            },
          ]),
          content: finalContent,
          copy_content: finalContent,
          flowStatus: 3,
          statusLine: this.statusLine(record, state).text,
          hasAction: 'false',
          stop_action: 'false',
        },
      });
      record.content = '';
      return true;
    } catch (error) {
      this.options.onError?.('status card finalization', error);
      return false;
    } finally {
      if (this.recordsBySegment.get(segmentId) === record) {
        this.recordsBySegment.delete(segmentId);
      }
      if (this.recordsByOutTrack.get(record.outTrackId) === record) {
        this.recordsByOutTrack.delete(record.outTrackId);
      }
      const segmentIds = this.segmentIdsByRun.get(record.runId);
      segmentIds?.delete(segmentId);
      if (segmentIds?.size === 0) {
        this.segmentIdsByRun.delete(record.runId);
      }
    }
  }

  private statusLine(
    record: StatusRecord,
    state?: string,
  ): { text: string; second: number } {
    const second = Math.max(
      0,
      Math.floor((Date.now() - record.startedAt) / 1000),
    );
    const model = this.options.model?.trim();
    return {
      text: [
        state ? this.statusStateLabel(state) : undefined,
        model,
        `${second}s`,
      ]
        .filter(Boolean)
        .join(' · '),
      second,
    };
  }

  private statusStateLabel(state: string): string {
    if (!isChinesePresentationLanguage(this.options.language)) {
      return state;
    }
    return (
      {
        Completed: '已完成',
        Failed: '已失败',
        Stopped: '已终止',
        Cancelled: '已取消',
        Unavailable: '不可用',
      }[state] ?? state
    );
  }

  private updateActiveContent(record: StatusRecord): Promise<void> {
    const update = record.writeChain
      .then(async () => {
        if (!(await record.ready) || record.terminal || record.streamFailed) {
          return;
        }
        await this.options.client.openOrUpdateStream({
          outTrackId: record.outTrackId,
          key: 'content',
          content: activeContent(
            record.phase,
            record.content,
            this.options.language,
            record.sourcePrefix,
          ),
          finalize: false,
        });
      })
      .catch((error) => {
        this.latchStreamFailure(record, error);
      });
    record.writeChain = update;
    return update;
  }

  private async updateActiveStatus(record: StatusRecord): Promise<void> {
    if (record.terminal || record.streamFailed) return;
    const status = this.statusLine(record);
    if (status.second === record.lastStatusSecond) return;
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: { statusLine: status.text },
      });
      record.lastStatusSecond = status.second;
      record.consecutiveStatusFailures = 0;
      // A success revives the per-second chain even when only a low-frequency
      // breaker probe is scheduled.
      if (record.statusTimer) {
        clearTimeout(record.statusTimer);
        record.statusTimer = undefined;
      }
      this.scheduleStatusRefresh(record);
    } catch (error) {
      record.consecutiveStatusFailures++;
      this.options.onError?.('status card metadata', error);
    }
  }

  private latchStreamFailure(record: StatusRecord, error: unknown): void {
    record.streamFailed = true;
    record.pendingSnapshot = undefined;
    if (record.statusTimer) {
      clearTimeout(record.statusTimer);
      record.statusTimer = undefined;
    }
    this.options.onError?.('status card streaming', error);
  }

  private scheduleStatusRefresh(
    record: StatusRecord,
    intervalMs = STATUS_REFRESH_INTERVAL_MS,
  ): void {
    if (record.terminal || record.streamFailed || record.statusTimer) return;
    const elapsed = Math.max(0, Date.now() - record.startedAt);
    const delay = Math.max(50, intervalMs - (elapsed % intervalMs));
    record.statusTimer = setTimeout(() => {
      record.statusTimer = undefined;
      if (record.terminal || record.streamFailed) return;
      const refresh = record.writeChain.then(() =>
        this.updateActiveStatus(record),
      );
      record.writeChain = refresh;
      void refresh.finally(() => {
        if (
          record.consecutiveStatusFailures >= MAX_CONSECUTIVE_STATUS_FAILURES
        ) {
          // An idle card cannot revive through a flush once the breaker
          // trips, so keep a low-frequency probe instead of stopping forever.
          this.scheduleStatusRefresh(record, BREAKER_PROBE_INTERVAL_MS);
          return;
        }
        this.scheduleStatusRefresh(record);
      });
    }, delay);
  }
}
