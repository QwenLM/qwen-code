import { randomUUID } from 'node:crypto';
import type {
  ChannelUserInputRequestContext,
  UserInputPresentationResult,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';
import {
  QUESTION_CARD_TEMPLATE_ID,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
import type { DingtalkCardCallback } from './interactive-card-types.js';

type QuestionState = 'reserved' | 'pending' | 'responding' | 'terminal';
type QuestionTerminalState =
  | 'submitted'
  | 'cancelled'
  | 'expired'
  | 'resolved_outside_card';

interface QuestionRecord {
  context: ChannelUserInputRequestContext;
  outTrackId: string;
  state: QuestionState;
  delivered: boolean;
  terminalState?: QuestionTerminalState;
  deferredSettlement?: UserInputSettlementReason;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
}

export interface QuestionCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  timeoutMs: number;
  setWaitingInput(runId: string, waiting: boolean): void;
  sendFallback(chatId: string, text: string): Promise<void>;
  onError?(operation: string, error: unknown): void;
}

export class QuestionCardController {
  private readonly byRequest = new Map<string, QuestionRecord>();
  private readonly byOutTrack = new Map<string, QuestionRecord>();
  private readonly pendingByRun = new Map<string, Set<string>>();
  private readonly tombstones = new Map<
    string,
    { reason: QuestionTerminalState; expiresAt: number }
  >();

  constructor(private readonly options: QuestionCardControllerOptions) {}

  async present(
    context: ChannelUserInputRequestContext,
    target: { chatId: string; isGroup: boolean },
  ): Promise<UserInputPresentationResult> {
    const record: QuestionRecord = {
      context,
      outTrackId: `qwen-question-${randomUUID()}`,
      state: 'reserved',
      delivered: false,
    };
    this.byRequest.set(context.requestId, record);
    this.byOutTrack.set(record.outTrackId, record);
    const unsubscribe = context.onSettled((reason) => {
      if (record.state === 'responding') {
        record.deferredSettlement = reason;
        return;
      }
      void this.finalize(
        record,
        reason === 'resolved_outside_card'
          ? 'resolved_outside_card'
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
      this.options.onError?.('question card creation', error);
      await this.finalize(record, 'cancelled');
      try {
        await this.options.sendFallback(
          context.target.chatId,
          this.fallbackText(context),
        );
      } catch (fallbackError) {
        this.options.onError?.('question fallback delivery', fallbackError);
      }
      await context.respond({ outcome: { outcome: 'cancelled' } });
      return { kind: 'handled' };
    }

    if (record.state !== 'reserved') {
      await this.projectTerminal(record);
      return { kind: 'presented' };
    }
    record.state = 'pending';
    const pending = this.pendingByRun.get(context.runId) ?? new Set<string>();
    pending.add(context.requestId);
    this.pendingByRun.set(context.runId, pending);
    this.options.setWaitingInput(context.runId, true);
    record.timer = setTimeout(() => {
      void this.expire(record);
    }, this.options.timeoutMs);
    record.timer.unref?.();
    return { kind: 'presented' };
  }

  claim(callback: DingtalkCardCallback): (() => Promise<void>) | undefined {
    const record = this.byOutTrack.get(callback.outTrackId);
    if (
      !record ||
      record.state !== 'pending' ||
      record.context.owner.id !== callback.ownerId
    ) {
      return undefined;
    }
    if (callback.actionId === 'cancel') {
      record.state = 'responding';
      return () => this.respond(record, 'cancelled');
    }
    if (
      callback.actionId !== 'submit' &&
      callback.actionId !== record.context.requestId
    ) {
      return undefined;
    }
    const answers = this.parseAnswers(record, callback.formData);
    if (!answers) return undefined;
    record.state = 'responding';
    return () => this.respond(record, 'submitted', answers);
  }

  cancelRun(runId: string): void {
    const requestIds = [...(this.pendingByRun.get(runId) ?? [])];
    for (const requestId of requestIds) {
      const record = this.byRequest.get(requestId);
      if (record) void this.finalize(record, 'cancelled');
    }
  }

  private async respond(
    record: QuestionRecord,
    terminalState: 'submitted' | 'cancelled',
    answers?: Record<string, string>,
  ): Promise<void> {
    try {
      const accepted = await record.context.respond(
        terminalState === 'submitted'
          ? {
              outcome: {
                outcome: 'selected',
                optionId: record.context.submitOptionId,
              },
              answers,
            }
          : { outcome: { outcome: 'cancelled' } },
      );
      await this.finalize(record, accepted ? terminalState : 'cancelled');
    } catch (error) {
      this.options.onError?.('question response', error);
      await this.finalize(record, 'cancelled');
    }
  }

  private async expire(record: QuestionRecord): Promise<void> {
    if (record.state !== 'pending') return;
    await this.finalize(record, 'expired');
    try {
      await record.context.respond({ outcome: { outcome: 'cancelled' } });
    } catch (error) {
      this.options.onError?.('expired question cancellation', error);
    }
  }

  private async finalize(
    record: QuestionRecord,
    state: QuestionTerminalState,
  ): Promise<void> {
    if (record.state === 'terminal') return;
    record.state = 'terminal';
    record.terminalState = state;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    this.byRequest.delete(record.context.requestId);
    this.byOutTrack.delete(record.outTrackId);
    const pending = this.pendingByRun.get(record.context.runId);
    pending?.delete(record.context.requestId);
    if (pending?.size === 0) this.pendingByRun.delete(record.context.runId);
    this.options.setWaitingInput(
      record.context.runId,
      (pending?.size ?? 0) > 0,
    );
    this.addTombstone(record.outTrackId, state);
    if (record.delivered) await this.projectTerminal(record);
  }

  private async projectTerminal(record: QuestionRecord): Promise<void> {
    if (!record.terminalState) return;
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          card_status: record.terminalState,
          form_btn_text: '',
        },
      });
    } catch (error) {
      this.options.onError?.('question card finalization', error);
    }
  }

  private parseAnswers(
    record: QuestionRecord,
    formData: Record<string, unknown>,
  ): Record<string, string> | undefined {
    const allowed = new Set(
      record.context.questions.map((question) => question.answerKey),
    );
    if (Object.keys(formData).some((key) => !allowed.has(key))) {
      return undefined;
    }
    const answers: Record<string, string> = {};
    for (const question of record.context.questions) {
      const value = formData[question.answerKey];
      if (typeof value === 'string') {
        if (!value.trim()) return undefined;
        answers[question.answerKey] = value;
      } else if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === 'string' && item.trim())
      ) {
        answers[question.answerKey] = value.join(', ');
      } else {
        return undefined;
      }
    }
    return answers;
  }

  private cardData(
    context: ChannelUserInputRequestContext,
  ): Record<string, unknown> {
    const first = context.questions[0]!;
    return {
      question_id: context.requestId,
      question_title: first.header,
      question_desc: first.question,
      card_status: 'pending',
      form_btn_text: 'Submit',
      selected_text: '',
      selected_values: '[]',
      form: {
        fields: context.questions.map((question) => ({
          name: question.answerKey,
          label: question.question,
          type: question.multiSelect
            ? 'MULTI_CHECKBOX_GROUP'
            : 'CHECKBOX_GROUP',
          required: true,
          options: question.options.map((option) => ({
            value: option.label,
            text: option.label,
          })),
        })),
      },
    };
  }

  private fallbackText(context: ChannelUserInputRequestContext): string {
    const questions = context.questions
      .map(
        (question) =>
          `- ${question.question}: ${question.options
            .map((option) => option.label)
            .join(', ')}`,
      )
      .join('\n');
    return `The interactive question could not be delivered, so this request was cancelled. Please retry.\n${questions}`;
  }

  private addTombstone(
    outTrackId: string,
    reason: QuestionTerminalState,
  ): void {
    const now = Date.now();
    for (const [id, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(id);
    }
    this.tombstones.set(outTrackId, {
      reason,
      expiresAt: now + 10 * 60 * 1000,
    });
    while (this.tombstones.size > 1000) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }
}
