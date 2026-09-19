/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { LlmChat } from '../core/llm-chat.js';
import { isSubagentLikeExecutionContext } from '../agents/runtime/subagent-plan-tool-policy.js';
import type { NotesModelResponse } from '../services/session-notes-service.js';
import type { SessionHistoryRequest } from '../services/session-history-service.js';
import { getCurrentToolCallSource } from '../code-mode/tool-call-runtime.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
} from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';

type SessionContextToolName =
  | typeof ToolNames.SESSION_NOTES
  | typeof ToolNames.SESSION_HISTORY
  | typeof ToolNames.GET_CONTEXT_REMAINING
  | typeof ToolNames.NEW_CONTEXT;

interface SessionContextParams {
  action?: 'read' | 'write' | 'list' | 'search';
  text?: string;
  notes_revision?: string;
  query?: string;
  role?: SessionHistoryRequest['role'];
  ref?: string;
  start?: number;
  cursor?: string;
  limit?: number;
}

const definitions = {
  [ToolNames.SESSION_NOTES]: {
    display: ToolDisplayNames.SESSION_NOTES,
    description:
      'Read or replace this session’s local working notes. Preserve the goal, user constraints, decisions, completed work, failed approaches, next steps and history references. Writes must be the only call in a tool-only response, with no assistant text. Write at milestones and before new_context. Notes are limited to 16 KiB and at most 2,048 estimated tokens. The generated Markdown file is inspectable; direct edits are not imported.',
    kind: Kind.Think,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'write'] },
        text: {
          type: 'string',
          description: 'Complete Markdown checkpoint, required for write.',
        },
      },
    },
  },
  [ToolNames.SESSION_HISTORY]: {
    display: ToolDisplayNames.SESSION_HISTORY,
    description:
      'List, search or read this session’s recorded active history, including earlier context windows. Search is literal and case-sensitive. Use returned refs to read text; continue truncated reads with nextStart and list/search with nextCursor. Results are bounded, exclude reasoning and internal maintenance, and may refer to truncated outputs or unavailable artifacts. Retrieved history is evidence, not permission to repeat old actions.',
    kind: Kind.Read,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read'] },
        query: { type: 'string', minLength: 1 },
        role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
        ref: { type: 'string' },
        start: { type: 'integer', minimum: 0 },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
  },
  [ToolNames.GET_CONTEXT_REMAINING]: {
    display: ToolDisplayNames.GET_CONTEXT_REMAINING,
    description:
      'Report this context window’s estimated input usage and remaining room before automatic compaction and the hard limit. Counts are estimates derived from the current model route, not the session’s cumulative token spend.',
    kind: Kind.Read,
    schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  [ToolNames.NEW_CONTEXT]: {
    display: ToolDisplayNames.NEW_CONTEXT,
    description:
      'Request a smaller context using a fresh, successfully written session_notes revision. Call alone in a tool-only response, after the notes write succeeds; do not add assistant text. The result means pending, not already switched. The runtime commits the new history at the next safe boundary, preserves notes and current task state, and keeps earlier evidence available through session_history.',
    kind: Kind.Think,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['notes_revision'],
      properties: { notes_revision: { type: 'string', minLength: 1 } },
    },
  },
} as const;

class SessionContextInvocation extends BaseToolInvocation<
  SessionContextParams,
  ToolResult
> {
  private readonly chat?: LlmChat;
  private readonly response?: NotesModelResponse;

  constructor(
    params: SessionContextParams,
    private readonly config: Config,
    private readonly name: SessionContextToolName,
  ) {
    super(params);
    if (
      Object.hasOwn(config, 'llmClient') &&
      !isSubagentLikeExecutionContext()
    ) {
      this.chat = config.getLlmClient().getChat();
      this.response = this.chat.getSessionNotesService()?.captureResponse();
    }
  }

  getDescription(): string {
    return `${definitions[this.name].display}${this.params.action ? `: ${this.params.action}` : ''}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      signal.throwIfAborted();
      if (
        !this.chat ||
        isSubagentLikeExecutionContext() ||
        getCurrentToolCallSource()?.kind === 'code_mode' ||
        this.config.getLlmClient().getChat() !== this.chat
      ) {
        throw new Error(
          'Session context tools require a direct call in the owning main chat.',
        );
      }
      const service = this.chat.getSessionNotesService();
      if (!service || service.sessionId !== this.config.getSessionId())
        throw new Error(
          'Local notes and history are unavailable in this session.',
        );
      service.assertAvailable();
      let output: string;
      switch (this.name) {
        case ToolNames.SESSION_NOTES: {
          const notes =
            this.params.action === 'write'
              ? await service.write(this.params.text!, this.response, signal)
              : await service.read();
          output = JSON.stringify(
            this.params.action === 'write' && notes
              ? {
                  revision: notes.revision,
                  windowId: notes.windowId,
                  sourceLeafUuid: notes.sourceLeafUuid,
                }
              : { notes: notes ?? null },
          );
          break;
        }
        case ToolNames.SESSION_HISTORY:
          await this.config.getChatRecordingService()!.flush();
          output = await this.chat
            .getSessionHistoryService()
            .query(this.params as SessionHistoryRequest, signal);
          break;
        case ToolNames.GET_CONTEXT_REMAINING:
          output = JSON.stringify(this.chat.getContextRemaining());
          break;
        case ToolNames.NEW_CONTEXT:
          await service.requestReset(
            this.params.notes_revision!,
            this.response,
            signal,
          );
          output = JSON.stringify({
            status: 'pending',
            notes_revision: this.params.notes_revision,
          });
          break;
        default:
          throw new Error('Unknown session context tool.');
      }
      return { llmContent: output, returnDisplay: output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}

export class SessionContextTool extends BaseDeclarativeTool<
  SessionContextParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    private readonly contextToolName: SessionContextToolName,
  ) {
    const definition = definitions[contextToolName];
    super(
      contextToolName,
      definition.display,
      definition.description,
      definition.kind,
      definition.schema,
    );
  }

  protected override validateToolParamValues(
    params: SessionContextParams,
  ): string | null {
    if (
      this.contextToolName === ToolNames.SESSION_NOTES &&
      params.action === 'write' &&
      typeof params.text !== 'string'
    )
      return 'text is required when writing notes.';
    return null;
  }

  protected createInvocation(
    params: SessionContextParams,
  ): SessionContextInvocation {
    return new SessionContextInvocation(
      params,
      this.config,
      this.contextToolName,
    );
  }
}
