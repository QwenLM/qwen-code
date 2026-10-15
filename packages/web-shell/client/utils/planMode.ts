import { DAEMON_APPROVAL_MODES } from '@qwen-code/web-shell/daemon-react-sdk';

export const EXECUTION_APPROVAL_MODES = DAEMON_APPROVAL_MODES.filter(
  (mode) => mode !== 'plan',
);

export function parsePlanCommand(
  args: string,
  enabled: boolean,
): { enabled: boolean; prompt?: string } {
  const prompt = args.trim();
  switch (prompt.toLowerCase()) {
    case '':
      return { enabled: !enabled };
    case 'on':
      return { enabled: true };
    case 'off':
    case 'exit':
      return { enabled: false };
    default:
      return { enabled: true, prompt };
  }
}
