import { DaemonSessionProvider } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  WEB_SHELL_HISTORY_PAGE_SIZE,
  WEB_SHELL_MAX_TRANSCRIPT_BLOCKS,
} from '../../constants/sessions';
import { ChatPane } from '../ChatPane';
import type { TurnOutputOpenRequest } from './TurnOutputs';

interface SessionPanelProps {
  tabId: string;
  sessionId: string;
  workspaceCwd: string;
  title: string;
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
 * runs. Read-only, but its approvals and questions still show, since nobody
 * else may be watching it.
 */
export function SessionPanel({
  tabId,
  sessionId,
  workspaceCwd,
  title,
  onRightPanelOpen,
  onArtifactsChange,
  onError,
  onImageIngestionNotice,
}: SessionPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="session-panel">
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
