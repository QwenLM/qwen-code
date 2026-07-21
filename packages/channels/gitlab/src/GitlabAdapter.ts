import { Gitlab } from '@gitbeaker/rest';
import type { TodoSchema } from '@gitbeaker/rest';
import {
  ChannelBase,
  parseChatId,
  loadPollCursor,
  savePollCursor,
  stripBotMention,
  abortableSleep,
} from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

const MENTION_ACTIONS = new Set(['mentioned', 'directly_addressed']);

interface ParsedThreadId {
  type: 'issue' | 'mr';
  iid: number;
}

function parseThreadId(threadId: string): ParsedThreadId | null {
  const match = threadId.match(/^(issue|mr):(\d+)$/);
  if (!match) return null;
  return { type: match[1] as 'issue' | 'mr', iid: Number(match[2]) };
}

export class GitlabChannel extends ChannelBase {
  private gitlab: InstanceType<typeof Gitlab>;
  private abortController: AbortController | null = null;
  private pollGeneration = 0;
  private lastProcessedAt: string;
  private processedIdsAtCursor: Set<string> = new Set();
  private readonly pollIntervalMs: number;
  private botUsername: string | null = null;

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    const cursor = loadPollCursor(name);
    this.lastProcessedAt = cursor.timestamp;
    this.processedIdsAtCursor = cursor.processedIds;
    this.gitlab = new Gitlab({
      host: (config['baseUrl'] as string) || 'https://gitlab.com',
      token: this.config.token,
    });
    this.pollIntervalMs =
      typeof config['pollInterval'] === 'number'
        ? config['pollInterval']
        : DEFAULT_POLL_INTERVAL_MS;
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  override supportsProactiveTarget(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    try {
      const user = await this.gitlab.Users.showCurrentUser();
      this.botUsername = user.username ?? null;
    } catch {
      // bot username unavailable — stripBotMention will be skipped
    }
    const gen = ++this.pollGeneration;
    this.runPollLoop(signal, gen).catch((err) => {
      if (!signal.aborted && gen === this.pollGeneration) {
        process.stderr.write(
          `[GitLab:${this.name}] poll loop error: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    });
  }

  override sendMessage(_chatId: string, _text: string): Promise<void> {
    throw new Error(
      `GitLab channel does not support sendMessage. Use sendThreadMessage instead.`,
    );
  }

  override async sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
  ): Promise<void> {
    const chat = parseChatId(chatId);
    if (!chat) {
      process.stderr.write(
        `[GitLab:${this.name}] unrecognized chatId: ${chatId}\n`,
      );
      return;
    }
    if (!threadId) {
      const title = text.split('\n')[0]!.trim().slice(0, 250) || 'New issue';
      const result = await this.gitlab.Issues.create(chatId, title, {
        description: text,
      });
      process.stderr.write(
        `[GitLab:${this.name}] created issue #${(result as Record<string, unknown>)['iid']} in ${chatId}\n`,
      );
      return;
    }
    const thread = parseThreadId(threadId);
    if (!thread) {
      process.stderr.write(
        `[GitLab:${this.name}] unrecognized threadId: ${threadId}\n`,
      );
      return;
    }
    if (thread.type === 'issue') {
      await this.gitlab.IssueNotes.create(chatId, thread.iid, text);
    } else {
      await this.gitlab.MergeRequestNotes.create(chatId, thread.iid, text);
    }
  }

  disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async runPollLoop(signal: AbortSignal, gen: number): Promise<void> {
    let consecutiveErrors = 0;
    while (!signal.aborted && gen === this.pollGeneration) {
      try {
        await this.pollTodos();
        consecutiveErrors = 0;
      } catch (err) {
        if (signal.aborted) break;
        consecutiveErrors++;
        process.stderr.write(
          `[GitLab:${this.name}] poll error (${consecutiveErrors}): ${err instanceof Error ? err.message : err}\n`,
        );
        if (consecutiveErrors >= 3) {
          await abortableSleep(30_000, signal);
        } else {
          await abortableSleep(2_000, signal);
        }
        continue;
      }
      await abortableSleep(this.pollIntervalMs, signal);
    }
  }

  private async pollTodos(): Promise<void> {
    const todos: TodoSchema[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      let apiSince: string | undefined;
      if (this.lastProcessedAt) {
        const parsed = new Date(this.lastProcessedAt).getTime();
        if (Number.isNaN(parsed)) {
          this.lastProcessedAt = '';
        } else {
          apiSince = new Date(parsed - 1000).toISOString();
        }
      }
      const response = await this.gitlab.TodoLists.all({
        perPage,
        page,
        ...(apiSince ? { updated_after: apiSince } : {}),
      });
      const batch = response as TodoSchema[];
      todos.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    todos.sort((a, b) =>
      (a.updated_at ?? '').localeCompare(b.updated_at ?? ''),
    );
    for (const todo of todos) {
      const updatedAt = todo.updated_at ?? '';
      const tid = String(todo.id);
      if (!updatedAt) continue;
      if (updatedAt < this.lastProcessedAt) continue;
      if (
        updatedAt === this.lastProcessedAt &&
        this.processedIdsAtCursor.has(tid)
      )
        continue;
      let envelope: Envelope | null = null;
      try {
        envelope = this.buildEnvelope(todo);
      } catch (err) {
        process.stderr.write(
          `[GitLab:${this.name}] error building envelope for todo ${todo.id}: ${err instanceof Error ? err.message : err}\n`,
        );
      }
      if (envelope) {
        try {
          await this.handleInbound(envelope);
        } catch (err) {
          process.stderr.write(
            `[GitLab:${this.name}] error processing todo ${todo.id}: ${err instanceof Error ? err.message : err}\n`,
          );
          try {
            await this.sendThreadMessage(
              envelope.chatId,
              envelope.threadId,
              'Sorry, something went wrong processing your message.',
            );
          } catch {
            // best effort
          }
        }
      }
      this.advanceCursor(updatedAt, tid);
      try {
        await this.gitlab.TodoLists.done({ todoId: todo.id });
      } catch (err) {
        process.stderr.write(
          `[GitLab:${this.name}] failed to dismiss todo ${todo.id}: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
  }

  private advanceCursor(timestamp: string, id: string): void {
    if (!timestamp) return;
    if (timestamp > this.lastProcessedAt) {
      this.lastProcessedAt = timestamp;
      this.processedIdsAtCursor = new Set([id]);
    } else {
      this.processedIdsAtCursor.add(id);
    }
    savePollCursor(this.name, this.lastProcessedAt, this.processedIdsAtCursor);
  }

  private buildEnvelope(todo: TodoSchema): Envelope | null {
    if (todo.target_type !== 'Issue' && todo.target_type !== 'MergeRequest') {
      process.stderr.write(
        `[GitLab:${this.name}] unsupported target_type: ${todo.target_type}, skipping todo ${todo.id}\n`,
      );
      return null;
    }
    const projectPath = todo.project?.path_with_namespace;
    if (!projectPath) {
      process.stderr.write(
        `[GitLab:${this.name}] todo ${todo.id} has no project (deleted?), dismissing\n`,
      );
      return null;
    }
    const author = todo.author ?? { username: 'unknown', name: 'Unknown' };
    const target = (todo.target ?? {}) as Record<string, unknown>;
    const targetTitle = (target['title'] as string) ?? '';
    const targetIid = target['iid'] as number | undefined;
    const typePrefix = todo.target_type === 'MergeRequest' ? 'mr' : 'issue';
    const sourceBranch =
      todo.target_type === 'MergeRequest'
        ? ((target['source_branch'] as string) ?? undefined)
        : undefined;

    const metadata = [
      `Type: ${todo.target_type}`,
      `Title: ${targetTitle}`,
      `Reason: ${todo.action_name}`,
      `URL: ${todo.target_url}`,
      ...(sourceBranch ? [`Branch: ${sourceBranch}`] : []),
    ].join('\n');
    const content =
      todo.body && this.botUsername
        ? stripBotMention(todo.body, this.botUsername)
        : (todo.body ?? '');
    return {
      channelName: this.name,
      senderId: author.username,
      senderName: author.name,
      chatId: projectPath,
      threadId:
        targetIid !== undefined ? `${typePrefix}:${targetIid}` : undefined,
      text: content,
      metadata,
      isGroup: true,
      isMentioned: MENTION_ACTIONS.has(todo.action_name),
      isReplyToBot: false,
    };
  }
}
