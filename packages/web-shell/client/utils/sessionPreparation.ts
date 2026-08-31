import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { WEB_SHELL_SESSION_SOURCE_TYPE } from '../constants/sessions';

const SESSION_CREATED_CALLBACK_TIMEOUT_MS = 30_000;

type PromptSessionActions = {
  createSession: (options?: {
    workspaceCwd?: string;
    approvalMode?: DaemonApprovalMode;
    sourceType?: string;
    worktree?: { slug?: string };
    branch?: { name: string };
  }) => Promise<{
    sessionId: string;
    worktree?: { slug: string; path: string; branch: string };
    branch?: { name: string; baseBranch: string };
  }>;
  attachSession: () => Promise<void>;
  clearSession: () => Promise<void>;
  releaseSession: (sessionId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<unknown>;
  setReasoningEffort: (value: string) => Promise<void>;
};

export function isDaemonApprovalMode(mode: string): mode is DaemonApprovalMode {
  return DAEMON_APPROVAL_MODES.includes(mode as DaemonApprovalMode);
}

export async function createAndAttachSessionForPrompt({
  sessionActions,
  modelId,
  reasoningEffort,
  modeId,
  workspaceCwd,
  worktree,
  branch,
  sessionSourceType = WEB_SHELL_SESSION_SOURCE_TYPE,
  onSessionCreated,
  onSessionAllocated,
  getCurrentSessionId,
  warn = console.warn,
}: {
  sessionActions: PromptSessionActions;
  modelId?: string;
  reasoningEffort?: string;
  modeId?: string;
  workspaceCwd?: string;
  worktree?: { slug?: string };
  branch?: { name: string };
  /**
   * Creator attribution recorded on the session. Embedded hosts pass their own
   * value so their sessions stay distinguishable from browser Web Shell ones.
   */
  sessionSourceType?: string;
  onSessionCreated?: (sessionId: string) => Promise<void> | void;
  onSessionAllocated?: (sessionId: string) => void;
  getCurrentSessionId: () => string | undefined;
  warn?: (message?: unknown, ...optionalParams: unknown[]) => void;
}): Promise<{
  worktree?: { slug: string; path: string; branch: string };
  branch?: { name: string; baseBranch: string };
}> {
  // Seed the approval mode in the create request itself so the daemon applies
  // it atomically at spawn (`POST /session` → `spawnOrAttach({ approvalMode })`),
  // saving a follow-up round-trip. Approval mode is fail-closed at spawn: if the
  // requested mode can't be applied the session is not created (this call
  // rejects), rather than silently running in a different mode than requested.
  // The model, by contrast, stays a best-effort follow-up below.
  const approvalMode =
    modeId && isDaemonApprovalMode(modeId) ? modeId : undefined;
  const {
    sessionId,
    worktree: worktreeInfo,
    branch: branchInfo,
  } = await sessionActions.createSession({
    workspaceCwd,
    sourceType: sessionSourceType,
    ...(approvalMode ? { approvalMode } : {}),
    ...(worktree ? { worktree } : {}),
    ...(branch ? { branch } : {}),
  });
  onSessionAllocated?.(sessionId);
  let preparationStep = 'prepare new session';
  try {
    if (onSessionCreated) {
      preparationStep = 'run onSessionCreated';
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          onSessionCreated(sessionId),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('onSessionCreated timed out')),
              SESSION_CREATED_CALLBACK_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    preparationStep = 'verify session identity';
    const sessionIdBeforeAttach = getCurrentSessionId();
    if (
      sessionIdBeforeAttach !== undefined &&
      sessionIdBeforeAttach !== sessionId
    ) {
      throw new Error(
        `Session changed before attach: expected ${sessionId}, found ${sessionIdBeforeAttach}`,
      );
    }
    preparationStep = 'attach new session';
    await sessionActions.attachSession();
    preparationStep = 'verify attached session';
    const sessionIdAfterAttach = getCurrentSessionId();
    if (
      sessionIdAfterAttach !== undefined &&
      sessionIdAfterAttach !== sessionId
    ) {
      throw new Error(
        `Session changed while attaching: expected ${sessionId}, found ${sessionIdAfterAttach}`,
      );
    }

    // The model is normally best-effort because the composer may already match
    // the daemon. An explicit model-bound reasoning choice is different: it
    // must never be applied after a failed switch to an unknown model.
    if (modelId) {
      preparationStep = 'set model for new session';
      try {
        await sessionActions.setModel(modelId);
      } catch (error) {
        if (reasoningEffort) throw error;
        warn('[WebShell] failed to set model for new session:', error);
      }
    }
    if (reasoningEffort) {
      preparationStep = 'set reasoning effort';
      await sessionActions.setReasoningEffort(reasoningEffort);
    }
  } catch (error) {
    warn(`[WebShell] failed to ${preparationStep}:`, error);
    await sessionActions
      .releaseSession(sessionId)
      .catch((releaseError: unknown) => {
        warn('[WebShell] failed to release unattached session:', releaseError);
      });
    const currentSessionId = getCurrentSessionId();
    if (currentSessionId === undefined || currentSessionId === sessionId) {
      await sessionActions.clearSession().catch((clearError: unknown) => {
        warn('[WebShell] failed to clear unattached session:', clearError);
      });
    } else {
      warn(
        `[WebShell] skipping clearSession: expected ${sessionId}, found ${currentSessionId}`,
      );
    }
    throw error;
  }
  return {
    ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
    ...(branchInfo ? { branch: branchInfo } : {}),
  };
}
