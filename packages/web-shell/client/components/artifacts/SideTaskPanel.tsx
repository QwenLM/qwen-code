import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DaemonSessionProvider,
  useActions,
  useConnection,
  useTranscriptBlocks,
  useTranscriptHistory,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  WEB_SHELL_HISTORY_PAGE_SIZE,
  WEB_SHELL_MAX_TRANSCRIPT_BLOCKS,
} from '../../constants/sessions';
import type { TurnOutputOpenRequest } from './TurnOutputs';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { DaemonWorkspaceActions } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { ChatPane } from '../ChatPane';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

interface SideTaskPanelProps {
  tabId: string;
  sessionId?: string;
  parentSessionId: string;
  workspaceCwd?: string;
  title: string;
  shouldNameFromFirstPrompt?: boolean;
  initialPrompt?: string;
  createSession: (
    tabId: string,
    parentSessionId: string,
    title: string,
  ) => Promise<{ sessionId: string; displayName?: string }>;
  onCreated: (tabId: string, sessionId: string) => void;
  onTitleChange: (
    tabId: string,
    title: string,
    fromFirstPrompt?: boolean,
  ) => void;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
    workspaceActions: DaemonWorkspaceActions,
  ) => void;
  onError?: (error: unknown, fallback: string) => void;
  sessionWorkflowEnabled?: boolean;
}

const FIRST_PROMPT_RENAME_ATTEMPTS = 3;

export function SideTaskPanel({
  tabId,
  sessionId,
  parentSessionId,
  workspaceCwd,
  title,
  shouldNameFromFirstPrompt,
  initialPrompt,
  createSession,
  onCreated,
  onTitleChange,
  onRightPanelOpen,
  onArtifactsChange,
  onError,
  sessionWorkflowEnabled,
}: SideTaskPanelProps) {
  if (!sessionId) {
    return (
      <SideTaskCreation
        tabId={tabId}
        parentSessionId={parentSessionId}
        title={title}
        createSession={createSession}
        onCreated={onCreated}
        onTitleChange={onTitleChange}
        onError={onError}
      />
    );
  }

  return (
    <DaemonSessionProvider
      sessionId={sessionId}
      workspaceCwd={workspaceCwd}
      clientId={`side-task:${parentSessionId}:${tabId}`}
      autoConnect
      historyPageSize={WEB_SHELL_HISTORY_PAGE_SIZE}
      subagentTranscriptMode="summary"
      maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
      suppressOwnUserEcho
    >
      <SideTaskSession
        tabId={tabId}
        title={title}
        shouldNameFromFirstPrompt={shouldNameFromFirstPrompt}
        initialPrompt={initialPrompt}
        workspaceCwd={workspaceCwd}
        onTitleChange={onTitleChange}
        onRightPanelOpen={onRightPanelOpen}
        onArtifactsChange={onArtifactsChange}
        onError={onError}
        sessionWorkflowEnabled={sessionWorkflowEnabled}
      />
    </DaemonSessionProvider>
  );
}

function SideTaskCreation({
  tabId,
  parentSessionId,
  title,
  createSession,
  onCreated,
  onTitleChange,
  onError,
}: Pick<
  SideTaskPanelProps,
  | 'tabId'
  | 'parentSessionId'
  | 'title'
  | 'createSession'
  | 'onCreated'
  | 'onTitleChange'
  | 'onError'
>) {
  const { t } = useI18n();
  const creatingRef = useRef(false);
  const didAttemptCreateRef = useRef(false);
  const [creationError, setCreationError] = useState<unknown>();

  const create = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreationError(undefined);
    try {
      const created = await createSession(tabId, parentSessionId, title);
      onCreated(tabId, created.sessionId);
      if (created.displayName) onTitleChange(tabId, created.displayName);
    } catch (error) {
      setCreationError(error);
      onError?.(error, t('sideTask.createFailed'));
    } finally {
      creatingRef.current = false;
    }
  }, [
    createSession,
    onCreated,
    onError,
    onTitleChange,
    parentSessionId,
    t,
    tabId,
    title,
  ]);

  useEffect(() => {
    if (didAttemptCreateRef.current) return;
    didAttemptCreateRef.current = true;
    void create();
  }, [create]);

  if (creationError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span>{t('sideTask.createFailed')}</span>
        <Button type="button" variant="outline" onClick={() => void create()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Spinner />
      <span>{t('sideTask.creating')}</span>
    </div>
  );
}

function SideTaskSession({
  tabId,
  title,
  shouldNameFromFirstPrompt,
  initialPrompt,
  workspaceCwd,
  onTitleChange,
  onRightPanelOpen,
  onArtifactsChange,
  onError,
  sessionWorkflowEnabled,
}: Omit<
  SideTaskPanelProps,
  'sessionId' | 'parentSessionId' | 'createSession' | 'onCreated'
>) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const blocks = useTranscriptBlocks();
  const transcriptHistory = useTranscriptHistory();
  const hasUserPrompt = blocks.some((block) => block.kind === 'user');
  const restoredEmptySession =
    connection.status === 'connected' &&
    !connection.loadingTranscript &&
    !connection.catchingUp &&
    !transcriptHistory.loading &&
    !transcriptHistory.hasMore &&
    !transcriptHistory.capacityReached &&
    !transcriptHistory.paginationError &&
    !hasUserPrompt;
  const canNameFromFirstPrompt =
    !hasUserPrompt && (shouldNameFromFirstPrompt || restoredEmptySession);
  useEffect(() => {
    const displayName = connection.displayName?.trim();
    if (displayName) onTitleChange(tabId, displayName);
  }, [connection.displayName, onTitleChange, tabId]);
  const nameFromFirstPrompt = useCallback(
    (text: string) => {
      const nextTitle = Array.from(text.trim()).slice(0, 200).join('');
      if (!nextTitle) return;
      onTitleChange(tabId, nextTitle);
      void (async () => {
        let lastError: unknown;
        for (
          let attempt = 0;
          attempt < FIRST_PROMPT_RENAME_ATTEMPTS;
          attempt++
        ) {
          try {
            await actions.renameSession(nextTitle);
            onTitleChange(tabId, nextTitle, true);
            return;
          } catch (error) {
            lastError = error;
          }
        }
        onError?.(lastError, t('sideTask.renameFailed'));
      })();
    },
    [actions, onError, onTitleChange, t, tabId],
  );
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    const prompt = initialPrompt?.trim();
    if (!prompt || !restoredEmptySession || initialPromptSentRef.current)
      return;
    initialPromptSentRef.current = true;
    actions
      .sendPrompt(prompt, {
        onAdmitted: () => nameFromFirstPrompt(prompt),
      })
      .catch((error: unknown) => {
        initialPromptSentRef.current = false;
        onError?.(error, t('sideTask.promptFailed'));
      });
  }, [
    actions,
    initialPrompt,
    nameFromFirstPrompt,
    onError,
    restoredEmptySession,
    t,
  ]);

  if (!connection.sessionId) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <ChatPane
      title={connection.displayName?.trim() || title}
      workspaceCwd={workspaceCwd}
      onError={onError}
      embedded
      onFirstPromptAdmitted={
        canNameFromFirstPrompt ? nameFromFirstPrompt : undefined
      }
      onRightPanelOpen={onRightPanelOpen}
      onPaneArtifactsChange={onArtifactsChange}
      sessionWorkflowEnabled={sessionWorkflowEnabled}
    />
  );
}
