import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { toast } from 'sonner';
import { ChatDisplay } from '@/components/app-shell/ChatDisplay';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { useAppShellContext } from '@/context/AppShellContext';
import {
  isSessionsNavigation,
  useNavigation,
  useNavigationState,
} from '@/contexts/NavigationContext';
import {
  newSessionDraftAtom,
  NEW_SESSION_DRAFT_ID,
} from '@/atoms/new-session-draft';
import { defaultSessionOptions } from '@/hooks/useSessionOptions';
import { resolveEffectiveConnectionSlug } from '@config/llm-connections';
import { getWorkspaceDisplayName } from '@/utils/workspace';
import { qwenCapabilitiesFromSkills } from '@/lib/qwen-capability-cache';
import { contentBadgesToTextElements } from '@craft-agent/core/utils';
import type {
  CreateSessionOptions,
  FileAttachment,
  Message,
  PermissionMode,
  Session,
  WorkspaceSettings,
} from '../../shared/types';
import { generateMessageId } from '../../shared/types';
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';

export default function DraftChatPage() {
  const { t } = useTranslation();
  const navState = useNavigationState();
  const { navigateToSession } = useNavigation();
  const [draft, setDraft] = useAtom(newSessionDraftAtom);
  const {
    activeWorkspaceId,
    workspaces,
    llmConnections,
    workspaceDefaultLlmConnection,
    onOptimisticDefaultModelChange,
    onCreateSession,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    enabledSources,
    skills,
    getQwenCapabilitySnapshot,
    labels,
    enabledModes,
    globalPermissionMode,
    onSessionOptionsChange,
    leadingAction,
    isCompactMode,
  } = useAppShellContext();

  const activeWorkspace = React.useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
      null,
    [activeWorkspaceId, workspaces],
  );
  const activeWorkspaceName = React.useMemo(
    () => (activeWorkspace ? getWorkspaceDisplayName(activeWorkspace, t) : ''),
    [activeWorkspace, t],
  );
  const [workspaceSettings, setWorkspaceSettings] =
    React.useState<WorkspaceSettings | null>(null);

  React.useEffect(() => {
    if (!activeWorkspaceId) {
      setWorkspaceSettings(null);
      return;
    }

    let cancelled = false;
    window.electronAPI
      .getWorkspaceSettings(activeWorkspaceId)
      .then((settings) => {
        if (!cancelled) setWorkspaceSettings(settings);
      })
      .catch((error) => {
        window.electronAPI.debugLog(
          '[DraftChatPage] Failed to load workspace settings:',
          error,
        );
        if (!cancelled) setWorkspaceSettings(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const filterStatus =
    isSessionsNavigation(navState) && navState.filter.kind === 'state'
      ? navState.filter.stateId
      : undefined;
  const filterLabel =
    isSessionsNavigation(navState) &&
    navState.filter.kind === 'label' &&
    navState.filter.labelId !== '__all__'
      ? navState.filter.labelId
      : undefined;

  const [inputValue, setInputValue] = React.useState(draft.input);
  const [attachmentsValue, setAttachmentsValue] = React.useState<
    FileAttachment[]
  >([]);
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(
    draft.createOptions.permissionMode ?? globalPermissionMode,
  );
  const [thinkingLevel, setThinkingLevel] = React.useState<ThinkingLevel>(
    draft.createOptions.thinkingLevel ??
      workspaceSettings?.thinkingLevel ??
      defaultSessionOptions.thinkingLevel,
  );
  const [model, setModel] = React.useState<string | undefined>(
    draft.createOptions.model,
  );
  const [llmConnection, setLlmConnection] = React.useState<string | undefined>(
    draft.createOptions.llmConnection,
  );
  const [workingDirectory, setWorkingDirectory] = React.useState<
    string | undefined
  >(
    typeof draft.createOptions.workingDirectory === 'string' &&
      draft.createOptions.workingDirectory !== 'user_default' &&
      draft.createOptions.workingDirectory !== 'none'
      ? draft.createOptions.workingDirectory
      : workspaceSettings?.workingDirectory,
  );
  const [enabledSourceSlugs, setEnabledSourceSlugs] = React.useState<
    string[] | undefined
  >(
    draft.createOptions.enabledSourceSlugs ??
      workspaceSettings?.enabledSourceSlugs,
  );
  const [sessionStatus, setSessionStatus] = React.useState<string>(
    draft.createOptions.sessionStatus ?? filterStatus ?? 'todo',
  );
  const [sessionLabels, setSessionLabels] = React.useState<string[]>(
    draft.createOptions.labels ?? (filterLabel ? [filterLabel] : []),
  );
  const [permissionModeTouched, setPermissionModeTouched] =
    React.useState(false);
  const [thinkingLevelTouched, setThinkingLevelTouched] = React.useState(false);
  const [workingDirectoryTouched, setWorkingDirectoryTouched] =
    React.useState(false);
  const [sourcesTouched, setSourcesTouched] = React.useState(false);
  const [sessionStatusTouched, setSessionStatusTouched] = React.useState(false);
  const [labelsTouched, setLabelsTouched] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [optimisticMessage, setOptimisticMessage] =
    React.useState<Message | null>(null);
  const appliedDraftResetKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const resetKey = `${draft.nonce}:${filterStatus ?? ''}:${filterLabel ?? ''}`;
    if (appliedDraftResetKeyRef.current === resetKey) return;
    appliedDraftResetKeyRef.current = resetKey;

    setInputValue(draft.input);
    setAttachmentsValue([]);
    setPermissionMode(
      draft.createOptions.permissionMode ?? globalPermissionMode,
    );
    setThinkingLevel(
      draft.createOptions.thinkingLevel ?? defaultSessionOptions.thinkingLevel,
    );
    setModel(draft.createOptions.model);
    setLlmConnection(draft.createOptions.llmConnection);
    setWorkingDirectory(
      typeof draft.createOptions.workingDirectory === 'string' &&
        draft.createOptions.workingDirectory !== 'user_default' &&
        draft.createOptions.workingDirectory !== 'none'
        ? draft.createOptions.workingDirectory
        : undefined,
    );
    setEnabledSourceSlugs(draft.createOptions.enabledSourceSlugs);
    setSessionStatus(
      draft.createOptions.sessionStatus ?? filterStatus ?? 'todo',
    );
    setSessionLabels(
      draft.createOptions.labels ?? (filterLabel ? [filterLabel] : []),
    );
    setPermissionModeTouched(false);
    setThinkingLevelTouched(false);
    setWorkingDirectoryTouched(false);
    setSourcesTouched(false);
    setSessionStatusTouched(false);
    setLabelsTouched(false);
    setOptimisticMessage(null);
  }, [
    draft.nonce,
    draft.input,
    draft.createOptions,
    filterStatus,
    filterLabel,
    globalPermissionMode,
  ]);

  const handleInputChange = React.useCallback(
    (nextValue: string) => {
      setInputValue(nextValue);
      setDraft((previous) => {
        if (previous.input === nextValue) return previous;
        return {
          ...previous,
          input: nextValue,
        };
      });
    },
    [setDraft],
  );

  React.useEffect(() => {
    if (
      draft.createOptions.permissionMode === undefined &&
      !permissionModeTouched
    ) {
      setPermissionMode(globalPermissionMode);
    }
    if (
      draft.createOptions.thinkingLevel === undefined &&
      !thinkingLevelTouched
    ) {
      setThinkingLevel(
        workspaceSettings?.thinkingLevel ?? defaultSessionOptions.thinkingLevel,
      );
    }
    if (
      draft.createOptions.workingDirectory === undefined &&
      !workingDirectoryTouched
    ) {
      setWorkingDirectory(workspaceSettings?.workingDirectory);
    }
    if (
      draft.createOptions.enabledSourceSlugs === undefined &&
      !sourcesTouched
    ) {
      setEnabledSourceSlugs(workspaceSettings?.enabledSourceSlugs);
    }
  }, [
    workspaceSettings,
    draft.createOptions,
    permissionModeTouched,
    globalPermissionMode,
    thinkingLevelTouched,
    workingDirectoryTouched,
    sourcesTouched,
  ]);

  const effectiveConnectionSlug = React.useMemo(
    () =>
      resolveEffectiveConnectionSlug(
        llmConnection,
        workspaceDefaultLlmConnection,
        llmConnections,
      ),
    [llmConnection, workspaceDefaultLlmConnection, llmConnections],
  );

  const effectiveConnection = React.useMemo(
    () =>
      effectiveConnectionSlug
        ? llmConnections.find(
            (candidate) => candidate.slug === effectiveConnectionSlug,
          )
        : null,
    [effectiveConnectionSlug, llmConnections],
  );

  const qwenCapabilitySnapshot = getQwenCapabilitySnapshot?.(
    activeWorkspaceId,
    workingDirectory,
    effectiveConnectionSlug,
  );
  const fallbackQwenCapabilitySnapshot = React.useMemo(
    () =>
      effectiveConnection?.providerType === 'qwen'
        ? qwenCapabilitiesFromSkills(skills ?? [])
        : undefined,
    [effectiveConnection?.providerType, skills],
  );
  const draftQwenCapabilitySnapshot =
    qwenCapabilitySnapshot ?? fallbackQwenCapabilitySnapshot;

  const currentModel = React.useMemo(() => {
    if (model) return model;
    return effectiveConnection?.defaultModel ?? '';
  }, [model, effectiveConnection]);

  const draftSession = React.useMemo<Session>(
    () => ({
      id: NEW_SESSION_DRAFT_ID,
      workspaceId: activeWorkspaceId ?? '',
      workspaceName: activeWorkspaceName,
      lastMessageAt: optimisticMessage?.timestamp ?? 0,
      lastMessageRole: optimisticMessage ? 'user' : undefined,
      messages: optimisticMessage ? [optimisticMessage] : [],
      isProcessing: isCreating,
      permissionMode,
      thinkingLevel,
      model,
      llmConnection,
      workingDirectory,
      enabledSourceSlugs,
      sessionStatus,
      labels: sessionLabels,
      ...(draftQwenCapabilitySnapshot
        ? {
            availableCommands: draftQwenCapabilitySnapshot.availableCommands,
            availableSkills: draftQwenCapabilitySnapshot.availableSkills ?? [],
            availableSkillDetails:
              draftQwenCapabilitySnapshot.availableSkillDetails,
          }
        : {}),
    }),
    [
      activeWorkspaceId,
      activeWorkspaceName,
      optimisticMessage,
      isCreating,
      permissionMode,
      thinkingLevel,
      model,
      llmConnection,
      workingDirectory,
      enabledSourceSlugs,
      sessionStatus,
      sessionLabels,
      draftQwenCapabilitySnapshot,
    ],
  );

  const handleSendMessage = React.useCallback(
    async (
      message: string,
      attachments?: FileAttachment[],
      skillSlugs?: string[],
    ) => {
      if (!activeWorkspaceId || isCreating) return;

      const textElements = draft.badges?.length
        ? contentBadgesToTextElements(message, draft.badges)
        : undefined;
      setOptimisticMessage({
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        ...(textElements ? { textElements } : {}),
        isPending: true,
      });
      setInputValue('');
      setAttachmentsValue([]);
      setDraft((previous) =>
        previous.input === ''
          ? previous
          : {
              ...previous,
              input: '',
            },
      );
      setIsCreating(true);
      try {
        const slugHint =
          draft.createOptions.name ??
          (message.trim() || attachments?.[0]?.name);
        const createOptions: CreateSessionOptions = {
          ...draft.createOptions,
          slugHint,
        };
        if (
          draft.createOptions.permissionMode !== undefined ||
          permissionModeTouched
        ) {
          createOptions.permissionMode = permissionMode;
        }
        if (
          draft.createOptions.thinkingLevel !== undefined ||
          thinkingLevelTouched
        ) {
          createOptions.thinkingLevel = thinkingLevel;
        }
        if (model) createOptions.model = model;
        if (llmConnection) createOptions.llmConnection = llmConnection;
        if (
          draft.createOptions.workingDirectory !== undefined ||
          workingDirectoryTouched
        ) {
          createOptions.workingDirectory = workingDirectoryTouched
            ? workingDirectory
            : draft.createOptions.workingDirectory;
        }
        if (
          draft.createOptions.enabledSourceSlugs !== undefined ||
          sourcesTouched
        ) {
          createOptions.enabledSourceSlugs = enabledSourceSlugs;
        }
        if (
          draft.createOptions.sessionStatus !== undefined ||
          filterStatus ||
          sessionStatusTouched
        ) {
          createOptions.sessionStatus = sessionStatus;
        }
        if (
          draft.createOptions.labels !== undefined ||
          filterLabel ||
          labelsTouched
        ) {
          createOptions.labels = sessionLabels;
        }

        const session = await onCreateSession(activeWorkspaceId, createOptions);
        setDraft((previous) => ({
          nonce: previous.nonce + 1,
          input: '',
          createOptions: {},
        }));
        navigateToSession(session.id);
        onSendMessage(
          session.id,
          message,
          attachments,
          skillSlugs,
          draft.badges,
        );
      } catch (error) {
        window.electronAPI.debugLog(
          '[DraftChatPage] Failed to create session from draft:',
          error,
        );
        toast.error(t('toast.unknownError'));
        setOptimisticMessage(null);
        setInputValue(message);
        setDraft((previous) => ({
          ...previous,
          input: message,
        }));
        setAttachmentsValue(attachments ?? []);
      } finally {
        setIsCreating(false);
      }
    },
    [
      activeWorkspaceId,
      isCreating,
      draft.createOptions,
      draft.badges,
      permissionMode,
      thinkingLevel,
      model,
      llmConnection,
      workingDirectory,
      enabledSourceSlugs,
      sessionStatus,
      sessionLabels,
      filterStatus,
      filterLabel,
      permissionModeTouched,
      thinkingLevelTouched,
      workingDirectoryTouched,
      sourcesTouched,
      sessionStatusTouched,
      labelsTouched,
      onCreateSession,
      setDraft,
      navigateToSession,
      onSendMessage,
      t,
    ],
  );

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('session.newSession')}
        leadingAction={leadingAction}
      />
      <div className="flex-1 flex flex-col min-h-0">
        <ChatDisplay
          session={draftSession}
          onSendMessage={handleSendMessage}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          currentModel={currentModel}
          onModelChange={(nextModel, connection) => {
            const nextConnection =
              connection ??
              llmConnection ??
              resolveEffectiveConnectionSlug(
                llmConnection,
                workspaceDefaultLlmConnection,
                llmConnections,
              );

            setModel(nextModel);
            if (nextConnection) {
              setLlmConnection(nextConnection);
              onOptimisticDefaultModelChange(nextModel, nextConnection);
            } else {
              onOptimisticDefaultModelChange(nextModel);
            }
            if (activeWorkspaceId) {
              window.electronAPI
                .setSessionModel(
                  NEW_SESSION_DRAFT_ID,
                  activeWorkspaceId,
                  nextModel,
                  nextConnection,
                )
                .catch((error) => {
                  window.electronAPI.debugLog(
                    '[DraftChatPage] Failed to persist draft model selection:',
                    error,
                  );
                });
            }
          }}
          onConnectionChange={setLlmConnection}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={(nextLevel) => {
            setThinkingLevel(nextLevel);
            setThinkingLevelTouched(true);
          }}
          permissionMode={permissionMode}
          onPermissionModeChange={(nextMode) => {
            setPermissionMode(nextMode);
            setPermissionModeTouched(true);
            onSessionOptionsChange(NEW_SESSION_DRAFT_ID, {
              permissionMode: nextMode,
            });
          }}
          enabledModes={enabledModes}
          inputValue={inputValue}
          onInputChange={handleInputChange}
          attachmentsValue={attachmentsValue}
          onAttachmentsChange={setAttachmentsValue}
          sources={enabledSources}
          onSourcesChange={(nextSlugs) => {
            setEnabledSourceSlugs(nextSlugs);
            setSourcesTouched(true);
          }}
          skills={skills}
          labels={labels}
          onLabelsChange={(nextLabels) => {
            setSessionLabels(nextLabels);
            setLabelsTouched(true);
          }}
          sessionStatuses={[]}
          workspaceId={activeWorkspaceId || undefined}
          workingDirectory={workingDirectory}
          onWorkingDirectoryChange={(nextWorkingDirectory) => {
            setWorkingDirectory(nextWorkingDirectory);
            setWorkingDirectoryTouched(true);
          }}
          disableSend={isCreating}
          compactMode={!!isCompactMode}
        />
      </div>
    </div>
  );
}
