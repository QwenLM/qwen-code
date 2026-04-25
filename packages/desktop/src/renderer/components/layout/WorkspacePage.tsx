/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dispatch, FormEvent } from 'react';
import type {
  DesktopGitDiff,
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
import { TerminalDrawer } from './TerminalDrawer.js';
import { TopBar } from './TopBar.js';
import type { LoadState } from './types.js';

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
  projects,
  reviewError,
  sessionError,
  sessions,
  settingsState,
  statusLabel,
  terminal,
  terminalCommand,
  terminalError,
  onAskUserQuestionResponse,
  onAuthenticate,
  onChooseWorkspace,
  onClearTerminal,
  onCommit,
  onCommitMessageChange,
  onCreateSession,
  onKillTerminal,
  onMessageTextChange,
  onModeChange,
  onModelChange,
  onPermissionResponse,
  onRefreshProjectGitStatus,
  onRevertAllChanges,
  onRunTerminalCommand,
  onSaveSettings,
  onSelectProject,
  onSelectSession,
  onSendMessage,
  onSettingsDispatch,
  onStageAllChanges,
  onStopGeneration,
  onTerminalCommandChange,
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
  projects: DesktopProject[];
  reviewError: string | null;
  sessionError: string | null;
  sessions: DesktopSessionSummary[];
  settingsState: SettingsState;
  statusLabel: string;
  terminal: DesktopTerminal | null;
  terminalCommand: string;
  terminalError: string | null;
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onAuthenticate: (methodId: string) => void;
  onChooseWorkspace: () => void;
  onClearTerminal: () => void;
  onCommit: () => void;
  onCommitMessageChange: (message: string) => void;
  onCreateSession: () => void;
  onKillTerminal: () => void;
  onMessageTextChange: (message: string) => void;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  onRefreshProjectGitStatus: () => void;
  onRevertAllChanges: () => void;
  onRunTerminalCommand: () => void;
  onSaveSettings: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => void;
  onSettingsDispatch: Dispatch<SettingsAction>;
  onStageAllChanges: () => void;
  onStopGeneration: () => void;
  onTerminalCommandChange: (command: string) => void;
}) {
  return (
    <main className="desktop-shell" data-testid="desktop-workspace">
      <ProjectSidebar
        activeProject={activeProject}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        loadState={loadState}
        projects={projects}
        sessions={sessions}
        onChooseWorkspace={onChooseWorkspace}
        onCreateSession={onCreateSession}
        onSelectProject={onSelectProject}
        onSelectSession={onSelectSession}
      />

      <section className="workbench" aria-label="Workbench">
        <TopBar
          activeProject={activeProject}
          loadState={loadState}
          statusLabel={statusLabel}
          onRefreshGitStatus={onRefreshProjectGitStatus}
        />

        <div className="workspace-grid" data-testid="workspace-grid">
          <ChatThread
            activeSessionId={activeSessionId}
            chatState={chatState}
            messageText={messageText}
            onAskUserQuestionResponse={onAskUserQuestionResponse}
            onMessageTextChange={onMessageTextChange}
            onPermissionResponse={onPermissionResponse}
            onSendMessage={onSendMessage}
            onStopGeneration={onStopGeneration}
          />

          <ReviewPanel
            activeProject={activeProject}
            activeSessionId={activeSessionId}
            chatState={chatState}
            commitMessage={commitMessage}
            gitDiff={gitDiff}
            loadState={loadState}
            modelState={modelState}
            reviewError={reviewError}
            sessionError={sessionError}
            settingsState={settingsState}
            onAuthenticate={onAuthenticate}
            onCommit={onCommit}
            onCommitMessageChange={onCommitMessageChange}
            onModeChange={onModeChange}
            onModelChange={onModelChange}
            onRevertAll={onRevertAllChanges}
            onSaveSettings={onSaveSettings}
            onSettingsDispatch={onSettingsDispatch}
            onStageAll={onStageAllChanges}
          />
        </div>
        <TerminalDrawer
          command={terminalCommand}
          error={terminalError}
          project={activeProject}
          terminal={terminal}
          onClear={onClearTerminal}
          onCommandChange={onTerminalCommandChange}
          onKill={onKillTerminal}
          onRun={onRunTerminalCommand}
        />
      </section>
    </main>
  );
}
