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

// Only these Turn-bearing types may settle a Turn boundary. Control-plane
// re-broadcasts (runtime_*, stream_gap, cancelling) must never settle: a
// stale-Turn runtime_failed landing mid-stream would otherwise split one
// answer into two bubbles, the first frozen mid-stream.
const BOUNDARY_SETTLE_TYPES = new Set([
  'accepted',
  'assistant_delta',
  'assistant_thought',
  'agent_started',
  'tool_requested',
  'tool_started',
  'tool_completed',
  'tool_result_updated',
  'completed',
  'failed',
  'cancelled',
]);

export function managedEventsToMessages(
  events: readonly ManagedAgentSessionEvent[],
  truncatedLabel: string,
): Message[] {
  const messages: Message[] = [];
  const tools = new Map<string, ACPToolCall>();
  // Tools the non-fatal runtime_failed diagnostic failed, keyed to their
  // Turn, so a later same-Turn cancellation can re-mark them: their status
  // has already flipped to failed by then, which the terminal-event loop
  // alone skips. An authoritative result or completion retires the booking.
  const runtimeFailed = new Map<ACPToolCall, string>();
  let textMessage:
    | Extract<Message, { role: 'assistant' | 'thinking' }>
    | undefined;
  let currentTurnId: string | undefined;
  const stopStreaming = () => {
    for (const message of messages) {
      if (message.role === 'assistant' || message.role === 'thinking') {
        message.isStreaming = false;
      }
    }
  };
  const settle = () => {
    stopStreaming();
    textMessage = undefined;
  };
  for (const event of events) {
    // Approval updates carry no Turn and render outside the transcript, so
    // they must not settle or split the Turn being streamed.
    if (event.type === 'action_updated') continue;
    if (
      BOUNDARY_SETTLE_TYPES.has(event.type) &&
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
      if (textMessage) {
        textMessage.content += text;
        // A runtime_failed only stopped the spinner: a Turn that keeps
        // streaming after it must show as live again.
        textMessage.isStreaming = true;
      }
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
        // An authoritative result stays authoritative: it supersedes the
        // diagnostic floor, and the booking retires so a later terminal
        // event can neither move the end nor re-mark the tool.
        if (runtimeFailed.has(tool)) tool.endTime = event.at;
        else tool.endTime ??= event.at;
        runtimeFailed.delete(tool);
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
        // A resumed tool outgrows the diagnostic's floor: the end is open
        // again, while the booking survives so the Turn's terminal event
        // can still re-stamp it.
        if (runtimeFailed.has(tool)) tool.endTime = undefined;
      }
      if (event.type === 'tool_completed') {
        tool.status = data['failed'] === true ? 'failed' : 'completed';
        tool.wasCancelled = data['cancelled'] === true;
        tool.endTime = event.at;
        runtimeFailed.delete(tool);
        if (typeof data['output'] === 'string') {
          tool.rawOutput =
            data['output'] +
            (data['truncated'] === true ? `\n${truncatedLabel}` : '');
        }
      }
    } else if (
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'cancelled' ||
      // A runtime failure belongs to exactly one Turn: only for the Turn
      // being streamed does it settle — otherwise the tail and pending
      // tools render forever, while a stale-Turn failure must not disturb
      // the live one.
      (event.type === 'runtime_failed' && event.turnId === currentTurnId)
    ) {
      // environment.failed is a non-fatal diagnostic and the Turn keeps
      // streaming: dropping the continuation handle would split one answer
      // into two bubbles, so only stop the spinner (and fail pending tools).
      if (event.type === 'runtime_failed') stopStreaming();
      else settle();
      for (const tool of tools.values()) {
        if (
          event.type !== 'runtime_failed' &&
          runtimeFailed.get(tool) === event.turnId
        ) {
          if (event.type === 'cancelled' && tool.status === 'failed')
            tool.wasCancelled = true;
          // The Turn's terminal event ends a diagnostic-failed tool; a
          // result-supplied end cannot occur here because the result and
          // completion paths retire the booking when they land.
          tool.endTime = event.at;
        }
        if (tool.status === 'pending' || tool.status === 'in_progress') {
          tool.status = 'failed';
          // The diagnostic's Turn may still run the tool to completion:
          // the diagnostic only floors the end, which a result, a
          // completion or the Turn's terminal event otherwise moves.
          if (event.type === 'runtime_failed') {
            runtimeFailed.set(tool, event.turnId);
            tool.endTime = event.at;
          } else {
            tool.wasCancelled = event.type === 'cancelled';
            tool.endTime = event.at;
          }
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
