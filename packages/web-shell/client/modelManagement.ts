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

// Mirrors the daemon's auth command (`authCommand.altNames`) and its
// tokenization (`query.trim().substring(1).trim().split(/\s+/)` in
// parseSlashCommand) so an alias or whitespace after the slash cannot slip
// past the host policy. Keep in sync with packages/cli authCommand.
const MODEL_SETUP_COMMAND_NAMES = new Set(['auth', 'connect', 'login']);

export function isModelSetupCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return false;
  const firstToken = trimmed.slice(1).trimStart().split(/\s+/, 1)[0];
  return MODEL_SETUP_COMMAND_NAMES.has(firstToken.toLowerCase());
}
