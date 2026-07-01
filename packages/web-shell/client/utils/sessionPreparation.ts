import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/webui/daemon-react-sdk';

type PromptSessionActions = {
  createSession: () => Promise<unknown>;
  attachSession: () => Promise<void>;
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
  warn = console.warn,
}: {
  sessionActions: PromptSessionActions;
  modelId?: string;
  modeId?: string;
  warn?: (message?: unknown, ...optionalParams: unknown[]) => void;
}): Promise<void> {
  await sessionActions.createSession();
  await sessionActions.attachSession();
  if (modelId) {
    await sessionActions.setModel(modelId).catch((error: unknown) => {
      warn('[WebShell] failed to set model for new session:', error);
    });
  }
  if (modeId && isDaemonApprovalMode(modeId)) {
    await sessionActions.setApprovalMode(modeId).catch((error: unknown) => {
      warn('[WebShell] failed to set approval mode for new session:', error);
    });
  }
}
