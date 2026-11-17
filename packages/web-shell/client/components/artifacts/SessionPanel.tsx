import { DaemonSessionProvider } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  WEB_SHELL_HISTORY_PAGE_SIZE,
  WEB_SHELL_MAX_TRANSCRIPT_BLOCKS,
} from '../../constants/sessions';
import { useI18n } from '../../i18n';
import { ChatPane } from '../ChatPane';
import { Button } from '../ui/button';
import type { TurnOutputOpenRequest } from './TurnOutputs';

interface SessionPanelProps {
  tabId: string;
  sessionId: string;
  workspaceCwd: string;
  title: string;
  onOpenSession?: (sessionId: string, workspaceCwd: string) => void;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
  ) => void;
  onError?: (error: unknown, fallback: string) => void;
  onImageIngestionNotice?: (tone: 'warning' | 'error', message: string) => void;
}

/**
 * Another session, live, beside this one: where a message sent with `/send`
 * runs. Read-only — replying means opening the session — but its approvals
 * still show, since nobody else may be watching it.
 */
export function SessionPanel({
  tabId,
  sessionId,
  workspaceCwd,
  title,
  onOpenSession,
  onRightPanelOpen,
  onArtifactsChange,
  onError,
  onImageIngestionNotice,
}: SessionPanelProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="session-panel">
      {onOpenSession && (
        <div className="flex items-center justify-end border-b px-3 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="session-panel-open"
            onClick={() => onOpenSession(sessionId, workspaceCwd)}
          >
            {t('sessionPanel.open')}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DaemonSessionProvider
          sessionId={sessionId}
          workspaceCwd={workspaceCwd}
          // Its own attachment, apart from the main view and split panes.
          clientId={`session-tab:${tabId}`}
          autoConnect
          historyPageSize={WEB_SHELL_HISTORY_PAGE_SIZE}
          subagentTranscriptMode="summary"
          maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
          suppressOwnUserEcho
        >
          <ChatPane
            title={title}
            workspaceCwd={workspaceCwd}
            embedded
            readOnly
            onError={onError}
            onImageIngestionNotice={onImageIngestionNotice}
            onRightPanelOpen={onRightPanelOpen}
            onPaneArtifactsChange={onArtifactsChange}
          />
        </DaemonSessionProvider>
      </div>
    </div>
  );
}
