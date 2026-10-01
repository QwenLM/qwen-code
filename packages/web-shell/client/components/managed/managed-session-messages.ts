import type { ACPToolCall, Message } from '../../adapters/types';
import type { ManagedAgentSessionEvent } from './managed-agent-provider';
import type { ManagedToolResult } from './managed-tool-result-types';

export function mergeManagedEvents(
  current: readonly ManagedAgentSessionEvent[],
  incoming: readonly ManagedAgentSessionEvent[],
): ManagedAgentSessionEvent[] {
  return [
    ...new Map(
      [...current, ...incoming].map((event) => [event.id, event]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function managedEventsToMessages(
  events: readonly ManagedAgentSessionEvent[],
  truncatedLabel: string,
): Message[] {
  const messages: Message[] = [];
  const tools = new Map<string, ACPToolCall>();
  let textMessage:
    | Extract<Message, { role: 'assistant' | 'thinking' }>
    | undefined;
  let currentTurnId: string | undefined;
  const settle = () => {
    for (const message of messages) {
      if (message.role === 'assistant' || message.role === 'thinking') {
        message.isStreaming = false;
      }
    }
    textMessage = undefined;
  };
  for (const event of events) {
    // Approval updates carry no Turn and render outside the transcript, so
    // they must not settle or split the Turn being streamed.
    if (event.type === 'action_updated') continue;
    if (
      event.type !== 'tool_result_updated' &&
      event.turnId !== currentTurnId
    ) {
      settle();
      currentTurnId = event.turnId;
    }
    const data = record(event.data);
    const id = `managed:${event.sessionId}:${event.turnId}:${event.id}`;
    if (event.type === 'accepted') {
      const prompt = Array.isArray(data['prompt']) ? data['prompt'] : [];
      const images = prompt.flatMap((value: unknown) => {
        const block = record(value);
        return block['type'] === 'image' &&
          typeof block['data'] === 'string' &&
          typeof block['mimeType'] === 'string'
          ? [{ data: block['data'], mimeType: block['mimeType'] }]
          : [];
      });
      messages.push({
        id,
        role: 'user',
        content: prompt
          .map((block: unknown) => record(block)['text'])
          .filter((text): text is string => typeof text === 'string')
          .join('\n'),
        timestamp: event.at,
        ...(images.length ? { images } : {}),
      });
      settle();
    } else if (
      event.type === 'assistant_delta' ||
      event.type === 'assistant_thought'
    ) {
      const role = event.type === 'assistant_delta' ? 'assistant' : 'thinking';
      const text = typeof data['text'] === 'string' ? data['text'] : '';
      if (!textMessage || textMessage.role !== role) {
        if (textMessage) textMessage.isStreaming = false;
        const message: Extract<Message, { role: 'assistant' | 'thinking' }> = {
          id,
          role,
          content: '',
          isStreaming: true,
          timestamp: event.at,
        };
        messages.push(message);
        textMessage = message;
      }
      if (textMessage) textMessage.content += text;
    } else if (event.type === 'agent_started') {
      settle();
    } else if (
      event.type === 'tool_requested' ||
      event.type === 'tool_started' ||
      event.type === 'tool_completed' ||
      event.type === 'tool_result_updated'
    ) {
      if (event.type !== 'tool_result_updated') settle();
      const callId = data['toolCallId'];
      const itemId = data['itemId'];
      const identity = typeof itemId === 'string' ? itemId : callId;
      if (typeof identity !== 'string') continue;
      const key = `${event.turnId}:${identity}`;
      const legacyKey =
        typeof callId === 'string' ? `${event.turnId}:${callId}` : undefined;
      let tool =
        tools.get(key) ?? (legacyKey ? tools.get(legacyKey) : undefined);
      const result = readResult(data['result'], event);
      if (!tool) {
        if (event.turnId === currentTurnId) settle();
        tool = {
          callId: key,
          toolName:
            typeof data['toolName'] === 'string'
              ? data['toolName']
              : result
                ? 'run_shell_command'
                : identity,
          status: 'pending',
        };
        const message: Message = {
          id,
          role: 'tool_group',
          tools: [tool],
          timestamp: event.at,
        };
        let previous = -1;
        if (event.type === 'tool_result_updated') {
          for (let index = messages.length - 1; index >= 0; index--) {
            if (
              messages[index].id.startsWith(
                `managed:${event.sessionId}:${event.turnId}:`,
              )
            ) {
              previous = index;
              break;
            }
          }
        }
        if (previous >= 0) messages.splice(previous + 1, 0, message);
        else messages.push(message);
      }
      tools.set(key, tool);
      if (legacyKey) tools.set(legacyKey, tool);
      if (typeof itemId === 'string') tool.callId = key;
      if (typeof callId === 'string') tool.toolCallId = callId;
      if (typeof data['toolName'] === 'string')
        tool.toolName = data['toolName'];
      // The Harness titles each call itself; the approval card shows it as
      // the description, so keep it instead of dropping it on the floor.
      if (typeof data['title'] === 'string') tool.title = data['title'];
      if (data['input'] !== undefined) {
        const input =
          typeof data['input'] === 'string' && data['truncated'] === true
            ? `${data['input']}\n${truncatedLabel}`
            : data['input'];
        tool.args = record(input);
        if (Object.keys(tool.args).length === 0) tool.args = { input };
      }
      if (result) {
        if (
          tool.toolResult &&
          result.projection_revision <= tool.toolResult.projection_revision
        )
          continue;
        tool.toolResult = result;
        tool.status =
          result.execution_status === 'success' ? 'completed' : 'failed';
        tool.wasCancelled = result.execution_status === 'cancelled';
        if (
          typeof result.preview?.text === 'string' &&
          tool.rawOutput === undefined
        ) {
          tool.rawOutput =
            result.preview.text +
            (result.preview.truncated === true ? `\n${truncatedLabel}` : '');
        }
        tool.endTime ??= event.at;
      }
      if (tool.toolResult) {
        if (
          event.type === 'tool_completed' &&
          typeof data['output'] === 'string'
        ) {
          const output =
            data['output'] +
            (data['truncated'] === true ? `\n${truncatedLabel}` : '');
          if (
            data['truncated'] !== true ||
            typeof tool.rawOutput !== 'string' ||
            output.length > tool.rawOutput.length
          ) {
            tool.rawOutput = output;
          }
        }
        continue;
      }
      if (event.type === 'tool_started') {
        tool.status = 'in_progress';
        tool.startTime = event.at;
      }
      if (event.type === 'tool_completed') {
        tool.status = data['failed'] === true ? 'failed' : 'completed';
        tool.wasCancelled = data['cancelled'] === true;
        tool.endTime = event.at;
        if (typeof data['output'] === 'string') {
          tool.rawOutput =
            data['output'] +
            (data['truncated'] === true ? `\n${truncatedLabel}` : '');
        }
      }
    } else if (
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'cancelled'
    ) {
      settle();
      for (const tool of tools.values()) {
        if (tool.status === 'pending' || tool.status === 'in_progress') {
          tool.status = 'failed';
          tool.wasCancelled = event.type === 'cancelled';
          tool.endTime = event.at;
        }
      }
      if (event.type === 'failed' && typeof data['message'] === 'string') {
        messages.push({
          id,
          role: 'system',
          variant: 'error',
          content: data['message'],
          timestamp: event.at,
        });
      }
    }
  }
  return messages;
}

function readResult(
  value: unknown,
  event: ManagedAgentSessionEvent,
): ManagedToolResult | undefined {
  const result = record(value);
  if (
    typeof result['id'] !== 'string' ||
    result['id'].length === 0 ||
    result['session_id'] !== event.sessionId ||
    result['turn_id'] !== event.turnId ||
    typeof result['item_id'] !== 'string' ||
    result['item_id'].length === 0 ||
    result['item_id'] !== record(event.data)['itemId'] ||
    !Number.isSafeInteger(result['projection_revision']) ||
    Number(result['projection_revision']) < 1 ||
    typeof result['execution_status'] !== 'string' ||
    !['success', 'error', 'cancelled', 'not_started'].includes(
      result['execution_status'],
    ) ||
    typeof result['delivery_status'] !== 'string' ||
    !['pending', 'committed', 'blocked'].includes(result['delivery_status']) ||
    !Array.isArray(result['artifacts'])
  )
    return undefined;
  return value as ManagedToolResult;
}
