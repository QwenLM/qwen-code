import type {
  ChannelOutputSegmentContext,
  ChannelOutputSegmentEndReason,
  ChannelUserInputRequestContext,
  SessionTarget,
  UserInputPresentationResult,
} from '@qwen-code/channel-base';
import type { QuestionCardController } from './question-card-controller.js';
import type { StatusCardController } from './status-card-controller.js';

interface RunPresentation {
  runId: string;
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  baseContext: ChannelOutputSegmentContext;
  statusContext?: ChannelOutputSegmentContext;
  projectionChain: Promise<void>;
  activeSegmentId?: string;
  senderPrefix?: string;
  senderRawPrefix?: string;
  terminal: boolean;
}

interface SegmentPresentation {
  run: RunPresentation;
  context: ChannelOutputSegmentContext;
  content: string;
}

export interface DingtalkInteractionPresenterOptions {
  statusCards?: StatusCardController;
  questionCards?: QuestionCardController;
  sendFallback?(chatId: string, text: string, sessionId: string): Promise<void>;
}

export interface DingtalkCardSender {
  senderName: string;
}

const CARD_CONTENT_LIMIT = 20_000;
const TRUNCATION_MARKER = '[Earlier output truncated]\n';

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]{}()#+.!|>~-])/gu, '\\$1');
}

function formatSenderPrefixes(sender: DingtalkCardSender): {
  senderPrefix: string;
  senderRawPrefix: string;
} {
  const senderName =
    sender.senderName.replace(/[\r\n]+/gu, ' ').trim() || '用户';
  return {
    senderPrefix: `@${escapeMarkdownText(senderName)}`,
    senderRawPrefix: `@${senderName}`,
  };
}

export class DingtalkInteractionPresenter {
  private readonly runs = new Map<string, RunPresentation>();
  private readonly segments = new Map<string, SegmentPresentation>();
  private readonly terminalSegmentIds = new Set<string>();

  constructor(private readonly options: DingtalkInteractionPresenterOptions) {}

  registerRun(
    runId: string,
    ownerId: string,
    target: { chatId: string; isGroup: boolean },
    sessionId = '',
    messageId?: string,
    channelName = 'dingtalk',
    sender?: DingtalkCardSender,
  ): void {
    this.runs.set(runId, {
      runId,
      ownerId,
      target,
      baseContext: {
        channelName,
        sessionId,
        runId,
        segmentId: runId,
        owner: { kind: 'channel_user', id: ownerId },
        target: {
          channelName,
          chatId: target.chatId,
          senderId: ownerId,
          isGroup: target.isGroup,
        },
        ...(messageId ? { messageId } : {}),
      },
      projectionChain: Promise.resolve(),
      ...(target.isGroup && sender ? formatSenderPrefixes(sender) : {}),
      terminal: false,
    });
  }

  startStatusCard(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return;
    const statusContext = this.ensureStatusContext(run);
    void this.enqueue(run, () => {
      const statusCards = this.options.statusCards;
      const target = this.cardTarget(statusContext.target);
      statusCards?.ensure(statusContext, target);
    });
  }

  appendOutput(segment: ChannelOutputSegmentContext, chunk: string): void {
    const run = this.runs.get(segment.runId);
    if (
      !run ||
      run.terminal ||
      run.ownerId !== segment.owner.id ||
      run.target.chatId !== segment.target.chatId ||
      run.target.isGroup !== segment.target.isGroup ||
      !chunk ||
      this.terminalSegmentIds.has(segment.segmentId)
    ) {
      return;
    }
    const existing = this.segments.get(segment.segmentId);
    if (existing && existing.run !== run) return;
    const presentation = existing ?? {
      run,
      context: segment,
      content: '',
    };
    presentation.content = this.boundContent(presentation.content + chunk);
    this.segments.set(segment.segmentId, presentation);
    run.activeSegmentId = segment.segmentId;
    const statusContext = this.ensureStatusContext(run, segment);
    void this.enqueue(run, () => {
      this.options.statusCards?.replace(
        statusContext,
        this.cardTarget(statusContext.target),
        presentation.content,
      );
    });
  }

  closeOutput(
    segmentId: string,
    text: string,
    reason: ChannelOutputSegmentEndReason,
    segment?: ChannelOutputSegmentContext,
  ): Promise<boolean> {
    let presentation = this.segments.get(segmentId);
    if (!presentation && segment && text) {
      this.appendOutput(segment, text);
      presentation = this.segments.get(segmentId);
    }
    if (!presentation) return Promise.resolve(false);
    const run = presentation.run;
    if (run.terminal) return Promise.resolve(false);
    this.segments.delete(segmentId);
    this.addTerminalSegment(segmentId);
    if (run.activeSegmentId === segmentId) {
      run.activeSegmentId = undefined;
    }
    if (reason === 'response_boundary') {
      return Promise.resolve(true);
    }
    return this.enqueue(run, async () => {
      const statusCards = this.options.statusCards;
      const statusContext = this.ensureStatusContext(run, presentation.context);
      if (reason === 'failed') {
        statusCards?.ensure(
          statusContext,
          this.cardTarget(statusContext.target),
        );
        statusCards?.fail(
          statusContext.segmentId,
          this.withSenderPrefix(run, '本次处理失败，请稍后重试。'),
        );
        return statusCards !== undefined;
      }
      if (reason === 'cancelled') {
        return statusCards !== undefined;
      }
      if (reason === 'input_requested') {
        const completed =
          statusCards !== undefined &&
          (await statusCards.complete(
            statusContext.segmentId,
            this.withSenderPrefix(run, text || presentation.content),
          ));
        run.statusContext = undefined;
        if (completed) return true;
        const fallbackText = text || presentation.content;
        if (!fallbackText || !this.options.sendFallback) return false;
        await this.options.sendFallback(
          presentation.context.target.chatId,
          fallbackText,
          presentation.context.sessionId,
        );
        return true;
      }
      statusCards?.ensure(statusContext, this.cardTarget(statusContext.target));
      const completed =
        statusCards !== undefined &&
        (await statusCards.complete(
          statusContext.segmentId,
          this.withSenderPrefix(run, text || presentation.content),
        ));
      if (completed) return true;
      const fallbackText = text || presentation.content;
      if (!fallbackText || !this.options.sendFallback) return false;
      await this.options.sendFallback(
        presentation.context.target.chatId,
        fallbackText,
        presentation.context.sessionId,
      );
      return true;
    });
  }

  presentInput(
    context: ChannelUserInputRequestContext,
  ): Promise<UserInputPresentationResult> {
    const run = this.runs.get(context.runId);
    if (
      !run ||
      run.terminal ||
      run.ownerId !== context.owner.id ||
      run.target.chatId !== context.target.chatId ||
      run.target.isGroup !== context.target.isGroup
    ) {
      return Promise.resolve({ kind: 'unsupported' });
    }
    const questionCards = this.options.questionCards;
    if (!questionCards) return Promise.resolve({ kind: 'unsupported' });
    return questionCards.present(context, this.cardTarget(context.target));
  }

  terminalizeRun(
    runId: string,
    terminal: 'completed' | 'failed' | 'cancelled',
    detail = '',
  ): void {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return;
    this.options.questionCards?.cancelRun(
      runId,
      terminal === 'cancelled' &&
        (detail === 'cancel_command' || detail === 'clear')
        ? 'cancelled'
        : 'expired',
    );
    run.terminal = true;
    const activeSegmentId = run.activeSegmentId;
    run.activeSegmentId = undefined;
    if (activeSegmentId) {
      this.segments.delete(activeSegmentId);
      this.addTerminalSegment(activeSegmentId);
    }
    const finalization = this.enqueue(run, async () => {
      if (terminal === 'failed') {
        const statusContext = this.ensureStatusContext(run);
        this.options.statusCards?.ensure(
          statusContext,
          this.cardTarget(statusContext.target),
        );
        this.options.statusCards?.fail(
          statusContext.segmentId,
          this.withSenderPrefix(run, '本次处理失败，请稍后重试。'),
        );
      } else if (terminal === 'cancelled') {
        const statusContext = run.statusContext;
        if (statusContext) {
          this.options.statusCards?.replace(
            statusContext,
            this.cardTarget(statusContext.target),
            this.withSenderPrefix(
              run,
              detail === 'cancel_command' ? '任务已停止' : '任务已取消',
            ),
          );
        }
        this.options.statusCards?.cancelRun(
          runId,
          detail === 'cancel_command' ? 'cancel_command' : 'dropped',
        );
      }
    });
    void finalization.then(
      () => {
        if (this.runs.get(runId) === run) this.runs.delete(runId);
      },
      () => {
        if (this.runs.get(runId) === run) this.runs.delete(runId);
      },
    );
  }

  reserveProjection(
    runId: string,
  ): ((operation: () => Promise<void>) => Promise<void>) | undefined {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return undefined;
    let supplyOperation!: (operation: () => Promise<void>) => void;
    const operation = new Promise<() => Promise<void>>((resolve) => {
      supplyOperation = resolve;
    });
    const result = this.enqueue(run, async () => {
      const execute = await operation;
      await execute();
    });
    let supplied = false;
    return (execute) => {
      if (!supplied) {
        supplied = true;
        supplyOperation(execute);
      }
      return result;
    };
  }

  private enqueue<T>(
    run: RunPresentation,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const result = run.projectionChain.then(operation);
    run.projectionChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private boundContent(content: string, limit = CARD_CONTENT_LIMIT): string {
    if (content.length <= limit) return content;
    if (limit === 0) return '';
    if (limit <= TRUNCATION_MARKER.length) return content.slice(-limit);
    return `${TRUNCATION_MARKER}${content.slice(
      content.length - (limit - TRUNCATION_MARKER.length),
    )}`;
  }

  private withSenderPrefix(run: RunPresentation, content: string): string {
    if (!run.senderPrefix) return this.boundContent(content);
    const body = this.withoutExistingSenderPrefix(run, content);
    if (!body) return run.senderPrefix;
    const separator = '\n\n';
    const bodyLimit = Math.max(
      0,
      CARD_CONTENT_LIMIT - run.senderPrefix.length - separator.length,
    );
    return `${run.senderPrefix}${separator}${this.boundContent(
      body,
      bodyLimit,
    )}`;
  }

  private withoutExistingSenderPrefix(
    run: RunPresentation,
    content: string,
  ): string {
    const prefixes = new Set([run.senderPrefix, run.senderRawPrefix]);
    let body = content;
    while (body) {
      let removed = false;
      for (const prefix of prefixes) {
        if (!prefix) continue;
        if (body === prefix) return '';
        if (!body.startsWith(prefix)) continue;
        const remainder = body.slice(prefix.length);
        if (/^\r?\n/u.test(remainder)) {
          body = remainder.replace(/^(?:\r?\n){1,2}/u, '');
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
    return body;
  }

  private ensureStatusContext(
    run: RunPresentation,
    segment?: ChannelOutputSegmentContext,
  ): ChannelOutputSegmentContext {
    if (run.statusContext) return run.statusContext;
    run.statusContext = segment
      ? { ...segment }
      : { ...run.baseContext, segmentId: run.runId };
    return run.statusContext;
  }

  private cardTarget(target: SessionTarget): {
    chatId: string;
    isGroup: boolean;
  } {
    const isGroup = target.isGroup === true;
    return {
      chatId: isGroup ? target.chatId : target.senderId,
      isGroup,
    };
  }

  private addTerminalSegment(segmentId: string): void {
    this.terminalSegmentIds.add(segmentId);
    while (this.terminalSegmentIds.size > 1000) {
      const oldest = this.terminalSegmentIds.values().next().value;
      if (oldest === undefined) break;
      this.terminalSegmentIds.delete(oldest);
    }
  }
}
