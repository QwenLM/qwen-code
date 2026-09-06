import type { ACPToolCall, Message } from './types.js';
import {
  isBackgroundSubAgentToolCall,
  isSubAgentToolCall,
} from './toolClassification.js';

export type ParallelAgentDisplayItem =
  | {
      type: 'message';
      key: string;
      message: Message;
    }
  | {
      type: 'parallel_agents';
      key: string;
      turnId: string;
      agents: ACPToolCall[];
      /**
       * Wall-clock time of the first grouped launch, carried so the grouped
       * box reveals its time on hover exactly like a standalone message row.
       */
      timestamp?: number;
    };

// Synthetic compact summaries carry a folded thought next to their single
// tool, so this second-stage grouping must leave those rows intact.
export function isAgentOnlyToolGroup(message: Message): boolean {
  return (
    message.role === 'tool_group' &&
    !message.id.startsWith('summary-') &&
    message.tools.length === 1 &&
    isSubAgentToolCall(message.tools[0])
  );
}

function isBackgroundAgentOnlyToolGroup(message: Message): boolean {
  return (
    message.role === 'tool_group' &&
    !message.id.startsWith('summary-') &&
    message.tools.length === 1 &&
    isBackgroundSubAgentToolCall(message.tools[0])
  );
}

function isBackgroundLaunchNarration(message: Message): boolean {
  // The daemon often streams short main-agent thought text between background
  // launches, e.g. "agent A is running, now starting agent B". The CLI treats
  // those as internal launch narration and shows a single Parallel agents box.
  // Only skip thought-only messages here; any user-facing assistant content
  // still breaks the group and remains visible.
  return message.role === 'thinking';
}

export function groupParallelAgents(
  messages: Message[],
): ParallelAgentDisplayItem[] {
  const items: ParallelAgentDisplayItem[] = [];
  let index = 0;
  while (index < messages.length) {
    if (isBackgroundAgentOnlyToolGroup(messages[index])) {
      const grouped: Message[] = [];
      let nextIndex = index;
      while (nextIndex < messages.length) {
        const current = messages[nextIndex];
        if (isBackgroundAgentOnlyToolGroup(current)) {
          grouped.push(current);
          nextIndex += 1;
          continue;
        }
        if (isBackgroundLaunchNarration(current)) {
          let nextAgentIndex = nextIndex + 1;
          while (
            nextAgentIndex < messages.length &&
            isBackgroundLaunchNarration(messages[nextAgentIndex])
          ) {
            nextAgentIndex += 1;
          }
          if (
            nextAgentIndex < messages.length &&
            isBackgroundAgentOnlyToolGroup(messages[nextAgentIndex])
          ) {
            nextIndex = nextAgentIndex;
            continue;
          }
        }
        break;
      }

      if (grouped.length >= 2) {
        items.push({
          type: 'parallel_agents',
          key: `par-${grouped[0].id}`,
          turnId: grouped[0].id,
          agents: grouped.map(
            (message) => (message as { tools: ACPToolCall[] }).tools[0],
          ),
          timestamp: grouped[0].timestamp,
        });
        index = nextIndex;
        continue;
      }
    }

    if (isAgentOnlyToolGroup(messages[index])) {
      const start = index;
      while (index < messages.length && isAgentOnlyToolGroup(messages[index])) {
        index += 1;
      }
      if (index - start >= 2) {
        const grouped = messages.slice(start, index);
        items.push({
          type: 'parallel_agents',
          key: `par-${grouped[0].id}`,
          turnId: grouped[0].id,
          agents: grouped.map(
            (message) => (message as { tools: ACPToolCall[] }).tools[0],
          ),
          timestamp: grouped[0].timestamp,
        });
      } else {
        items.push({
          type: 'message',
          key: messages[start].id,
          message: messages[start],
        });
      }
    } else {
      items.push({
        type: 'message',
        key: messages[index].id,
        message: messages[index],
      });
      index += 1;
    }
  }
  return items;
}
