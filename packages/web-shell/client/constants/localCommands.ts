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
  {
    name: 'model',
    description: '切换模型或设置 fast model',
    argumentHint: '[--fast] [<model>]',
  },
  { name: 'mcp', description: '管理 MCP servers' },
  { name: 'skills', description: '查看可用 skills' },
  { name: 'tools', description: '查看可用工具；输入 /tools desc 显示描述' },
  {
    name: 'memory',
    description: '管理 memory',
    argumentHint: 'show|add|refresh',
  },
  {
    name: 'agents',
    description: '管理 subagents',
    argumentHint: 'manage|create user|create project',
  },
  { name: 'clear', description: '清空对话' },
  { name: 'new', description: '开始新对话' },
  { name: 'reset', description: '重置当前对话' },
  {
    name: 'rename',
    description: '重命名当前会话',
    argumentHint: '[--auto] [<name>]',
  },
  { name: 'resume', description: '恢复历史会话', argumentHint: '<session-id>' },
];
