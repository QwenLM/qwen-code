import type { ACPToolCall, Message } from '../adapters/types';
import {
  backgroundShellTaskId,
  isBackgroundSubAgentToolCall,
} from '../adapters/toolClassification';

function isBackgroundTaskToolCall(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'monitor' || name === 'workflow') return true;
  if (backgroundShellTaskId(tool) !== undefined) return true;
  if (tool.args?.is_background !== true) return false;
  return (
    name === 'shell' ||
    name === 'bash' ||
    name === 'run_shell_command' ||
    name === 'exec'
  );
}

export function getTaskActivityKey(messages: readonly Message[]): string {
  const parts: string[] = [];
  const visit = (tools: readonly ACPToolCall[]) => {
    for (const tool of tools) {
      if (
        isBackgroundTaskToolCall(tool) ||
        isBackgroundSubAgentToolCall(tool)
      ) {
        parts.push(`${tool.callId}:${tool.status}`);
      }
      if (tool.subTools) visit(tool.subTools);
    }
  };
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    visit(message.tools);
  }
  return parts.join('|');
}
