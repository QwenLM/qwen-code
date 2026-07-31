import process from 'node:process';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import { PollingChannelBase } from '@qwen-code/channel-base';
import { Gitlab, type TodoSchema } from '@gitbeaker/rest';
import { z } from 'zod';
import { testBotMention, stripBotMention } from './mention.js';

interface GitlabConfig extends ChannelConfig {
  baseUrl?: string;
  action_prompt_template?: Record<string, string>;
}

interface GitlabCursor {
  lastProcessedId: number;
  initialized: boolean;
}

interface GitlabTarget {
  iid: number;
  title: string;
  isMr: boolean;
}

const cursorSchema = z.object({
  lastProcessedId: z.number(),
  initialized: z.boolean(),
});

export class GitlabChannel extends PollingChannelBase<GitlabCursor> {
  private api!: InstanceType<typeof Gitlab>;
  private apiHost = 'https://gitlab.com';
  private botUsername = '';
  private descriptionCache = new Map<string, string>();
  private readonly reactions = new Map<
    string,
    {
      target: GitlabTarget;
      noteId: number;
      award?: Promise<{ awardId: number }>;
    }
  >();

  constructor(
    name: string,
    config: GitlabConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
  }

  protected createInitialCursor(): GitlabCursor {
    return { lastProcessedId: 0, initialized: false };
  }

  protected override validateCursor(parsed: unknown): GitlabCursor | null {
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  async connect(): Promise<void> {
    const cfg = this.config as GitlabConfig;
    this.apiHost = (cfg.baseUrl || 'https://gitlab.com').replace(/\/+$/, '');

    if (
      !cfg.action_prompt_template ||
      Object.keys(cfg.action_prompt_template).length === 0
    ) {
      process.stderr.write(
        `[Channel:${this.name}] warning: action_prompt_template is not configured; no todos will be processed\n`,
      );
    }

    if (cfg.groupPolicy !== 'open' && cfg.groupPolicy !== 'allowlist') {
      process.stderr.write(
        `[Channel:${this.name}] warning: groupPolicy is "${cfg.groupPolicy ?? 'disabled'}"; must be "open" (or "allowlist" with the project listed) for todos to be dispatched\n`,
      );
    }

    this.api = new Gitlab({
      host: this.apiHost,
      token: cfg.token,
    });

    const user = await this.api.Users.showCurrentUser();
    this.botUsername = user.username;

    const allowed = (this.config.allowedUsers ?? []).map((u) =>
      u.toLowerCase(),
    );
    this.config.allowedUsers = allowed;
    this.gate.replaceAllowedUsers(allowed);

    this.startPollLoop();
  }

  disconnect(): void {
    this.stopPollLoop();
  }

  async sendMessage(_chatId: string, _text: string): Promise<void> {
    throw new Error(
      `[Channel:${this.name}] sendMessage requires a threadId; use sendThreadMessage`,
    );
  }

  protected override async sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
  ): Promise<void> {
    if (!threadId) {
      throw new Error(
        `[Channel:${this.name}] sendThreadMessage requires a threadId (e.g. "issue:42" or "mr:7")`,
      );
    }
    const match = threadId.match(/^(?:issue|mr):(\d+)$/);
    if (!match) {
      throw new Error(
        `[Channel:${this.name}] invalid threadId format: ${threadId}`,
      );
    }
    const targetType = threadId.startsWith('mr:') ? 'mr' : 'issue';
    await this.createNote(chatId, targetType, Number(match[1]), text);
  }

  protected override onPromptStart(
    chatId: string,
    _sessionId: string,
    messageId?: string,
  ): void {
    if (!messageId) return;
    const entry = this.reactions.get(messageId);
    if (!entry || entry.award) return;
    const api = entry.target.isMr
      ? this.api.MergeRequestNoteAwardEmojis
      : this.api.IssueNoteAwardEmojis;
    entry.award = api
      .award(chatId, entry.target.iid, entry.noteId, 'eyes')
      .then((r) => ({ awardId: r.id }));
    void entry.award.catch((err) => {
      entry.award = undefined;
      process.stderr.write(
        `[Channel:${this.name}] failed to acknowledge note ${entry.noteId}: ${err}\n`,
      );
    });
  }

  protected override onPromptEnd(
    chatId: string,
    _sessionId: string,
    messageId?: string,
  ): void {
    if (!messageId) return;
    const entry = this.reactions.get(messageId);
    if (!entry) return;
    this.reactions.delete(messageId);
    if (!entry.award) return;
    const api = entry.target.isMr
      ? this.api.MergeRequestNoteAwardEmojis
      : this.api.IssueNoteAwardEmojis;
    void entry.award
      .then(({ awardId }) =>
        api.remove(chatId, entry.target.iid, entry.noteId, awardId),
      )
      .catch((err) => {
        process.stderr.write(
          `[Channel:${this.name}] failed to remove acknowledgement from note ${entry.noteId}: ${err}\n`,
        );
      });
  }

  protected async pollOnce(): Promise<void> {
    const templates = (this.config as GitlabConfig).action_prompt_template;
    if (!templates || Object.keys(templates).length === 0) return;

    this.descriptionCache.clear();
    const lastId = this.cursor.lastProcessedId;

    const allTodos = (await this.api.TodoLists.all({
      state: 'pending',
    })) as TodoSchema[];

    // First poll: drain all pre-existing todos without processing them.
    if (!this.cursor.initialized) {
      if (allTodos.length > 0) {
        const maxId = allTodos.reduce((m, t) => (t.id > m ? t.id : m), 0);
        for (const t of allTodos) {
          this.api.TodoLists.done({ todoId: t.id }).catch(() => {});
        }
        this.cursor.lastProcessedId = maxId;
      }
      this.cursor.initialized = true;
      return;
    }

    const todos = allTodos
      .filter((t) => t.id > lastId)
      .sort((a, b) => a.id - b.id);

    for (const t of allTodos) {
      if (t.id <= lastId) {
        this.api.TodoLists.done({ todoId: t.id }).catch(() => {});
      }
    }

    for (const todo of todos) {
      if (
        !todo.project ||
        (todo.target_type !== 'Issue' && todo.target_type !== 'MergeRequest')
      ) {
        await this.skipTodo(todo);
        continue;
      }
      const raw = (todo.target || {}) as { iid?: number; title?: string };
      if (!raw.iid) {
        await this.skipTodo(todo);
        continue;
      }
      const target: GitlabTarget = {
        iid: raw.iid,
        title: raw.title ?? '',
        isMr: todo.target_type === 'MergeRequest',
      };

      const template = this.resolveTemplate(templates, todo.action_name);
      if (!template) {
        await this.skipTodo(todo);
        continue;
      }

      const chatId = todo.project.path_with_namespace;

      try {
        await this.processTodo(todo, target, template, chatId);
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] error processing todo ${todo.id}: ${err}\n`,
        );
        try {
          await this.createNote(
            chatId,
            target.isMr ? 'mr' : 'issue',
            target.iid,
            '⚠️ Failed to process this request. Please re-mention the bot to retry.',
          );
        } catch {
          // best-effort error comment
        }
      }

      this.cursor.lastProcessedId = todo.id;

      try {
        await this.api.TodoLists.done({ todoId: todo.id });
      } catch {
        // best-effort cleanup
      }
    }
  }

  private async skipTodo(todo: TodoSchema): Promise<void> {
    try {
      await this.api.TodoLists.done({ todoId: todo.id });
    } catch {
      // best-effort cleanup
    }
    this.cursor.lastProcessedId = todo.id;
  }

  private resolveTemplate(
    templates: Record<string, string>,
    actionName: string,
  ): string | undefined {
    if (templates[actionName]) return templates[actionName];
    if (actionName === 'directly_addressed') return templates['mentioned'];
    return undefined;
  }

  private async processTodo(
    todo: TodoSchema,
    target: GitlabTarget,
    template: string,
    chatId: string,
  ): Promise<void> {
    if (todo.author.username === this.botUsername) return;

    const targetType = target.isMr ? 'mr' : 'issue';
    const threadId = `${targetType}:${target.iid}`;
    const noteMatch = todo.target_url.match(/#note_(\d+)$/);
    const isNoteMention = noteMatch !== null;
    const messageId = String(todo.id);
    const needsDescription =
      !isNoteMention || template.includes('%description%');

    let description = '';
    if (needsDescription) {
      if (isNoteMention) {
        try {
          description = await this.fetchDescription(
            chatId,
            targetType,
            target.iid,
          );
        } catch (err) {
          process.stderr.write(
            `[Channel:${this.name}] fetchDescription failed (metadata only): ${err}\n`,
          );
        }
      } else {
        description = await this.fetchDescription(
          chatId,
          targetType,
          target.iid,
        );
      }
    }

    const text = isNoteMention
      ? todo.body || ''
      : description || todo.body || '';
    if (!text) return;

    const envelope = this.buildEnvelope(
      text,
      todo.author.username,
      chatId,
      threadId,
      messageId,
      this.buildMetadata(
        template,
        todo,
        target,
        chatId,
        todo.author.username,
        String(todo.id),
        description,
      ),
      true,
    );

    if (isNoteMention) {
      this.reactions.set(messageId, {
        target,
        noteId: Number(noteMatch![1]),
      });
    }
    try {
      await this.handleInbound(envelope);
    } finally {
      this.reactions.delete(messageId);
    }
  }

  private async fetchDescription(
    chatId: string,
    targetType: string,
    iid: number,
  ): Promise<string> {
    const cacheKey = `${chatId}/${targetType}/${iid}`;
    const cached = this.descriptionCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let description: string;
    if (targetType === 'mr') {
      const mr = await this.api.MergeRequests.show(chatId, iid);
      description = mr.description || '';
    } else {
      const issue = await this.api.Issues.show(iid, { projectId: chatId });
      description = issue.description || '';
    }
    this.descriptionCache.set(cacheKey, description);
    return description;
  }

  private buildEnvelope(
    rawBody: string,
    authorUsername: string,
    chatId: string,
    threadId: string,
    messageId: string,
    metadata: string,
    forceMentioned = false,
  ): Envelope {
    const isMentioned =
      forceMentioned || testBotMention(rawBody, this.botUsername);
    return {
      channelName: this.name,
      senderId: authorUsername.toLowerCase(),
      senderName: authorUsername,
      chatId,
      threadId,
      messageId,
      text: stripBotMention(rawBody, this.botUsername),
      isGroup: true,
      isMentioned,
      isReplyToBot: false,
      metadata,
    };
  }

  private buildMetadata(
    template: string,
    todo: TodoSchema,
    target: GitlabTarget,
    chatId: string,
    author: string,
    commentId: string,
    description: string,
  ): string {
    const vars: Record<string, string> = {
      project: chatId,
      project_url: `${this.apiHost}/${chatId}`,
      author,
      target_type: todo.target_type,
      iid: String(target.iid),
      title: target.title,
      description,
      todo_id: commentId,
    };
    return template.replace(/%%|%(\w+)%/g, (match, key: string) => {
      if (match === '%%') return '%';
      return vars[key] ?? match;
    });
  }

  private async createNote(
    chatId: string,
    targetType: string,
    iid: number,
    body: string,
  ): Promise<void> {
    if (targetType === 'mr') {
      await this.api.MergeRequestNotes.create(chatId, iid, body);
    } else {
      await this.api.IssueNotes.create(chatId, iid, body);
    }
  }
}
