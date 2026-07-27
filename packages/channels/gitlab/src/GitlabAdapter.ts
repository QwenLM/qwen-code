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
  body: string;
  updated_at: string;
  project: { path_with_namespace: string; web_url: string };
  author: { username: string };
  target: { iid: number; title: string };
}

interface Note {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  author: { username: string };
}

export class GitlabChannel extends PollingChannelBase<GitlabCursor> {
  private api!: InstanceType<typeof Gitlab>;
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
    const host = (cfg.baseUrl || 'https://gitlab.com').replace(/\/+$/, '');

    let proxyAgent: unknown;
    if (this.proxy) {
      const { ProxyAgent } = await import('undici');
      proxyAgent = new ProxyAgent(this.proxy);
    }

    this.api = new Gitlab({
      host,
      token: cfg.token,
      ...(proxyAgent ? { proxyAgent } : {}),
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

    let watermark = this.cursor.lastProcessedAt;

    for (const todo of todos) {
      if (
        !todo.target ||
        (todo.target_type !== 'Issue' && todo.target_type !== 'MergeRequest')
      ) {
        watermark = todo.updated_at;
        continue;
      }

      const template = templates[todo.action_name];
      if (!template) {
        watermark = todo.updated_at;
        continue;
      }

      const chatId = todo.project.path_with_namespace;
      const targetType = todo.target_type === 'MergeRequest' ? 'mr' : 'issue';
      const threadId = `${targetType}:${todo.target.iid}`;

      try {
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
        watermark = todo.updated_at;
      } catch (err) {
        process.stderr.write(
          `[Channel:${this.name}] error processing todo ${todo.id}, stopping: ${err}\n`,
        );
        break;
      }
    }

    this.cursor.lastProcessedAt = watermark;
  }

  private async processTodo(
    todo: Todo,
    template: string,
    chatId: string,
    targetType: string,
    threadId: string,
    repoSince: string,
  ): Promise<void> {
    const allNotes = (targetType === 'mr'
      ? await this.api.MergeRequestNotes.all(chatId, todo.target.iid, {
          sort: 'asc',
          orderBy: 'created_at',
        })
      : await this.api.IssueNotes.all(chatId, todo.target.iid, {
          sort: 'asc',
          orderBy: 'created_at',
        })) as unknown as Note[];

    const newNotes = allNotes.filter(
      (n) =>
        !n.system &&
        n.author.username !== this.botUsername &&
        n.created_at > repoSince &&
        n.created_at <= todo.updated_at,
    );

    for (const note of newNotes) {
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
        await this.postErrorComment(chatId, targetType, todo.target.iid);
        throw err;
      }
    }

    if (newNotes.length === 0) {
      const body = todo.body || '';
      if (body && todo.author.username !== this.botUsername) {
        const envelope = this.buildEnvelope(
          body,
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
            `[Channel:${this.name}] handleInbound failed for todo body ${todo.id}: ${err}\n`,
          );
        }
      }
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
        repo_url: todo.project.web_url,
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

  private async postErrorComment(
    chatId: string,
    targetType: string,
    iid: number,
  ): Promise<void> {
    try {
      await this.createNote(
        chatId,
        targetType,
        iid,
        '⚠️ Failed to process this request. Please re-mention the bot to retry.',
      );
    } catch (err) {
      process.stderr.write(
        `[Channel:${this.name}] postErrorComment failed for ${chatId} ${targetType}:${iid}: ${err}\n`,
      );
    }
  }
}
