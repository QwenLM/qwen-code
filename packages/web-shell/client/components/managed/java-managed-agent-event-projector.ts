import type {
  JavaAgentDate,
  JavaAgentEvent,
  JavaAgentItem,
} from './java-managed-agent-client';
import type {
  ManagedAgentSessionEvent,
  ManagedAgentSessionEventType,
} from './managed-agent-provider';

export function projectJavaAgentEvent(
  event: JavaAgentEvent,
): ManagedAgentSessionEvent | undefined {
  const type = eventType(event.type, event.data);
  if (!type) return undefined;
  return {
    id: event.sequence,
    at: toTimestamp(event.createdAt),
    type,
    sessionId: event.sessionId,
    turnId: event.turnId,
    data: normalizeData(type, event.data),
  };
}

export function projectJavaAgentItem(
  item: JavaAgentItem,
): ManagedAgentSessionEvent[] {
  if (item.type === 'message' && item.role === 'user') {
    return [
      projectedItemEvent(item, item.firstSequence, 'accepted', {
        itemId: item.itemId,
        prompt: item.content
          .filter((part) => part.type === 'input_text')
          .map((part) => ({ type: 'text', text: part.text })),
      }),
    ];
  }
  if (item.type === 'message' && item.role === 'assistant') {
    return item.content
      .filter(
        (part) => part.type === 'output_text' || part.type === 'reasoning',
      )
      .map((part) =>
        projectedItemEvent(
          item,
          part.firstSequence,
          part.type === 'reasoning' ? 'assistant_thought' : 'assistant_delta',
          { itemId: item.itemId, text: part.text },
        ),
      );
  }
  if (item.type === 'tool_call') {
    const failed = ['failed', 'cancelled'].includes(item.status.toLowerCase());
    const settled = ['completed', 'failed', 'cancelled'].includes(
      item.status.toLowerCase(),
    );
    return [
      projectedItemEvent(
        item,
        item.firstSequence,
        settled ? 'tool_completed' : 'tool_started',
        {
          ...item.attributes,
          itemId: item.itemId,
          toolCallId:
            item.attributes['toolCallId'] ?? item.attributes['callId'],
          toolName:
            item.attributes['toolName'] ??
            item.attributes['name'] ??
            item.attributes['title'],
          failed,
        },
      ),
    ];
  }
  return [];
}

function projectedItemEvent(
  item: JavaAgentItem,
  id: number,
  type: ManagedAgentSessionEventType,
  data: Record<string, unknown>,
): ManagedAgentSessionEvent {
  return {
    id,
    at: toTimestamp(item.createdAt),
    type,
    sessionId: item.sessionId,
    turnId: item.turnId,
    data,
  };
}

function eventType(
  type: string,
  data: Record<string, unknown> | undefined,
): ManagedAgentSessionEventType | undefined {
  switch (type) {
    case 'turn.accepted':
      return 'accepted';
    case 'environment.provisioning':
      return 'runtime_starting';
    case 'environment.ready':
      return 'runtime_ready';
    case 'environment.failed':
      return 'runtime_failed';
    case 'turn.started':
      return 'agent_started';
    case 'item.output_text.delta':
      return 'assistant_delta';
    case 'item.reasoning.delta':
      return 'assistant_thought';
    case 'item.tool_call.updated':
      return toolEventType(data?.['status']);
    case 'turn.completed':
      return 'completed';
    case 'turn.failed':
      return 'failed';
    case 'turn.cancel.requested':
      return 'cancelling';
    case 'turn.cancelled':
      return 'cancelled';
    case 'stream.reconciled':
      return 'stream_gap';
    default:
      return undefined;
  }
}

function toolEventType(value: unknown): ManagedAgentSessionEventType {
  const status = typeof value === 'string' ? value.toLowerCase() : '';
  if (['completed', 'failed', 'cancelled', 'success'].includes(status)) {
    return 'tool_completed';
  }
  if (['pending', 'requested', 'queued'].includes(status)) {
    return 'tool_requested';
  }
  return 'tool_started';
}

function normalizeData(
  type: ManagedAgentSessionEventType,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value = data ?? {};
  if (['tool_requested', 'tool_started', 'tool_completed'].includes(type)) {
    return {
      ...value,
      toolCallId: value['toolCallId'] ?? value['callId'],
      toolName: value['toolName'] ?? value['name'] ?? value['title'],
      failed:
        value['failed'] === true ||
        ['failed', 'cancelled'].includes(String(value['status']).toLowerCase()),
    };
  }
  if (type !== 'accepted') return value;
  const input = Array.isArray(value['input']) ? value['input'] : [];
  return { ...value, prompt: input };
}

export function toTimestamp(value: JavaAgentDate | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}
