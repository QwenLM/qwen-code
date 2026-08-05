import type {
  ChannelUserInputRequestContext,
  UserInputPresentationResult,
} from '@qwen-code/channel-base';
import {
  buildQuestionCard,
  buildQuestionTerminalCard,
  parseQuestionAction,
  parseQuestionAnswers,
} from './question-card.js';

type QuestionState = 'reserved' | 'pending' | 'claimed' | 'terminal';
type TerminalState = 'submitted' | 'cancelled' | 'expired';

interface QuestionRecord {
  context: ChannelUserInputRequestContext;
  requestId: string;
  runId: string;
  ownerId: string;
  chatId: string;
  scopeKey: string;
  state: QuestionState;
  messageId?: string;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  responding?: boolean;
  ignoreResponseProjection?: boolean;
  terminalState?: TerminalState;
  terminalAnswers?: Record<string, string>;
  projection?: Promise<void>;
}

export type FeishuQuestionCallbackResult =
  | { kind: 'unhandled' }
  | {
      kind: 'handled';
      response: Record<string, unknown>;
      execute?: () => Promise<void>;
    };

export interface FeishuQuestionCardControllerOptions {
  timeoutMs: number;
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  patchCard(messageId: string, card: Record<string, unknown>): Promise<boolean>;
  sendFallback(chatId: string, text: string): Promise<void>;
  onError?(operation: string, error: unknown): void;
}

export class FeishuQuestionCardController {
  private readonly byRequest = new Map<string, QuestionRecord>();
  private readonly activeByScope = new Map<string, QuestionRecord>();

  constructor(private readonly options: FeishuQuestionCardControllerOptions) {}

  async present(
    context: ChannelUserInputRequestContext,
  ): Promise<UserInputPresentationResult> {
    const scopeKey = this.scopeKey(context);
    const active = this.activeByScope.get(scopeKey);
    if (active && active.state !== 'terminal') return { kind: 'unsupported' };

    const record: QuestionRecord = {
      context,
      requestId: context.requestId,
      runId: context.runId,
      ownerId: context.owner.id,
      chatId: context.target.chatId,
      scopeKey,
      state: 'reserved',
    };
    this.byRequest.set(context.requestId, record);
    this.activeByScope.set(scopeKey, record);
    const unsubscribe = context.onSettled((reason) => {
      if (record.state !== 'claimed' || !record.responding) {
        void this.finalize(
          record,
          reason === 'resolved_outside_presenter' ? 'expired' : 'cancelled',
        );
      }
    });
    record.unsubscribe = unsubscribe;
    if (record.state === 'terminal') {
      unsubscribe();
      record.unsubscribe = undefined;
    }

    try {
      const messageId = await this.options.sendCard(
        record.chatId,
        buildQuestionCard(context),
      );
      if (!messageId)
        throw new Error('Feishu card delivery returned no message id');
      if (
        record.state !== 'reserved' ||
        this.byRequest.get(record.requestId) !== record ||
        this.activeByScope.get(record.scopeKey) !== record
      ) {
        await this.projectTerminal(record, messageId);
        return { kind: 'presented' };
      }
      record.messageId = messageId;
    } catch (error) {
      if (record.state === 'terminal') return { kind: 'presented' };
      this.options.onError?.('question card delivery', error);
      await this.finalize(record, 'cancelled');
      try {
        await this.options.sendFallback(record.chatId, this.fallbackText());
      } catch (fallbackError) {
        this.options.onError?.('question fallback delivery', fallbackError);
      }
      try {
        await context.respond({ outcome: { outcome: 'cancelled' } });
      } catch (respondError) {
        this.options.onError?.('question delivery cancellation', respondError);
      }
      return { kind: 'handled' };
    }

    record.state = 'pending';
    record.timer = setTimeout(() => {
      void this.expire(record);
    }, this.options.timeoutMs);
    record.timer.unref?.();
    return { kind: 'presented' };
  }

  claim(data: unknown): FeishuQuestionCallbackResult {
    const action = parseQuestionAction(data);
    if (action.kind === 'unhandled') return { kind: 'unhandled' };
    const record = this.byRequest.get(action.requestId);
    if (!record || record.state !== 'pending') return this.expiredResponse();
    if (
      !action.operatorId ||
      !action.chatId ||
      !action.messageId ||
      action.operatorId !== record.ownerId ||
      action.chatId !== record.chatId ||
      action.messageId !== record.messageId
    ) {
      return this.expiredResponse();
    }
    if (action.kind === 'submit') {
      const answers = parseQuestionAnswers(
        record.context.questions,
        action.formValue,
      );
      if (!answers) {
        return {
          kind: 'handled',
          response: {
            toast: { type: 'warning', content: '请完整选择有效答案。' },
          },
        };
      }
      this.markClaimed(record);
      return {
        kind: 'handled',
        response: {
          toast: { type: 'success', content: '答案已提交，正在处理。' },
          card: {
            type: 'raw',
            data: buildQuestionTerminalCard(
              record.context.questions,
              'processing',
              answers,
            ),
          },
        },
        execute: () => this.respond(record, 'submitted', answers),
      };
    }
    this.markClaimed(record);
    return {
      kind: 'handled',
      response: {
        toast: { type: 'info', content: '已取消。' },
        card: {
          type: 'raw',
          data: buildQuestionTerminalCard(
            record.context.questions,
            'cancelled',
          ),
        },
      },
      execute: () => this.respond(record, 'cancelled'),
    };
  }

  cancelRun(runId: string): void {
    for (const record of [...this.byRequest.values()]) {
      if (record.runId === runId) void this.finalize(record, 'cancelled');
    }
  }

  dispose(): void {
    for (const record of [...this.byRequest.values()]) {
      record.ignoreResponseProjection = true;
      void this.finalize(record, 'expired');
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

  private async respond(
    record: QuestionRecord,
    terminalState: 'submitted' | 'cancelled',
    answers?: Record<string, string>,
  ): Promise<void> {
    if (record.state !== 'claimed') return;
    record.responding = true;
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
      record.responding = false;
      if (!accepted) {
        this.options.onError?.(
          'question response',
          new Error('Question response was no longer accepted'),
        );
      } else if (terminalState === 'submitted') {
        record.terminalAnswers = answers;
      }
      await this.completeResponse(record, accepted ? terminalState : 'expired');
    } catch (error) {
      record.responding = false;
      this.options.onError?.('question response', error);
      await this.completeResponse(record, 'expired');
    }
  }

  private async finalize(
    record: QuestionRecord,
    terminalState: TerminalState,
  ): Promise<void> {
    if (record.state === 'terminal') return;
    record.state = 'terminal';
    record.terminalState = terminalState;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    this.byRequest.delete(record.requestId);
    if (this.activeByScope.get(record.scopeKey) === record) {
      this.activeByScope.delete(record.scopeKey);
    }
    await this.projectTerminal(record);
  }

  private async completeResponse(
    record: QuestionRecord,
    terminalState: TerminalState,
  ): Promise<void> {
    if (record.state !== 'terminal') {
      await this.finalize(record, terminalState);
      return;
    }
    if (record.ignoreResponseProjection) return;
    record.terminalState = terminalState;
    await this.projectTerminal(record);
  }

  private projectTerminal(
    record: QuestionRecord,
    messageId = record.messageId,
  ): Promise<void> {
    if (!messageId || !record.terminalState) return Promise.resolve();
    const card = buildQuestionTerminalCard(
      record.context.questions,
      record.terminalState,
      record.terminalAnswers,
    );
    const projection = (record.projection ?? Promise.resolve()).then(
      async () => {
        try {
          const patched = await this.options.patchCard(messageId, card);
          if (!patched) {
            this.options.onError?.(
              'question card finalization',
              new Error('Feishu card patch was not accepted'),
            );
          }
        } catch (error) {
          this.options.onError?.('question card finalization', error);
        }
      },
    );
    record.projection = projection;
    return projection;
  }

  private expiredResponse(): FeishuQuestionCallbackResult {
    return {
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    };
  }

  private markClaimed(record: QuestionRecord): void {
    record.state = 'claimed';
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
  }

  private scopeKey(context: ChannelUserInputRequestContext): string {
    return `${context.sessionId}\0${context.owner.id}`;
  }

  private fallbackText(): string {
    return 'The interactive question could not be delivered, so the request was cancelled. Please retry.';
  }
}
