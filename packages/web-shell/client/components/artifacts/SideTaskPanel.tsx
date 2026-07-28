import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DaemonSessionProvider,
  useActions,
  useConnection,
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
  createSession: (
    tabId: string,
    parentSessionId: string,
    title: string,
  ) => Promise<{ sessionId: string; displayName?: string }>;
  onCreated: (tabId: string, sessionId: string) => void;
  onTitleChange: (tabId: string, title: string) => void;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
    workspaceActions: DaemonWorkspaceActions,
  ) => void;
  onError?: (error: unknown, fallback: string) => void;
}

export function SideTaskPanel({
  tabId,
  sessionId,
  parentSessionId,
  workspaceCwd,
  title,
  createSession,
  onCreated,
  onTitleChange,
  onRightPanelOpen,
  onArtifactsChange,
  onError,
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
        workspaceCwd={workspaceCwd}
        onTitleChange={onTitleChange}
        onRightPanelOpen={onRightPanelOpen}
        onArtifactsChange={onArtifactsChange}
        onError={onError}
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
  workspaceCwd,
  onTitleChange,
  onRightPanelOpen,
  onArtifactsChange,
  onError,
}: Omit<
  SideTaskPanelProps,
  'sessionId' | 'parentSessionId' | 'createSession' | 'onCreated'
>) {
  const connection = useConnection();
  const actions = useActions();
  useEffect(() => {
    const displayName = connection.displayName?.trim();
    if (displayName) onTitleChange(tabId, displayName);
  }, [connection.displayName, onTitleChange, tabId]);
  const nameFromFirstPrompt = useCallback(
    (text: string) => {
      const nextTitle = text.trim().slice(0, 200);
      if (!nextTitle) return;
      onTitleChange(tabId, nextTitle);
      void actions
        .renameSession(nextTitle)
        .catch((error: unknown) =>
          onError?.(error, 'Failed to name side task'),
        );
    },
    [actions, onError, onTitleChange, tabId],
  );

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
      onFirstPromptAdmitted={nameFromFirstPrompt}
      onRightPanelOpen={onRightPanelOpen}
      onPaneArtifactsChange={onArtifactsChange}
    />
  );
}
