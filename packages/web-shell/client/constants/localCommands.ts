import type { CommandInfo } from '../adapters/types';

/**
 * Commands that should always appear in the slash-command completion menu,
 * regardless of what ACP sends (ACP filters most BUILT_IN commands to
 * 'interactive' mode only). These are merged with ACP-provided commands,
 * with ACP taking precedence on duplicates.
 */
export const LOCAL_COMMANDS: CommandInfo[] = [
  { name: 'plan', description: '进入 Plan 模式', argumentHint: '<prompt>' },
  { name: 'mode', description: '切换审批模式', argumentHint: '<mode>' },
  {
    name: 'approval-mode',
    description: '切换审批模式',
    argumentHint: '<mode>',
  },
  { name: 'model', description: '切换模型', argumentHint: '<model>' },
  { name: 'mcp', description: '管理 MCP servers' },
  { name: 'skills', description: '查看可用 skills' },
  { name: 'memory', description: '查看和写入 memory' },
  {
    name: 'agents',
    description: '管理 subagents',
    argumentHint: 'create|manage',
  },
  { name: 'clear', description: '清空对话' },
  { name: 'new', description: '开始新对话' },
  { name: 'reset', description: '重置当前对话' },
  {
    name: 'rename',
    description: '重命名当前会话',
    argumentHint: '<name>',
  },
  { name: 'resume', description: '恢复历史会话', argumentHint: '<session-id>' },
];
