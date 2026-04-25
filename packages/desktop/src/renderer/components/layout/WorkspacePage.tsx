/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, type Dispatch, type FormEvent } from 'react';
import type {
  DesktopGitDiff,
  DesktopGitReviewTarget,
  DesktopProject,
  DesktopSessionSummary,
  DesktopTerminal,
} from '../../api/client.js';
import type { ChatState } from '../../stores/chatStore.js';
import type { ModelState } from '../../stores/modelStore.js';
import type {
  SettingsAction,
  SettingsState,
} from '../../stores/settingsStore.js';
import type { DesktopApprovalMode } from '../../../shared/desktopProtocol.js';
import { ChatThread } from './ChatThread.js';
import { ProjectSidebar } from './ProjectSidebar.js';
import { ReviewPanel } from './ReviewPanel.js';
import { SettingsPage } from './SettingsPage.js';
import { TerminalDrawer } from './TerminalDrawer.js';
import { TopBar } from './TopBar.js';
import type { LoadState } from './types.js';

type WorkspaceView = 'chat' | 'settings';

export function WorkspacePage({
  activeProject,
  activeProjectId,
  activeSessionId,
  chatState,
  commitMessage,
  gitDiff,
  loadState,
  messageText,
  modelState,
  isDraftSession,
  projects,
  reviewError,
  sessionError,
  sessions,
  settingsState,
  statusLabel,
  terminal,
  terminalCommand,
  terminalError,
  terminalInput,
  terminalNotice,
  onAskUserQuestionResponse,
  onAuthenticate,
  onChooseWorkspace,
  onClearTerminal,
  onCommit,
  onCommitMessageChange,
  onCopyTerminalOutput,
  onCreateSession,
  onKillTerminal,
  onMessageTextChange,
  onModeChange,
  onModelChange,
  onPermissionResponse,
  onRefreshProjectGitStatus,
  onOpenReviewFile,
  onRevertReviewTarget,
  onRunTerminalCommand,
  onSaveSettings,
  onAttachTerminalOutput,
  onSelectProject,
  onSelectSession,
  onSendMessage,
  onSettingsDispatch,
  onStageReviewTarget,
  onStopGeneration,
  onTerminalCommandChange,
  onTerminalInputChange,
  onWriteTerminalInput,
}: {
  activeProject: DesktopProject | null;
  activeProjectId: string | null;
  activeSessionId: string | null;
  chatState: ChatState;
  commitMessage: string;
  gitDiff: DesktopGitDiff | null;
  loadState: LoadState;
  messageText: string;
  modelState: ModelState;
  isDraftSession: boolean;
  projects: DesktopProject[];
  reviewError: string | null;
  sessionError: string | null;
  sessions: DesktopSessionSummary[];
  settingsState: SettingsState;
  statusLabel: string;
  terminal: DesktopTerminal | null;
  terminalCommand: string;
  terminalError: string | null;
  terminalInput: string;
  terminalNotice: string | null;
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onAuthenticate: (methodId: string) => void;
  onChooseWorkspace: () => void;
  onClearTerminal: () => void;
  onCommit: () => void;
  onCommitMessageChange: (message: string) => void;
  onCopyTerminalOutput: () => void;
  onCreateSession: () => void;
  onKillTerminal: () => void;
  onMessageTextChange: (message: string) => void;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  onRefreshProjectGitStatus: () => void;
  onOpenReviewFile: (filePath: string) => void;
  onRevertReviewTarget: (target: DesktopGitReviewTarget) => void;
  onRunTerminalCommand: () => void;
  onSaveSettings: () => void;
  onAttachTerminalOutput: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => void;
  onSettingsDispatch: Dispatch<SettingsAction>;
  onStageReviewTarget: (target: DesktopGitReviewTarget) => void;
  onStopGeneration: () => void;
  onTerminalCommandChange: (command: string) => void;
  onTerminalInputChange: (input: string) => void;
  onWriteTerminalInput: () => void;
}) {
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('chat');
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false);
  const activeSession =
    sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const showSettingsPage = () => {
    setWorkspaceView('settings');
  };
  const showConversation = () => {
    setWorkspaceView('chat');
    setIsReviewOpen(false);
  };
  const toggleReview = () => {
    setWorkspaceView('chat');
    setIsReviewOpen((current) => !current);
  };
  const isSettingsOpen = workspaceView === 'settings';

  return (
    <main className="desktop-shell" data-testid="desktop-workspace">
      <ProjectSidebar
        activeProject={activeProject}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        isDraftSession={isDraftSession}
        loadState={loadState}
        projects={projects}
        sessions={sessions}
        onChooseWorkspace={onChooseWorkspace}
        onCreateSession={onCreateSession}
        onOpenSettings={showSettingsPage}
        onSelectProject={onSelectProject}
        onSelectSession={onSelectSession}
      />

      <section
        className={
          workspaceView === 'settings'
            ? 'workbench workbench-settings-open'
            : 'workbench'
        }
        aria-label="Workbench"
      >
        <TopBar
          activeProject={activeProject}
          activeSessionTitle={activeSession?.title || null}
          activeView={workspaceView}
          isReviewOpen={!isSettingsOpen && isReviewOpen}
          loadState={loadState}
          statusLabel={statusLabel}
          onRefreshGitStatus={onRefreshProjectGitStatus}
          onShowReview={toggleReview}
          onShowChat={showConversation}
          onShowSettings={showSettingsPage}
        />

        <div
          className={
            !isSettingsOpen && isReviewOpen
              ? 'workspace-grid workspace-grid-review-open'
              : 'workspace-grid'
          }
          data-testid="workspace-grid"
        >
          {!isSettingsOpen ? (
            <ChatThread
              activeProject={activeProject}
              activeSessionId={activeSessionId}
              chatState={chatState}
              isDraftSession={isDraftSession}
              messageText={messageText}
              modelState={modelState}
              onAskUserQuestionResponse={onAskUserQuestionResponse}
              onModeChange={onModeChange}
              onModelChange={onModelChange}
              onMessageTextChange={onMessageTextChange}
              onPermissionResponse={onPermissionResponse}
              onSendMessage={onSendMessage}
              onStopGeneration={onStopGeneration}
            />
          ) : null}

          {!isSettingsOpen && isReviewOpen ? (
            <ReviewPanel
              activeProject={activeProject}
              commitMessage={commitMessage}
              gitDiff={gitDiff}
              reviewError={reviewError}
              onClose={() => setIsReviewOpen(false)}
              onCommit={onCommit}
              onCommitMessageChange={onCommitMessageChange}
              onOpenFile={onOpenReviewFile}
              onRevertTarget={onRevertReviewTarget}
              onStageTarget={onStageReviewTarget}
            />
          ) : null}

          {isSettingsOpen ? (
            <SettingsPage
              activeSessionId={activeSessionId}
              chatState={chatState}
              loadState={loadState}
              modelState={modelState}
              sessionError={sessionError}
              settingsState={settingsState}
              onAuthenticate={onAuthenticate}
              onBack={() => setWorkspaceView('chat')}
              onModeChange={onModeChange}
              onModelChange={onModelChange}
              onSaveSettings={onSaveSettings}
              onSettingsDispatch={onSettingsDispatch}
            />
          ) : null}
        </div>
        {isSettingsOpen ? null : (
          <TerminalDrawer
            command={terminalCommand}
            error={terminalError}
            isExpanded={isTerminalExpanded}
            input={terminalInput}
            notice={terminalNotice}
            project={activeProject}
            terminal={terminal}
            onClear={onClearTerminal}
            onCommandChange={onTerminalCommandChange}
            onCopyOutput={onCopyTerminalOutput}
            onKill={onKillTerminal}
            onInputChange={onTerminalInputChange}
            onRun={onRunTerminalCommand}
            onAttachOutput={onAttachTerminalOutput}
            onToggleExpanded={() =>
              setIsTerminalExpanded((current) => !current)
            }
            onWriteInput={onWriteTerminalInput}
          />
        )}
      </section>
    </main>
  );
}
