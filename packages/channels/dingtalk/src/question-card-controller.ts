import { randomUUID } from 'node:crypto';
import type {
  ChannelUserInputRequestContext,
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

type QuestionState = 'reserved' | 'pending' | 'claimed' | 'terminal';
type QuestionTerminalState =
  | 'submitted'
  | 'cancelled'
  | 'expired'
  | 'resolved_outside_presenter';

const OTHER_OPTION_VALUE = '__qwen_other__';

interface QuestionRecord {
  context: ChannelUserInputRequestContext;
  target: { chatId: string; isGroup: boolean };
  outTrackId: string;
  scopeKey: string;
  sequence: number;
  state: QuestionState;
  delivered: boolean;
  forbiddenActors: Set<string>;
  terminalState?: QuestionTerminalState;
  terminalDescription?: string;
  finishTerminalProjection?: (operation: () => Promise<void>) => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
}

export interface QuestionCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  timeoutMs: number;
  sendFallback(chatId: string, text: string): Promise<void>;
  reserveRunProjection?(
    runId: string,
  ): ((operation: () => Promise<void>) => Promise<void>) | undefined;
  onError?(operation: string, error: unknown): void;
}

export class QuestionCardController {
  private readonly byRequest = new Map<string, QuestionRecord>();
  private readonly byOutTrack = new Map<string, QuestionRecord>();
  private readonly activeByScope = new Map<string, QuestionRecord>();
  private readonly pendingByRun = new Map<string, Set<string>>();
  private nextSequence = 0;

  constructor(private readonly options: QuestionCardControllerOptions) {}

  async present(
    context: ChannelUserInputRequestContext,
    target: { chatId: string; isGroup: boolean },
  ): Promise<UserInputPresentationResult> {
    const scopeKey = this.scopeKey(context);
    const active = this.activeByScope.get(scopeKey);
    if (active?.state === 'reserved' || active?.state === 'pending') {
      if (active.context.runId === context.runId) {
        return { kind: 'unsupported' };
      }
      if (active.state === 'pending') this.reserveTerminalProjection(active);
      void this.finalize(
        active,
        'expired',
        'A newer question is available. Answer the latest card.',
      );
    }
    const record: QuestionRecord = {
      context,
      target,
      outTrackId: `qwen-question-${randomUUID()}`,
      scopeKey,
      sequence: this.nextSequence++,
      state: 'reserved',
      delivered: false,
      forbiddenActors: new Set(),
    };
    this.byRequest.set(context.requestId, record);
    this.byOutTrack.set(record.outTrackId, record);
    this.activeByScope.set(record.scopeKey, record);
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
      this.options.onError?.('question card creation', error);
      if (record.state === 'terminal') {
        return { kind: 'presented' };
      }
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
    const latest = this.activeByScope.get(record.scopeKey);
    if (latest && latest.sequence > record.sequence) {
      await this.finalize(
        record,
        'expired',
        'A newer question is available. Answer the latest card.',
      );
      return { kind: 'presented' };
    }
    record.state = 'pending';
    this.activeByScope.set(record.scopeKey, record);
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
        execute: () => this.respond(record, 'cancelled'),
      };
    }
    if (
      callback.actionId !== 'submit' &&
      callback.actionId !== record.context.requestId
    ) {
      return { kind: 'ignored', actorId: callback.actorId };
    }
    const answers = this.parseAnswers(record, callback.formData);
    if (!answers) return { kind: 'ignored', actorId: callback.actorId };
    this.reserveTerminalProjection(record);
    record.state = 'claimed';
    return {
      kind: 'accepted',
      execute: () => this.respond(record, 'submitted', answers),
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
            ? 'This question is no longer available.'
            : undefined,
        );
      }
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
      await this.finalize(
        record,
        accepted ? terminalState : 'expired',
        accepted ? undefined : 'This question is no longer available.',
      );
    } catch (error) {
      this.options.onError?.('question response', error);
      await this.finalize(
        record,
        'expired',
        'This question is no longer available.',
      );
    }
  }

  private async expire(record: QuestionRecord): Promise<void> {
    if (record.state !== 'pending') return;
    this.reserveTerminalProjection(record);
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
    if (this.activeByScope.get(record.scopeKey) === record) {
      this.activeByScope.delete(record.scopeKey);
    }
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

  private reserveTerminalProjection(record: QuestionRecord): void {
    record.finishTerminalProjection ??= this.options.reserveRunProjection?.(
      record.context.runId,
    );
  }

  private async projectTerminal(record: QuestionRecord): Promise<void> {
    if (!record.terminalState) return;
    const cardParamMap: Record<
      QuestionTerminalState,
      Record<string, string>
    > = {
      submitted: {
        card_status: 'submitted',
        question_desc: 'Submitted.',
        form_btn_text: 'Submitted',
      },
      expired: {
        card_status: 'expired',
        question_desc: 'This question expired. Please retry.',
        form_btn_text: 'Expired',
      },
      resolved_outside_presenter: {
        card_status: 'expired',
        question_desc: 'Resolved outside this card.',
        form_btn_text: 'Expired',
      },
      cancelled: {
        card_status: 'cancelled',
        question_desc: 'Cancelled.',
        form_btn_text: 'Cancelled',
      },
    };
    try {
      await this.options.client.updateInstance({
        outTrackId: record.outTrackId,
        cardParamMap: {
          ...cardParamMap[record.terminalState],
          ...(record.terminalDescription
            ? { question_desc: record.terminalDescription }
            : {}),
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
      record.context.questions.flatMap((question) => [
        question.answerKey,
        this.otherAnswerKey(question.answerKey),
      ]),
    );
    if (Object.keys(formData).some((key) => !allowed.has(key))) {
      return undefined;
    }
    const answers: Record<string, string> = {};
    for (const question of record.context.questions) {
      const values = this.readAnswerValues(formData[question.answerKey]);
      if (values.length === 0 || (!question.multiSelect && values.length !== 1))
        return undefined;
      const optionLabels = new Set(
        question.options.map((option) => option.label),
      );
      const customValue = this.readAnswerValues(
        formData[this.otherAnswerKey(question.answerKey)],
      )[0]?.trim();
      const normalized: string[] = [];
      for (const value of values) {
        if (value === OTHER_OPTION_VALUE) {
          if (!customValue) return undefined;
          normalized.push(customValue);
        } else if (optionLabels.has(value)) {
          normalized.push(value);
        } else {
          return undefined;
        }
      }
      answers[question.answerKey] = normalized.join(', ');
    }
    return answers;
  }

  private readAnswerValues(value: unknown): string[] {
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (value !== null && typeof value === 'object') {
      return this.readAnswerValues((value as Record<string, unknown>)['value']);
    }
    return [];
  }

  private otherAnswerKey(answerKey: string): string {
    return `${answerKey}_other`;
  }

  private scopeKey(context: ChannelUserInputRequestContext): string {
    return `${context.sessionId}\0${context.owner.id}`;
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
        fields: context.questions.flatMap((question) => [
          {
            name: question.answerKey,
            label: question.question,
            type: question.multiSelect
              ? 'MULTI_CHECKBOX_GROUP'
              : 'CHECKBOX_GROUP',
            required: true,
            options: [
              ...question.options.map((option) => ({
                value: option.label,
                text: option.label,
              })),
              { value: OTHER_OPTION_VALUE, text: 'Other' },
            ],
          },
          {
            name: this.otherAnswerKey(question.answerKey),
            label: `${question.header}: Other`,
            type: 'TEXT',
            required: false,
            placeholder: 'Enter a custom answer when Other is selected',
          },
        ]),
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
}
