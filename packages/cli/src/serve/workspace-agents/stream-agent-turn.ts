import type { AcpSessionBridge } from '../acp-session-bridge.js';

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
  ) => void,
): Promise<void> {
  let text = '';
  let thought = '';
  for await (const event of bridge.subscribeEvents(sessionId, { signal })) {
    if (event.promptId !== promptId || event.type !== 'session_update')
      continue;
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
      report('responding', '正在回复', text);
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content?.type === 'text') thought += update.content.text ?? '';
      report('thinking', 'Qwen Code 正在思考', undefined, thought);
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      report('tool', update.title ?? '正在执行工具');
    }
  }
}
