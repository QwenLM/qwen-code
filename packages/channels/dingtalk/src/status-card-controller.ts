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
import { sanitizeStreamingImageMarkers } from './outbound-image.js';

const FLUSH_INTERVAL_MS = 500;
const CONTENT_LIMIT = 20_000;
const TRUNCATION_MARKER = '[Earlier output truncated]\n';

type StatusState = 'Running' | 'Completed' | 'Failed' | 'Stopped' | 'Cancelled';

interface StatusRecord {
  segmentId: string;
  runId: string;
  sessionId: string;
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  outTrackId: string;
  content: string;
  startedAt: number;
  lastStatusSecond: number;
  ready: Promise<boolean>;
  terminal: boolean;
  streamFailed: boolean;
  stopClaimed: boolean;
  forbiddenActors: Set<string>;
  lastWriteAt: number;
  pendingSnapshot?: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  writeChain: Promise<void>;
}

export interface StatusCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  cancelRun(sessionId: string, runId: string): Promise<boolean>;
  model?: string;
  onError?(operation: string, error: unknown): void;
}

function boundContent(content: string): string {
  if (content.length <= CONTENT_LIMIT) return content;
  return `${TRUNCATION_MARKER}${content.slice(
    content.length - (CONTENT_LIMIT - TRUNCATION_MARKER.length),
  )}`;
}

export class StatusCardController {
  private readonly recordsBySegment = new Map<string, StatusRecord>();
  private readonly recordsByOutTrack = new Map<string, StatusRecord>();
  private readonly segmentIdsByRun = new Map<string, Set<string>>();
  private readonly terminalSegmentIds = new Set<string>();

  constructor(private readonly options: StatusCardControllerOptions) {}

  append(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
    chunk: string,
  ): void {
    if (!chunk || this.terminalSegmentIds.has(segment.segmentId)) return;
    let record = this.recordsBySegment.get(segment.segmentId);
    if (!record) {
      record = this.createRecord(segment, target);
    }
    if (record.terminal) return;
    record.content = boundContent(record.content + chunk);
    if (record.streamFailed) return;
    record.pendingSnapshot = sanitizeStreamingImageMarkers(record.content);
    this.scheduleFlush(record);
  }

  private createRecord(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
  ): StatusRecord {
    const outTrackId = `qwen-status-${randomUUID()}`;
    const record: StatusRecord = {
      segmentId: segment.segmentId,
      runId: segment.runId,
      sessionId: segment.sessionId,
      ownerId: segment.owner.id,
      target,
      outTrackId,
      content: '',
      startedAt: Date.now(),
      lastStatusSecond: 0,
      ready: Promise.resolve(false),
      terminal: false,
      streamFailed: false,
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
    return record;
  }

  complete(segmentId: string, text: string): Promise<boolean> {
    return this.finalize(segmentId, boundContent(text), 'Completed', false);
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
      await this.options.client.createAndDeliver({
        templateId: STATUS_CARD_TEMPLATE_ID,
        outTrackId: record.outTrackId,
        target,
        cardParamMap: {
          content: '',
          flowStatus: 2,
          statusLine: this.statusLine(record, 'Running').text,
          hasAction: 'true',
          stop_action: 'true',
        },
      });
      await this.options.client.openOrUpdateStream({
        outTrackId: record.outTrackId,
        key: 'content',
        content: '',
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
            statusLine: 'Unavailable',
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
        await this.updateRunningStatus(record);
      })
      .catch((error) => {
        record.streamFailed = true;
        record.pendingSnapshot = undefined;
        this.options.onError?.('status card streaming', error);
      });
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
    record.pendingSnapshot = undefined;
    try {
      if (!(await record.ready)) return false;
      await record.writeChain;
      const finalContent = boundContent(
        sanitizeStreamingImageMarkers(content || record.content),
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
    state: StatusState,
  ): { text: string; second: number } {
    const second = Math.max(
      0,
      Math.floor((Date.now() - record.startedAt) / 1000),
    );
    const model = this.options.model?.trim();
    return {
      text: [state, model, `${second}s`].filter(Boolean).join(' · '),
      second,
    };
  }

  private async updateRunningStatus(record: StatusRecord): Promise<void> {
    if (record.terminal) return;
    const status = this.statusLine(record, 'Running');
    if (status.second === record.lastStatusSecond) return;
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: { statusLine: status.text },
      });
      record.lastStatusSecond = status.second;
    } catch (error) {
      this.options.onError?.('status card metadata', error);
    }
  }
}
