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

/** The command identity a session's command snapshot carries per entry. */
export interface ModelSetupCommandInfo {
  name: string;
  source?: string;
  altNames?: readonly string[];
}

export function isModelCommandSnapshotReady(
  commands?: readonly ModelSetupCommandInfo[],
): boolean {
  return (
    commands?.some((command) => command.source === 'builtin-command') ?? false
  );
}

export function isModelSetupCommand(
  input: string,
  commands?: readonly ModelSetupCommandInfo[],
): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return false;
  const firstToken = trimmed.slice(1).trimStart().split(/\s+/, 1)[0];
  // With a fully loaded snapshot (a builtin entry marks it, per
  // daemon/session/actions.ts), classify by the RESOLVED command exactly as
  // the daemon does — exact name, then altNames, both case-sensitive
  // (commands.ts findCommandByName): a project/user command named `auth`,
  // `connect` or `login` replaces the builtin and must stay runnable. Until
  // the snapshot loads, fail closed on the bare names.
  if (commands && isModelCommandSnapshotReady(commands)) {
    const resolved =
      commands.find((command) => command.name === firstToken) ??
      commands.find((command) => command.altNames?.includes(firstToken));
    // A ready snapshot with no entry for a bare setup name means the daemon
    // dropped the builtin (disabled list, SSH whitelist) and no project/user
    // command shadows it — fail closed instead of dispatching past the host.
    if (!resolved) return MODEL_SETUP_COMMAND_NAMES.has(firstToken);
    return resolved.name === 'auth' && resolved.source === 'builtin-command';
  }
  return MODEL_SETUP_COMMAND_NAMES.has(firstToken);
}
