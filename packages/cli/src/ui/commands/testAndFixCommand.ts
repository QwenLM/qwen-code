import { CommandKind, SlashCommand, ToolActionReturn } from './types.js';

export const testAndFixCommand: SlashCommand = {
  name: 'test-and-fix',
  kind: CommandKind.BUILT_IN,
  description: 'Runs the project test suite.',
  action: async (): Promise<ToolActionReturn> => ({
    type: 'tool',
    toolName: 'run_shell_command',
    toolArgs: {
      command: 'npm test',
      is_background: false,
    },
  }),
};
