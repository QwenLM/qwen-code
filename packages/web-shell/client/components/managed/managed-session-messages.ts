import type { ACPToolCall, Message } from '../../adapters/types';
import type { ManagedAgentSessionEvent } from './managed-agent-provider';

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
    if (event.turnId !== currentTurnId) {
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
      event.type === 'tool_completed'
    ) {
      settle();
      const callId = data['toolCallId'];
      if (typeof callId !== 'string') continue;
      const key = `${event.turnId}:${callId}`;
      let tool = tools.get(key);
      if (!tool) {
        tool = {
          callId: key,
          toolName:
            typeof data['toolName'] === 'string' ? data['toolName'] : callId,
          status: 'pending',
        };
        tools.set(key, tool);
        messages.push({
          id,
          role: 'tool_group',
          tools: [tool],
          timestamp: event.at,
        });
      }
      if (data['input'] !== undefined) {
        const input =
          typeof data['input'] === 'string' && data['truncated'] === true
            ? `${data['input']}\n${truncatedLabel}`
            : data['input'];
        tool.args = record(input);
        if (Object.keys(tool.args).length === 0) tool.args = { input };
      }
      if (event.type === 'tool_started') {
        tool.status = 'in_progress';
        tool.startTime = event.at;
      }
      if (event.type === 'tool_completed') {
        tool.status = data['failed'] === true ? 'failed' : 'completed';
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
