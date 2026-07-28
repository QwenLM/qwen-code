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
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  projectionChain: Promise<void>;
  activeSegmentId?: string;
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

export class DingtalkInteractionPresenter {
  private readonly runs = new Map<string, RunPresentation>();
  private readonly segments = new Map<string, SegmentPresentation>();
  private readonly terminalSegmentIds = new Set<string>();

  constructor(private readonly options: DingtalkInteractionPresenterOptions) {}

  registerRun(
    runId: string,
    ownerId: string,
    target: { chatId: string; isGroup: boolean },
  ): void {
    this.runs.set(runId, {
      ownerId,
      target,
      projectionChain: Promise.resolve(),
      terminal: false,
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
    if (!this.options.statusCards) return;
    void this.enqueue(run, () => {
      this.options.statusCards?.append(
        segment,
        this.cardTarget(segment.target),
        chunk,
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
    return this.enqueue(run, async () => {
      const statusCards = this.options.statusCards;
      if (reason === 'failed') {
        statusCards?.fail(segmentId, text);
        return statusCards !== undefined;
      }
      if (reason === 'cancelled') {
        return statusCards !== undefined;
      }
      const completed =
        statusCards !== undefined &&
        (await statusCards.complete(segmentId, text));
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
      if (terminal === 'failed' && activeSegmentId) {
        this.options.statusCards?.fail(activeSegmentId, detail);
      } else if (terminal === 'cancelled') {
        this.options.statusCards?.cancelRun(
          runId,
          detail === 'cancel_command' ? 'cancel_command' : 'dropped',
        );
      } else if (activeSegmentId) {
        await this.options.statusCards?.complete(activeSegmentId, detail);
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

  private boundContent(content: string): string {
    const limit = 20_000;
    const marker = '[Earlier output truncated]\n';
    if (content.length <= limit) return content;
    return `${marker}${content.slice(content.length - (limit - marker.length))}`;
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
