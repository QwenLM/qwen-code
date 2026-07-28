import process from 'node:process';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import { PollingChannelBase } from '@qwen-code/channel-base';
import { Gitlab } from '@gitbeaker/rest';
import { testBotMention, stripBotMention } from './mention.js';

interface GitlabConfig extends ChannelConfig {
  baseUrl?: string;
  action_prompt_template?: Record<string, string>;
}

interface RepoCursor {
  last_read: string;
}

interface GitlabCursor {
  lastProcessedAt: string;
  repo: Record<string, RepoCursor>;
}

interface Todo {
  id: number;
  action_name: string;
  target_type: string;
  updated_at: string;
  project: { path_with_namespace: string };
  author: { username: string };
  target: { iid: number; title: string };
}

interface Note {
  id: number;
  body: string;
  system: boolean;
  confidential: boolean;
  created_at: string;
  author: { username: string };
}

export class GitlabChannel extends PollingChannelBase<GitlabCursor> {
  private api!: InstanceType<typeof Gitlab>;
  private apiHost = 'https://gitlab.com';
  private botUsername = '';

  constructor(
    name: string,
    config: GitlabConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
  }

  protected createInitialCursor(): GitlabCursor {
    return { lastProcessedAt: new Date().toISOString(), repo: {} };
  }

  protected override validateCursor(parsed: unknown): GitlabCursor | null {
    const base = super.validateCursor(parsed);
    if (!base || typeof base.lastProcessedAt !== 'string') return null;
    if (Number.isNaN(new Date(base.lastProcessedAt).getTime())) return null;
    if (
      base.repo === undefined ||
      base.repo === null ||
      typeof base.repo !== 'object' ||
      Array.isArray(base.repo)
    ) {
      base.repo = {};
    }
    return base;
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
      return super.sendThreadMessage(chatId, threadId, text);
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

    const windowSince = this.cursor.lastProcessedAt;

    const allTodos = (await this.api.TodoLists.all({
      state: 'pending',
    })) as unknown as Todo[];

    const todos = allTodos
      .filter((t) => t.updated_at > windowSince)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));

    for (const todo of todos) {
      if (
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

      try {
        const chatId = todo.project.path_with_namespace;
        const targetType = todo.target_type === 'MergeRequest' ? 'mr' : 'issue';
        const threadId = `${targetType}:${todo.target.iid}`;

        await this.processTodo(
          todo,
          template,
          chatId,
          targetType,
          threadId,
          this.cursor.repo[chatId]?.last_read ?? windowSince,
        );

        await this.api.TodoLists.done({ todoId: todo.id });

        const prev = this.cursor.repo[chatId]?.last_read;
        if (!prev || todo.updated_at > prev) {
          this.cursor.repo[chatId] = { last_read: todo.updated_at };
        }
        this.cursor.lastProcessedAt = todo.updated_at;
        this.saveCursor();
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] error processing todo ${todo.id}, stopping: ${err}\n`,
        );
        break;
      }
    }
  }

  private async skipTodo(todo: Todo): Promise<void> {
    try {
      await this.api.TodoLists.done({ todoId: todo.id });
    } catch {
      // best-effort cleanup
    }
    this.cursor.lastProcessedAt = todo.updated_at;
    this.saveCursor();
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
    repoSince: string,
  ): Promise<void> {
    const notes = await this.fetchRecentNotes(
      chatId,
      targetType,
      todo.target.iid,
      repoSince,
      todo.updated_at,
    );

    for (const note of notes) {
      const envelope = this.buildEnvelope(
        note.body || '',
        note.author.username,
        chatId,
        threadId,
        String(note.id),
        this.buildMetadata(
          template,
          todo,
          chatId,
          note.author.username,
          String(note.id),
        ),
      );

      try {
        await this.handleInbound(envelope);
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] handleInbound failed for note ${note.id}: ${err}\n`,
        );
        throw err;
      }
    }

    if (notes.length === 0) {
      await this.tryFirstContact(todo, template, chatId, targetType, threadId);
    }
  }

  private async fetchRecentNotes(
    chatId: string,
    targetType: string,
    iid: number,
    since: string,
    until: string,
  ): Promise<Note[]> {
    const page = (targetType === 'mr'
      ? await this.api.MergeRequestNotes.all(chatId, iid, {
          sort: 'desc',
          orderBy: 'created_at',
          maxPages: 1,
          perPage: 100,
        })
      : await this.api.IssueNotes.all(chatId, iid, {
          sort: 'desc',
          orderBy: 'created_at',
          maxPages: 1,
          perPage: 100,
        })) as unknown as Note[];

    return page
      .filter(
        (n) =>
          !n.system &&
          !n.confidential &&
          n.author.username !== this.botUsername &&
          n.created_at > since &&
          n.created_at <= until,
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private async tryFirstContact(
    todo: Todo,
    template: string,
    chatId: string,
    targetType: string,
    threadId: string,
  ): Promise<void> {
    if (todo.author.username === this.botUsername) return;

    let description: string;
    try {
      const api = this.api as unknown as {
        Issues: {
          show: (
            p: string,
            o: { issueIId: number },
          ) => Promise<{ description?: string }>;
        };
        MergeRequests: {
          show: (
            p: string,
            o: { mergeRequestIId: number },
          ) => Promise<{ description?: string }>;
        };
      };
      if (targetType === 'mr') {
        const mr = await api.MergeRequests.show(chatId, {
          mergeRequestIId: todo.target.iid,
        });
        description = mr.description || '';
      } else {
        const issue = await api.Issues.show(chatId, {
          issueIId: todo.target.iid,
        });
        description = issue.description || '';
      }
    } catch {
      description = '';
    }

    const text = description || todo.target.title;
    if (!text) return;

    const envelope = this.buildEnvelope(
      text,
      todo.author.username,
      chatId,
      threadId,
      `todo-body-${todo.id}`,
      this.buildMetadata(
        template,
        todo,
        chatId,
        todo.author.username,
        String(todo.id),
      ),
    );

    try {
      await this.handleInbound(envelope);
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] handleInbound failed for first contact ${todo.id}: ${err}\n`,
      );
    }
  }

  private buildEnvelope(
    rawBody: string,
    authorUsername: string,
    chatId: string,
    threadId: string,
    messageId: string,
    metadata: string,
  ): Envelope {
    const isMentioned = testBotMention(rawBody, this.botUsername);
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
  ): string {
    return template.replace(/%(\w+)%/g, (match, key: string) => {
      const vars: Record<string, string> = {
        repo: chatId,
        repo_url: `${this.apiHost}/${chatId}`,
        author,
        thread_type: todo.target_type,
        thread_id: String(todo.target.iid),
        thread_title: todo.target.title,
        comment_id: commentId,
      };
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
