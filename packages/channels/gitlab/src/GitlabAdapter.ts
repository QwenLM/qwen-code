import process from 'node:process';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import { PollingChannelBase } from '@qwen-code/channel-base';
import { Gitlab } from '@gitbeaker/rest';
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

interface Todo {
  id: number;
  action_name: string;
  target_type: string;
  body: string;
  target_url: string;
  updated_at: string;
  project: { path_with_namespace: string };
  author: { username: string };
  target: { iid: number; title: string };
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

  protected async pollOnce(): Promise<void> {
    const templates = (this.config as GitlabConfig).action_prompt_template;
    if (!templates || Object.keys(templates).length === 0) return;

    this.descriptionCache.clear();
    const lastId = this.cursor.lastProcessedId;

    const allTodos = (await this.api.TodoLists.all({
      state: 'pending',
    })) as unknown as Todo[];

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
        !todo.target ||
        !todo.target.iid ||
        (todo.target_type !== 'Issue' && todo.target_type !== 'MergeRequest')
      ) {
        await this.skipTodo(todo);
        continue;
      }

      const template = this.resolveTemplate(templates, todo.action_name);
      if (!template) {
        await this.skipTodo(todo);
        continue;
      }

      const chatId = todo.project.path_with_namespace;
      const targetType = todo.target_type === 'MergeRequest' ? 'mr' : 'issue';
      const threadId = `${targetType}:${todo.target.iid}`;

      try {
        await this.processTodo(todo, template, chatId, targetType, threadId);
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] error processing todo ${todo.id}: ${err}\n`,
        );
        try {
          await this.createNote(
            chatId,
            targetType,
            todo.target.iid,
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

  private async skipTodo(todo: Todo): Promise<void> {
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
    todo: Todo,
    template: string,
    chatId: string,
    targetType: string,
    threadId: string,
  ): Promise<void> {
    if (todo.author.username === this.botUsername) return;

    const isNoteMention = /#note_\d+$/.test(todo.target_url);
    const needsDescription =
      !isNoteMention || template.includes('%description%');

    let description = '';
    if (needsDescription) {
      if (isNoteMention) {
        try {
          description = await this.fetchDescription(
            chatId,
            targetType,
            todo.target.iid,
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
          todo.target.iid,
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
      String(todo.id),
      this.buildMetadata(
        template,
        todo,
        chatId,
        todo.author.username,
        String(todo.id),
        description,
      ),
      true,
    );

    await this.handleInbound(envelope);
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
      description = (mr as { description?: string }).description || '';
    } else {
      const issue = await this.api.Issues.show(iid, { projectId: chatId });
      description = (issue as { description?: string }).description || '';
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
    todo: Todo,
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
      iid: String(todo.target.iid),
      title: todo.target.title,
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
