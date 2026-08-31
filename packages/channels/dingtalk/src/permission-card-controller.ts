import { randomUUID } from 'node:crypto';
import type {
  ChannelPermissionDecision,
  ChannelPermissionRequestContext,
  UserInputPresentationResult,
} from '@qwen-code/channel-base';
import {
  QUESTION_CARD_TEMPLATE_ID,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
import type {
  DingtalkCardCallback,
  DingtalkCardCallbackResult,
} from './interactive-card-types.js';

type PermissionCardState = 'reserved' | 'pending' | 'claimed' | 'terminal';
type PermissionCardTerminalState =
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired';

interface PermissionCardRecord {
  context: ChannelPermissionRequestContext;
  target: { chatId: string; isGroup: boolean };
  outTrackId: string;
  state: PermissionCardState;
  delivered: boolean;
  forbiddenActors: Set<string>;
  terminalState?: PermissionCardTerminalState;
  finishTerminalProjection?: (operation: () => Promise<void>) => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
}

export interface PermissionCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  timeoutMs: number;
  locale?: 'en' | 'zh';
  reserveRunProjection?(
    runId: string,
  ): ((operation: () => Promise<void>) => Promise<void>) | undefined;
  onError?(operation: string, error: unknown): void;
}

const DECISION_FIELD = 'permission_decision';

const PERMISSION_CARD_COPY = {
  en: {
    title: 'Permission required',
    submit: 'Submit',
    choose: 'Choose how to continue',
    approved: { description: 'Permission approved.', button: 'Approved' },
    denied: { description: 'Permission denied.', button: 'Denied' },
    expired: {
      description: 'This permission request is no longer available.',
      button: 'Expired',
    },
    cancelled: {
      description: 'Permission request cancelled.',
      button: 'Cancelled',
    },
  },
  zh: {
    title: '需要授权',
    submit: '提交',
    choose: '请选择后续操作',
    approved: { description: '已授权。', button: '已授权' },
    denied: { description: '已拒绝授权。', button: '已拒绝' },
    expired: { description: '此授权请求已失效。', button: '已失效' },
    cancelled: { description: '授权请求已取消。', button: '已取消' },
  },
} as const;

export class PermissionCardController {
  private readonly byRequest = new Map<string, PermissionCardRecord>();
  private readonly byOutTrack = new Map<string, PermissionCardRecord>();
  private readonly pendingByRun = new Map<string, Set<string>>();

  constructor(private readonly options: PermissionCardControllerOptions) {}

  async present(
    context: ChannelPermissionRequestContext,
    target: { chatId: string; isGroup: boolean },
  ): Promise<UserInputPresentationResult> {
    const previous = this.byRequest.get(context.requestId);
    if (previous) {
      this.reserveTerminalProjection(previous);
      await this.finalize(previous, 'expired');
    }
    const record: PermissionCardRecord = {
      context,
      target,
      outTrackId: `qwen-permission-${randomUUID()}`,
      state: 'reserved',
      delivered: false,
      forbiddenActors: new Set(),
    };
    this.byRequest.set(context.requestId, record);
    this.byOutTrack.set(record.outTrackId, record);
    const unsubscribe = context.onSettled((reason) => {
      if (record.state === 'claimed') return;
      if (record.state === 'pending') this.reserveTerminalProjection(record);
      void this.finalize(
        record,
        reason === 'resolved_outside_presenter' ? 'expired' : 'cancelled',
      );
    });
    record.unsubscribe = unsubscribe;
    if (record.state === 'terminal') unsubscribe();

    try {
      await this.options.client.createAndDeliver({
        templateId: QUESTION_CARD_TEMPLATE_ID,
        outTrackId: record.outTrackId,
        target,
        cardParamMap: this.cardData(context),
      });
      record.delivered = true;
    } catch (error) {
      this.options.onError?.('permission card creation', error);
      if (record.state === 'terminal') return { kind: 'presented' };
      this.discard(record);
      return { kind: 'unsupported' };
    }

    if (record.state !== 'reserved') {
      await this.projectTerminal(record);
      return { kind: 'presented' };
    }
    record.state = 'pending';
    const pending = this.pendingByRun.get(context.runId) ?? new Set<string>();
    pending.add(context.requestId);
    this.pendingByRun.set(context.runId, pending);
    record.timer = setTimeout(() => {
      void this.expire(record);
    }, this.options.timeoutMs);
    record.timer.unref?.();
    return { kind: 'presented' };
  }

  claim(callback: DingtalkCardCallback): DingtalkCardCallbackResult {
    const record = this.byOutTrack.get(callback.outTrackId);
    if (!record || record.state !== 'pending') {
      return { kind: 'ignored', actorId: callback.actorId };
    }
    if (record.context.owner.id !== callback.actorId) {
      if (record.forbiddenActors.has(callback.actorId)) {
        return { kind: 'ignored' };
      }
      record.forbiddenActors.add(callback.actorId);
      return {
        kind: 'forbidden',
        actorId: callback.actorId,
        target: record.target,
      };
    }
    if (
      callback.hasBusinessPayload === false ||
      (!callback.isCancel &&
        callback.actionId !== 'cancel' &&
        callback.actionId !== 'submit' &&
        callback.actionId !== record.context.requestId)
    ) {
      return { kind: 'ignored', actorId: callback.actorId };
    }
    if (callback.isCancel || callback.actionId === 'cancel') {
      this.reserveTerminalProjection(record);
      record.state = 'claimed';
      return {
        kind: 'accepted',
        execute: () => this.respond(record, 'deny', 'cancelled'),
      };
    }
    const decision = this.parseDecision(record, callback.formData);
    if (!decision) return { kind: 'ignored', actorId: callback.actorId };
    this.reserveTerminalProjection(record);
    record.state = 'claimed';
    return {
      kind: 'accepted',
      execute: () => this.respond(record, decision),
    };
  }

  cancelRun(runId: string): void {
    const requestIds = [...(this.pendingByRun.get(runId) ?? [])];
    for (const requestId of requestIds) {
      const record = this.byRequest.get(requestId);
      if (record) {
        this.reserveTerminalProjection(record);
        void this.finalize(record, 'cancelled');
      }
    }
  }

  private async respond(
    record: PermissionCardRecord,
    decision: ChannelPermissionDecision,
    terminalState?: PermissionCardTerminalState,
  ): Promise<void> {
    try {
      const accepted = await record.context.respond(decision);
      await this.finalize(
        record,
        accepted
          ? (terminalState ?? (decision === 'deny' ? 'denied' : 'approved'))
          : 'expired',
      );
    } catch (error) {
      this.options.onError?.('permission response', error);
      await this.finalize(record, 'expired');
    }
  }

  private async expire(record: PermissionCardRecord): Promise<void> {
    if (record.state !== 'pending') return;
    this.reserveTerminalProjection(record);
    record.state = 'claimed';
    const response = record.context.respond('deny');
    await this.finalize(record, 'expired');
    try {
      await response;
    } catch (error) {
      this.options.onError?.('expired permission cancellation', error);
    }
  }

  private async finalize(
    record: PermissionCardRecord,
    terminalState: PermissionCardTerminalState,
  ): Promise<void> {
    if (record.state === 'terminal') return;
    record.state = 'terminal';
    record.terminalState = terminalState;
    this.removeRecord(record);
    if (!record.delivered) return;
    const finishTerminalProjection = record.finishTerminalProjection;
    record.finishTerminalProjection = undefined;
    if (finishTerminalProjection) {
      await finishTerminalProjection(() => this.projectTerminal(record));
    } else {
      await this.projectTerminal(record);
    }
  }

  private discard(record: PermissionCardRecord): void {
    if (record.state === 'terminal') return;
    record.state = 'terminal';
    this.removeRecord(record);
  }

  private removeRecord(record: PermissionCardRecord): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    this.byRequest.delete(record.context.requestId);
    this.byOutTrack.delete(record.outTrackId);
    const pending = this.pendingByRun.get(record.context.runId);
    pending?.delete(record.context.requestId);
    if (pending?.size === 0) this.pendingByRun.delete(record.context.runId);
  }

  private reserveTerminalProjection(record: PermissionCardRecord): void {
    record.finishTerminalProjection ??= this.options.reserveRunProjection?.(
      record.context.runId,
    );
  }

  private async projectTerminal(record: PermissionCardRecord): Promise<void> {
    if (!record.terminalState) return;
    const copy = PERMISSION_CARD_COPY[this.options.locale ?? 'en'];
    const cardParamMap: Record<
      PermissionCardTerminalState,
      Record<string, string>
    > = {
      approved: {
        card_status: 'approved',
        question_desc: copy.approved.description,
        form_btn_text: copy.approved.button,
      },
      denied: {
        card_status: 'denied',
        question_desc: copy.denied.description,
        form_btn_text: copy.denied.button,
      },
      expired: {
        card_status: 'expired',
        question_desc: copy.expired.description,
        form_btn_text: copy.expired.button,
      },
      cancelled: {
        card_status: 'cancelled',
        question_desc: copy.cancelled.description,
        form_btn_text: copy.cancelled.button,
      },
    };
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: cardParamMap[record.terminalState],
      });
    } catch (error) {
      this.options.onError?.('permission card finalization', error);
    }
  }

  private parseDecision(
    record: PermissionCardRecord,
    formData: Record<string, unknown>,
  ): ChannelPermissionDecision | undefined {
    if (
      Object.keys(formData).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(formData, DECISION_FIELD)
    ) {
      return undefined;
    }
    const values = this.readValues(formData[DECISION_FIELD]);
    if (values.length !== 1) return undefined;
    const decision = values[0] as ChannelPermissionDecision;
    return record.context.decisions.some(
      (candidate) => candidate.kind === decision,
    )
      ? decision
      : undefined;
  }

  private readValues(value: unknown): string[] {
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (value !== null && typeof value === 'object') {
      return this.readValues((value as Record<string, unknown>)['value']);
    }
    return [];
  }

  private cardData(
    context: ChannelPermissionRequestContext,
  ): Record<string, unknown> {
    const copy = PERMISSION_CARD_COPY[this.options.locale ?? 'en'];
    return {
      question_id: context.requestId,
      question_title: copy.title,
      question_desc: context.title,
      card_status: 'pending',
      form_btn_text: copy.submit,
      selected_text: '',
      selected_values: '[]',
      form: {
        fields: [
          {
            name: DECISION_FIELD,
            label: copy.choose,
            type: 'CHECKBOX_GROUP',
            required: true,
            options: context.decisions.map((decision) => ({
              value: decision.kind,
              text: decision.label,
            })),
          },
        ],
      },
    };
  }
}
