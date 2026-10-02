import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { AgentPermissionPrompt, AgentRunStep } from './agent-events.js';

/** Enough to see where an agent is heading without scrolling a log. */
const MAX_STEPS = 8;

/**
 * One change in what the agent is doing. Fields left out keep their previous
 * value; `permission: null` clears an answered approval.
 */
export interface AgentTurnUpdate {
  /** A code the client localizes: thinking, responding, tool, awaiting_approval. */
  stage: string;
  /** Raw text such as a tool title, never UI copy. */
  detail?: string;
  outputText?: string;
  thoughtText?: string;
  permission?: AgentPermissionPrompt | null;
  /** This turn's latest tool calls, oldest first. */
  steps?: AgentRunStep[];
}

/**
 * Folds one ACP tool call update into a turn's step list and returns the
 * latest steps, oldest first. Shared by every program that speaks ACP.
 */
export function recordToolStep(
  steps: Map<string, AgentRunStep>,
  update: {
    toolCallId?: string;
    title?: string | null;
    status?: string | null;
  },
): AgentRunStep[] {
  if (update.toolCallId) {
    const previous = steps.get(update.toolCallId);
    steps.set(update.toolCallId, {
      id: update.toolCallId,
      title: (update.title || previous?.title || '').slice(0, 200),
      status: stepStatus(update.status ?? undefined, previous?.status),
    });
  }
  return [...steps.values()].slice(-MAX_STEPS);
}

function stepStatus(
  status: string | undefined,
  previous: AgentRunStep['status'] | undefined,
): AgentRunStep['status'] {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'in_progress') return 'running';
  return previous ?? 'running';
}

/** Follows one agent turn on its session and reports what the agent is doing. */
export async function streamAgentTurn(
  bridge: Pick<AcpSessionBridge, 'subscribeEvents'>,
  sessionId: string,
  promptId: string,
  signal: AbortSignal,
  report: (update: AgentTurnUpdate) => void,
): Promise<void> {
  let text = '';
  let thought = '';
  let pendingRequestId: string | undefined;
  const steps = new Map<string, AgentRunStep>();
  for await (const event of bridge.subscribeEvents(sessionId, { signal })) {
    if (event.promptId !== promptId) continue;
    if (event.type === 'permission_request') {
      const data = event.data as {
        requestId?: string;
        toolCall?: { title?: string };
        options?: AgentPermissionPrompt['options'];
      };
      if (!data.requestId) continue;
      const title = data.toolCall?.title ?? '';
      pendingRequestId = data.requestId;
      report({
        stage: 'awaiting_approval',
        detail: title,
        permission: {
          requestId: data.requestId,
          title,
          options: data.options ?? [],
        },
      });
      continue;
    }
    if (event.type === 'permission_resolved') {
      // Only the request on screen clears it; an older one resolving late
      // must not hide the approval still waiting.
      const requestId = (event.data as { requestId?: string }).requestId;
      if (requestId !== pendingRequestId) continue;
      pendingRequestId = undefined;
      report({ stage: 'tool', permission: null });
      continue;
    }
    if (event.type !== 'session_update') continue;
    const data = event.data as {
      update?: {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
        title?: string;
        toolCallId?: string;
        status?: string;
      };
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      title?: string;
      toolCallId?: string;
      status?: string;
    };
    const update = data.update ?? data;
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content?.type === 'text'
    ) {
      text += update.content.text ?? '';
      report({ stage: 'responding', outputText: text });
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content?.type === 'text') thought += update.content.text ?? '';
      report({ stage: 'thinking', thoughtText: thought });
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      report({
        stage: 'tool',
        detail: update.title ?? '',
        steps: recordToolStep(steps, update),
      });
    }
  }
}
