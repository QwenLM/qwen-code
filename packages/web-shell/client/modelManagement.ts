import { SLASH_COMMAND_PATTERN } from './utils/slash-command-action';

/** WebShell interaction controls only; daemon APIs and external provisioning remain available. */
export interface WebShellModelManagementOptions {
  /** Allow provider/model setup, including /auth. Defaults to true. */
  allowAdd?: boolean;
  /** Allow model deletion. Defaults to true. */
  allowDelete?: boolean;
}

export function resolveModelManagement(
  options?: WebShellModelManagementOptions,
): Required<WebShellModelManagementOptions> {
  return {
    allowAdd: options?.allowAdd ?? true,
    allowDelete: options?.allowDelete ?? true,
  };
}

export function isModelSetupCommand(input: string): boolean {
  return (
    input.trim().match(SLASH_COMMAND_PATTERN)?.[1]?.toLowerCase() === 'auth'
  );
}
