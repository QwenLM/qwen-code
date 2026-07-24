import { randomUUID } from 'node:crypto';
import type {
  ChannelTaskCancellationReason,
  ChannelTaskLifecycleEvent,
} from '@qwen-code/channel-base';
import {
  STATUS_CARD_TEMPLATE_ID,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';

const FLUSH_INTERVAL_MS = 500;
const CONTENT_LIMIT = 20_000;
const TRUNCATION_MARKER = '[Earlier output truncated]\n';

type StartedEvent = Extract<ChannelTaskLifecycleEvent, { type: 'started' }>;

interface StatusRecord {
  runId: string;
  sessionId: string;
  ownerId: string;
  outTrackId: string;
  content: string;
  ready: Promise<boolean>;
  terminal: boolean;
  streamFailed: boolean;
  stopClaimed: boolean;
  waiting: boolean;
  lastWriteAt: number;
  pendingSnapshot?: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
}

export interface StatusCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  cancelRun(sessionId: string, runId: string): Promise<boolean>;
  onError?(operation: string, error: unknown): void;
}

function boundContent(content: string): string {
  if (content.length <= CONTENT_LIMIT) return content;
  return `${TRUNCATION_MARKER}${content.slice(
    content.length - (CONTENT_LIMIT - TRUNCATION_MARKER.length),
  )}`;
}

export class StatusCardController {
  private readonly recordsByRun = new Map<string, StatusRecord>();
  private readonly recordsByOutTrack = new Map<string, StatusRecord>();

  constructor(private readonly options: StatusCardControllerOptions) {}

  start(
    event: StartedEvent,
    target: { chatId: string; isGroup: boolean },
  ): string {
    const outTrackId = `qwen-status-${randomUUID()}`;
    const record: StatusRecord = {
      runId: event.runId!,
      sessionId: event.sessionId,
      ownerId: event.owner!.id,
      outTrackId,
      content: '',
      ready: Promise.resolve(false),
      terminal: false,
      streamFailed: false,
      stopClaimed: false,
      waiting: false,
      lastWriteAt: Date.now(),
    };
    this.recordsByRun.set(record.runId, record);
    this.recordsByOutTrack.set(outTrackId, record);
    record.ready = this.create(record, target);
    return outTrackId;
  }

  append(runId: string, chunk: string): void {
    const record = this.recordsByRun.get(runId);
    if (!record || record.terminal || !chunk) return;
    record.content = boundContent(record.content + chunk);
    if (record.streamFailed) return;
    record.pendingSnapshot = record.content;
    this.scheduleFlush(record);
  }

  setWaitingInput(runId: string, waiting: boolean): void {
    const record = this.recordsByRun.get(runId);
    if (!record || record.terminal || record.waiting === waiting) return;
    record.waiting = waiting;
    void record.ready
      .then(async (ready) => {
        if (!ready || record.terminal) return;
        await this.options.client.updateInstance({
          outTrackId: record.outTrackId,
          cardParamMap: {
            flowStatus: 2,
            statusLine: waiting ? 'Waiting for input' : 'Running',
          },
        });
      })
      .catch((error) => {
        this.options.onError?.('status card state update', error);
      });
  }

  complete(runId: string, text: string): Promise<boolean> {
    return this.finalize(runId, boundContent(text), 'Completed', false);
  }

  fail(runId: string, error: string): void {
    void this.finalize(runId, boundContent(error), 'Failed', true);
  }

  cancel(runId: string, reason: ChannelTaskCancellationReason): void {
    void this.finalize(
      runId,
      this.recordsByRun.get(runId)?.content ?? '',
      reason === 'cancel_command' ? 'Stopped' : 'Cancelled',
      false,
    );
  }

  claimStop(
    outTrackId: string,
    ownerId: string,
  ): (() => Promise<void>) | undefined {
    const record = this.recordsByOutTrack.get(outTrackId);
    if (
      !record ||
      record.terminal ||
      record.stopClaimed ||
      record.ownerId !== ownerId
    ) {
      return undefined;
    }
    record.stopClaimed = true;
    return async () => {
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
      this.cancel(record.runId, 'cancel_command');
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
          statusLine: 'Running',
          hasAction: '1',
          stop_action: '1',
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
            hasAction: '0',
            stop_action: '0',
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
    if (record.terminal || record.inFlight || !record.pendingSnapshot) return;
    const content = record.pendingSnapshot;
    record.pendingSnapshot = undefined;
    record.inFlight = record.ready
      .then(async (ready) => {
        if (!ready || record.terminal) return;
        await this.options.client.openOrUpdateStream({
          outTrackId: record.outTrackId,
          key: 'content',
          content,
          finalize: false,
        });
      })
      .catch((error) => {
        record.streamFailed = true;
        record.pendingSnapshot = undefined;
        this.options.onError?.('status card streaming', error);
      })
      .finally(() => {
        record.inFlight = undefined;
        record.lastWriteAt = Date.now();
        if (record.pendingSnapshot) this.scheduleFlush(record);
      });
  }

  private async finalize(
    runId: string,
    content: string,
    statusLine: string,
    isError: boolean,
  ): Promise<boolean> {
    const record = this.recordsByRun.get(runId);
    if (!record || record.terminal) return false;
    record.terminal = true;
    if (record.flushTimer) clearTimeout(record.flushTimer);
    record.flushTimer = undefined;
    record.pendingSnapshot = undefined;
    try {
      if (!(await record.ready)) return false;
      await record.inFlight;
      await this.options.client.openOrUpdateStream({
        outTrackId: record.outTrackId,
        key: 'content',
        content,
        finalize: true,
        isError,
      });
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          content,
          copyContent: content,
          flowStatus: 3,
          statusLine,
          hasAction: '0',
          stop_action: '0',
        },
      });
      record.content = '';
      return true;
    } catch (error) {
      this.options.onError?.('status card finalization', error);
      return false;
    } finally {
      if (this.recordsByRun.get(runId) === record) {
        this.recordsByRun.delete(runId);
      }
      if (this.recordsByOutTrack.get(record.outTrackId) === record) {
        this.recordsByOutTrack.delete(record.outTrackId);
      }
    }
  }
}
