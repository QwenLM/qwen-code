import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { AgentPermissionPrompt } from './agent-events.js';

/**
 * Follows one agent turn on its session and reports what the agent is doing.
 *
 * `stage` is a code the client localizes (`thinking`, `responding`, `tool`,
 * `awaiting_approval`); `detail` is raw text such as a tool title, never UI
 * copy. `permission` is set while a tool call waits for a person and cleared
 * (`null`) once it is answered.
 */
export async function streamAgentTurn(
  bridge: Pick<AcpSessionBridge, 'subscribeEvents'>,
  sessionId: string,
  promptId: string,
  signal: AbortSignal,
  report: (
    stage: string,
    detail: string,
    outputText?: string,
    thoughtText?: string,
    permission?: AgentPermissionPrompt | null,
  ) => void,
): Promise<void> {
  let text = '';
  let thought = '';
  let pendingRequestId: string | undefined;
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
      report('awaiting_approval', title, undefined, undefined, {
        requestId: data.requestId,
        title,
        options: data.options ?? [],
      });
      continue;
    }
    if (event.type === 'permission_resolved') {
      // Only the request on screen clears it; an older one resolving late
      // must not hide the approval still waiting.
      const requestId = (event.data as { requestId?: string }).requestId;
      if (requestId !== pendingRequestId) continue;
      pendingRequestId = undefined;
      report('tool', '', undefined, undefined, null);
      continue;
    }
    if (event.type !== 'session_update') continue;
    const data = event.data as {
      update?: {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
        title?: string;
      };
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      title?: string;
    };
    const update = data.update ?? data;
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content?.type === 'text'
    ) {
      text += update.content.text ?? '';
      report('responding', '', text);
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content?.type === 'text') thought += update.content.text ?? '';
      report('thinking', '', undefined, thought);
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      report('tool', update.title ?? '');
    }
  }
}
