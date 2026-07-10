import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/webui/daemon-react-sdk';

type PromptSessionActions = {
  createSession: (options?: { workspaceCwd?: string }) => Promise<unknown>;
  attachSession: () => Promise<void>;
  closeSession: () => Promise<void>;
  clearSession: () => Promise<void>;
  setModel: (modelId: string) => Promise<unknown>;
  setApprovalMode: (mode: DaemonApprovalMode) => Promise<unknown>;
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
  await sessionActions.createSession({ workspaceCwd });
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
  await Promise.all([
    modelId
      ? sessionActions.setModel(modelId).catch((error: unknown) => {
          warn('[WebShell] failed to set model for new session:', error);
        })
      : Promise.resolve(),
    modeId && isDaemonApprovalMode(modeId)
      ? sessionActions.setApprovalMode(modeId).catch((error: unknown) => {
          warn(
            '[WebShell] failed to set approval mode for new session:',
            error,
          );
        })
      : Promise.resolve(),
  ]);
}
