import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/webui/daemon-react-sdk';

type PromptSessionActions = {
  createSession: (options?: {
    workspaceCwd?: string;
    approvalMode?: DaemonApprovalMode;
  }) => Promise<unknown>;
  attachSession: () => Promise<void>;
  closeSession: () => Promise<void>;
  clearSession: () => Promise<void>;
  setModel: (modelId: string) => Promise<unknown>;
};

export function isDaemonApprovalMode(mode: string): mode is DaemonApprovalMode {
  return DAEMON_APPROVAL_MODES.includes(mode as DaemonApprovalMode);
}

export async function createAndAttachSessionForPrompt({
  sessionActions,
  modelId,
  modeId,
  workspaceCwd,
  warn = console.warn,
}: {
  sessionActions: PromptSessionActions;
  modelId?: string;
  modeId?: string;
  workspaceCwd?: string;
  warn?: (message?: unknown, ...optionalParams: unknown[]) => void;
}): Promise<void> {
  // Seed the approval mode in the create request itself so the daemon applies
  // it atomically at spawn (`POST /session` → `spawnOrAttach({ approvalMode })`),
  // saving a follow-up round-trip. Approval mode is fail-closed at spawn: if the
  // requested mode can't be applied the session is not created (this call
  // rejects), rather than silently running in a different mode than requested.
  // The model, by contrast, stays a best-effort follow-up below.
  const approvalMode =
    modeId && isDaemonApprovalMode(modeId) ? modeId : undefined;
  await sessionActions.createSession({
    workspaceCwd,
    ...(approvalMode ? { approvalMode } : {}),
  });
  try {
    await sessionActions.attachSession();
  } catch (error) {
    warn('[WebShell] failed to attach new session:', error);
    await sessionActions.closeSession().catch((closeError: unknown) => {
      warn('[WebShell] failed to close unattached session:', closeError);
    });
    await sessionActions.clearSession().catch((clearError: unknown) => {
      warn('[WebShell] failed to clear unattached session:', clearError);
    });
    throw error;
  }
  // The model still needs a post-create call: `POST /session` only accepts a
  // `modelServiceId`, whereas the composer selects a plain `modelId`. The
  // `POST /session/:id/model` route now resolves the owning workspace runtime,
  // so this succeeds for non-primary workspaces too.
  if (modelId) {
    await sessionActions.setModel(modelId).catch((error: unknown) => {
      warn('[WebShell] failed to set model for new session:', error);
    });
  }
}
