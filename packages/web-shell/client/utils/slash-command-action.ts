import type { WebShellSlashCommandHandler } from '../App';

export const SLASH_COMMAND_PATTERN = /^\/([\w-]+)(?=\s|$)/;

export function invokeSlashCommandHandler(
  input: string,
  handler: WebShellSlashCommandHandler | undefined,
  reportError: (error: unknown, fallback: string) => void,
): boolean {
  if (!handler) return false;
  const match = input.match(SLASH_COMMAND_PATTERN);
  if (!match) return false;
  try {
    return (
      handler({
        command: match[1].toLowerCase(),
        args: input.slice(match[0].length).trim(),
        input,
      }) === true
    );
  } catch (error: unknown) {
    reportError(error, 'onSlashCommand callback failed');
    return false;
  }
}
