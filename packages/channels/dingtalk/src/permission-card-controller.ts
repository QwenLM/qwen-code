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
import { escapeDingTalkMarkdown } from './markdown.js';

type PermissionState = 'reserved' | 'pending' | 'claimed' | 'terminal';
type PermissionTerminalState =
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'resolved_outside_presenter';

const DECISION_FIELD = 'permission_decision';

interface PermissionRecord {
  context: ChannelPermissionRequestContext;
  target: { chatId: string; isGroup: boolean };
  outTrackId: string;
  decisionByLabel: Map<string, ChannelPermissionDecision>;
  state: PermissionState;
  delivered: boolean;
  forbiddenActors: Set<string>;
  terminalState?: PermissionTerminalState;
  terminalDescription?: string;
  finishTerminalProjection?: (operation: () => Promise<void>) => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
}

export interface PermissionCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  timeoutMs: number;
  reserveRunProjection?(
    runId: string,
  ): ((operation: () => Promise<void>) => Promise<void>) | undefined;
  onError?(operation: string, error: unknown): void;
}

/**
 * Presents ordinary (non `ask_user_question`) tool permission requests as
 * native DingTalk interactive cards. The card reuses the question form
 * template with a single required decision field whose choices are exactly
 * the decisions the permission request advertised, so the persistent-grant
 * choice appears only when the daemon offered one. Card callbacks settle the
 * original request at most once through the shared one-shot responder, and
 * every terminal path moves the card to a non-interactive state.
 */
export class PermissionCardController {
  private readonly byRequest = new Map<string, PermissionRecord>();
  private readonly byOutTrack = new Map<string, PermissionRecord>();
  private readonly pendingByRun = new Map<string, Set<string>>();

  constructor(private readonly options: PermissionCardControllerOptions) {}

  async present(
    context: ChannelPermissionRequestContext,
    target: { chatId: string; isGroup: boolean },
  ): Promise<UserInputPresentationResult> {
    const record: PermissionRecord = {
      context,
      target,
      outTrackId: `qwen-permission-${randomUUID()}`,
      decisionByLabel: new Map(
        context.decisions.map((decision) => [decision.label, decision.kind]),
      ),
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
        reason === 'resolved_outside_presenter'
          ? 'resolved_outside_presenter'
          : 'cancelled',
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
      // The existing text permission message is a complete fallback, so the
      // request stays pending and ChannelBase sends it after `unsupported`.
      await this.finalize(record, 'cancelled');
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
    if (callback.hasBusinessPayload === false) {
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
    if (
      callback.actionId !== 'submit' &&
      callback.actionId !== record.context.requestId
    ) {
      return { kind: 'ignored', actorId: callback.actorId };
    }
    const decision = this.parseDecision(record, callback.formData);
    if (!decision) return { kind: 'ignored', actorId: callback.actorId };
    this.reserveTerminalProjection(record);
    record.state = 'claimed';
    return {
      kind: 'accepted',
      execute: () =>
        this.respond(
          record,
          decision,
          decision === 'deny' ? 'denied' : 'approved',
        ),
    };
  }

  cancelRun(
    runId: string,
    terminalState: 'cancelled' | 'expired' = 'cancelled',
  ): void {
    const requestIds = [...(this.pendingByRun.get(runId) ?? [])];
    for (const requestId of requestIds) {
      const record = this.byRequest.get(requestId);
      if (record) {
        this.reserveTerminalProjection(record);
        void this.finalize(
          record,
          terminalState,
          terminalState === 'expired'
            ? 'This permission request is no longer available.'
            : undefined,
        );
      }
    }
  }

  private async respond(
    record: PermissionRecord,
    decision: ChannelPermissionDecision,
    acceptedState: 'approved' | 'denied' | 'cancelled',
  ): Promise<void> {
    try {
      const accepted = await record.context.respond(decision);
      await this.finalize(
        record,
        accepted ? acceptedState : 'expired',
        accepted
          ? undefined
          : 'This permission request is no longer available.',
      );
    } catch (error) {
      this.options.onError?.('permission response', error);
      await this.finalize(
        record,
        'expired',
        'This permission request is no longer available.',
      );
    }
  }

  private async expire(record: PermissionRecord): Promise<void> {
    if (record.state !== 'pending') return;
    this.reserveTerminalProjection(record);
    await this.finalize(record, 'expired');
    try {
      await record.context.respond('deny');
    } catch (error) {
      this.options.onError?.('expired permission denial', error);
    }
  }

  private async finalize(
    record: PermissionRecord,
    state: PermissionTerminalState,
    description?: string,
  ): Promise<void> {
    if (record.state === 'terminal') return;
    record.state = 'terminal';
    record.terminalState = state;
    record.terminalDescription = description;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    this.byRequest.delete(record.context.requestId);
    this.byOutTrack.delete(record.outTrackId);
    const pending = this.pendingByRun.get(record.context.runId);
    pending?.delete(record.context.requestId);
    if (pending?.size === 0) this.pendingByRun.delete(record.context.runId);
    if (record.delivered) {
      const finishTerminalProjection = record.finishTerminalProjection;
      record.finishTerminalProjection = undefined;
      if (finishTerminalProjection) {
        await finishTerminalProjection(() => this.projectTerminal(record));
      } else {
        await this.projectTerminal(record);
      }
    }
  }

  private reserveTerminalProjection(record: PermissionRecord): void {
    record.finishTerminalProjection ??= this.options.reserveRunProjection?.(
      record.context.runId,
    );
  }

  private async projectTerminal(record: PermissionRecord): Promise<void> {
    if (!record.terminalState) return;
    const cardParamMap: Record<
      PermissionTerminalState,
      Record<string, string>
    > = {
      approved: {
        card_status: 'approved',
        question_desc: this.withSourceLabel(
          record.context,
          record.terminalDescription ?? 'Approved.',
        ),
        form_btn_text: 'Approved',
      },
      denied: {
        card_status: 'denied',
        question_desc: this.withSourceLabel(
          record.context,
          record.terminalDescription ?? 'Denied.',
        ),
        form_btn_text: 'Denied',
      },
      expired: {
        card_status: 'expired',
        question_desc: this.withSourceLabel(
          record.context,
          record.terminalDescription ??
            'This permission request expired. Please retry.',
        ),
        form_btn_text: 'Expired',
      },
      resolved_outside_presenter: {
        card_status: 'expired',
        question_desc: this.withSourceLabel(
          record.context,
          record.terminalDescription ?? 'Resolved outside this card.',
        ),
        form_btn_text: 'Expired',
      },
      cancelled: {
        card_status: 'cancelled',
        question_desc: this.withSourceLabel(
          record.context,
          record.terminalDescription ?? 'Cancelled.',
        ),
        form_btn_text: 'Cancelled',
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
    record: PermissionRecord,
    formData: Record<string, unknown>,
  ): ChannelPermissionDecision | undefined {
    const keys = Object.keys(formData);
    if (keys.length !== 1 || keys[0] !== DECISION_FIELD) return undefined;
    const values = this.readValues(formData[DECISION_FIELD]);
    if (values.length !== 1) return undefined;
    return record.decisionByLabel.get(values[0]!);
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
    const desc = [
      `Tool: ${context.toolName}`,
      `Action: ${context.title}`,
      ...(context.parameterSummary
        ? [`Parameters: ${context.parameterSummary}`]
        : []),
    ].join('\n');
    return {
      question_id: context.requestId,
      question_title: 'Permission required to run a tool',
      question_desc: this.withSourceLabel(context, desc),
      card_status: 'pending',
      form_btn_text: 'Submit',
      selected_text: '',
      selected_values: '[]',
      form: {
        fields: [
          {
            name: DECISION_FIELD,
            label: 'Decision',
            type: 'CHECKBOX_GROUP',
            required: true,
            options: context.decisions.map((decision) => ({
              value: decision.label,
              text: decision.label,
            })),
          },
        ],
      },
    };
  }

  private withSourceLabel(
    context: ChannelPermissionRequestContext,
    text: string,
  ): string {
    if (!context.sourceLabel) return text;
    const label = escapeDingTalkMarkdown(context.sourceLabel);
    return `${label}\n\n${text}`;
  }
}
