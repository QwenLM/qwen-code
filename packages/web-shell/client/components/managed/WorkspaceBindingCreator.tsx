import {
  isManagedSessionSkills,
  type ManagedCreationSkillsSource,
} from './managed-creation-skills';
import { useManagedFileReferences } from './use-managed-file-references';
import { useManagedSkills } from './use-managed-skills';
import type { ComposerSubmitMetadata } from '../../hooks/useComposerCore';
import { useCallback, useEffect, useRef, useState } from 'react';
import shellStyles from '../../App.module.css';
import { useI18n } from '../../i18n';
import { ChatEditor } from '../ChatEditor';
import type { WorkspaceSelectorOption } from '../WorkspaceSelector';
import { HostLabel } from '../workspaces/HostLabel';
import { WelcomeHeader } from '../WelcomeHeader';
import { AddWorkspaceDialog } from '../dialogs/AddWorkspaceDialog';
import { WorkspaceExecutionSelect } from '../workspaces/WorkspaceExecutionSelect';
import type {
  ComposerSubmitCommit,
  EditorHandle,
} from '../../hooks/useComposerCore';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentWorkspace,
  ManagedApprovalMode,
  ManagedSessionOptions,
  ManagedInputBlock,
  ManagedSessionSkill,
} from './managed-agent-provider';
import type { PromptImage, PromptFile } from '../../adapters/promptTypes';
import {
  encodeManagedInput,
  isManagedInput,
  managedInputText,
  restoreManagedAttachments,
} from './managed-input';
import {
  readManagedPending,
  saveManagedPending,
} from './managed-pending-storage';
import { isManagedApprovalMode } from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';
import { RemoteWorkspaceRegistration } from './RemoteWorkspaceRegistration';

interface PendingCreation {
  agentId: string;
  workspaceId: string;
  cwdRelative: string;
  input: ManagedInputBlock[];
  clientId: string;
  idempotencyKey: string;
  sessionId?: string;
  approvalMode?: ManagedApprovalMode;
  planMode?: boolean;
  skills?: ManagedSessionSkill[];
}

interface PendingWorkspace {
  displayName: string;
  idempotencyKey: string;
  sourceWorkspaceId?: string;
  cwdRelative?: string;
  localPath?: string;
}

function validWorkspaceName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/\p{Cc}/u.test(value);
}

function readPendingWorkspace(key: string): PendingWorkspace | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || !value) return undefined;
    const item = value as Record<string, unknown>;
    if (
      typeof item['displayName'] === 'string' &&
      item['displayName'] === item['displayName'].trim() &&
      validWorkspaceName(item['displayName']) &&
      typeof item['idempotencyKey'] === 'string' &&
      item['idempotencyKey'].length > 0 &&
      item['idempotencyKey'].length <= 128 &&
      ((item['sourceWorkspaceId'] === undefined &&
        item['cwdRelative'] === undefined) ||
        (typeof item['sourceWorkspaceId'] === 'string' &&
          typeof item['cwdRelative'] === 'string')) &&
      (item['localPath'] === undefined ||
        (typeof item['localPath'] === 'string' &&
          item['localPath'].startsWith('/') &&
          item['sourceWorkspaceId'] === undefined &&
          item['cwdRelative'] === undefined)) &&
      !('nodeId' in item) &&
      !('path' in item) &&
      !('operationId' in item)
    ) {
      return {
        displayName: item['displayName'],
        idempotencyKey: item['idempotencyKey'],
        sourceWorkspaceId: item['sourceWorkspaceId'] as string | undefined,
        cwdRelative: item['cwdRelative'] as string | undefined,
        localPath: item['localPath'] as string | undefined,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readPending(
  key: string,
  restored?: unknown,
): PendingCreation | undefined {
  try {
    const value: unknown =
      restored ?? JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || !value) return undefined;
    const item = value as Record<string, unknown>;
    const input = item['input'];
    if (
      typeof item['agentId'] !== 'string' ||
      typeof item['workspaceId'] !== 'string' ||
      typeof item['cwdRelative'] !== 'string' ||
      typeof item['clientId'] !== 'string' ||
      typeof item['idempotencyKey'] !== 'string' ||
      (item['approvalMode'] !== undefined &&
        !isManagedApprovalMode(item['approvalMode'])) ||
      (item['planMode'] !== undefined &&
        typeof item['planMode'] !== 'boolean') ||
      (item['skills'] !== undefined &&
        !isManagedSessionSkills(item['skills'])) ||
      !isManagedInput(input) ||
      (item['sessionId'] !== undefined && typeof item['sessionId'] !== 'string')
    )
      return undefined;
    return value as PendingCreation;
  } catch {
    return undefined;
  }
}

async function savePending(
  key: string,
  value?: PendingCreation,
): Promise<boolean> {
  return saveManagedPending(key, value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceBindingCreator({
  provider,
  workspaceCreationOpen,
  onWorkspaceCreationOpenChange,
  onOpenLocalWorkspace,
  daemonWorkspaces,
  onSelectDaemonWorkspace,
  creationOnly = false,
  clientId,
  onCreated,
  onAbandoned,
  workspaceId,
  onSelectWorkspace,
  onWorkspaceCreated,
  interactive = true,
  creationSkills,
  onManageSkills,
}: {
  provider: ManagedAgentProvider;
  workspaceCreationOpen?: boolean;
  onWorkspaceCreationOpenChange?: (open: boolean) => void;
  onOpenLocalWorkspace?: () => void;
  daemonWorkspaces?: WorkspaceSelectorOption[];
  onSelectDaemonWorkspace?: (workspace: WorkspaceSelectorOption) => void;
  creationOnly?: boolean;
  clientId: string;
  onCreated: (sessionId: string, workspaceId: string) => void;
  onAbandoned?: () => void;
  workspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onWorkspaceCreated?: (workspaceId: string) => void;
  interactive?: boolean;
  creationSkills?: ManagedCreationSkillsSource;
  onManageSkills?: () => void;
}) {
  const { t } = useI18n();
  const binding = provider.workspaceBinding!;
  const pendingKey = `qwen-managed-workspace-create:${provider.storageKey}`;
  const [pending, setPending] = useState(() => readPending(pendingKey));
  const pendingRef = useRef(pending);
  const workspacePendingKey = `qwen-managed-workspace-registration:${provider.storageKey}`;
  const [pendingWorkspace, setPendingWorkspace] = useState(() =>
    readPendingWorkspace(workspacePendingKey),
  );
  const pendingWorkspaceRef = useRef(pendingWorkspace);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(
    Boolean(pendingWorkspace),
  );
  const [workspaceName, setWorkspaceName] = useState(
    pendingWorkspace?.displayName ?? '',
  );
  const [workspaceCreating, setWorkspaceCreating] = useState(false);
  const workspaceCreatingRef = useRef(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [canCreateWorkspace, setCanCreateWorkspace] = useState(false);
  const [canSelectDirectory, setCanSelectDirectory] = useState(false);
  const [canImportLocalDirectory, setCanImportLocalDirectory] = useState(false);
  const [directorySource, setDirectorySource] = useState('');
  const [directoryPicker, setDirectoryPicker] = useState<{
    workspaceId?: string;
    root: string;
  }>();
  const [supportsApprovalModeSelection, setSupportsApprovalModeSelection] =
    useState(false);
  const [sessionOptions, setSessionOptions] = useState<
    ManagedSessionOptions & { agentId: string }
  >();
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string>();
  const [optionsRevision, setOptionsRevision] = useState(0);
  const [planMode, setPlanMode] = useState(false);
  const skillsSourceRef = useRef(creationSkills);
  skillsSourceRef.current = creationSkills;
  const encoding = useRef(false);
  const [items, setItems] = useState<ManagedAgentWorkspace[]>([]);
  const selectionKey = `qwen-managed-workspace-selection:${provider.storageKey}`;
  const [selected, setSelected] = useState(() => {
    if (workspaceId) return workspaceId;
    try {
      return sessionStorage.getItem(selectionKey) ?? '';
    } catch {
      return '';
    }
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const requestedWorkspaceRef = useRef(workspaceId);
  requestedWorkspaceRef.current = workspaceId;
  const handledWorkspaceRequest = useRef(workspaceId);
  const [selectingWorkspace, setSelectingWorkspace] = useState(false);
  const workspaceSelectionBlocked =
    selectingWorkspace ||
    Boolean(workspaceId && handledWorkspaceRequest.current !== workspaceId);
  const [cwdRelative, setCwdRelative] = useState('.');
  const [cwdDraft, setCwdDraft] = useState<string>();
  const cwdEdited = useRef(false);
  const modelPresets = binding.modelPresets ?? [];
  const [agentId, setAgentId] = useState(
    modelPresets.find((item) => item.agentId === binding.agentId)?.agentId ??
      modelPresets[0]?.agentId ??
      binding.agentId,
  );
  const availableModels =
    modelPresets.length > 0
      ? modelPresets
      : [{ agentId: binding.agentId, label: t('managed.modelDefault') }];
  const [nextCursor, setNextCursor] = useState<string>();
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(true);
  const [pendingRestoreFailed, setPendingRestoreFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [pathError, setPathError] = useState<string>();
  const [switchTo, setSwitchTo] = useState<string>();
  const [registrationAvailable, setRegistrationAvailable] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const editor = useRef<EditorHandle | null>(null);
  const acceptedCommit = useRef<ComposerSubmitCommit | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // Commands must survive list reloads during same-identity credential refreshes.
  const commandLifetime = useRef<AbortController | undefined>(undefined);
  const creationInteractive =
    Boolean(workspaceCreationOpen) || (interactive && !creationOnly);

  useEffect(() => {
    if (workspaceCreationOpen) {
      setWorkspaceDialogOpen(true);
    }
  }, [workspaceCreationOpen]);

  function openLocalWorkspace() {
    if (busy || workspaceCreatingRef.current || pendingWorkspaceRef.current)
      return;
    setDirectoryPicker(undefined);
    setWorkspaceDialogOpen(false);
    onWorkspaceCreationOpenChange?.(false);
    onOpenLocalWorkspace?.();
  }

  useEffect(() => {
    const abort = new AbortController();
    commandLifetime.current = abort;
    setPendingRestoreFailed(false);
    setBusy(true);
    void readManagedPending(pendingKey).then(
      (value) => {
        if (abort.signal.aborted) return;
        const saved = readPending(pendingKey, value);
        pendingRef.current = saved;
        setPending(saved);
        setBusy(false);
      },
      () => {
        if (!abort.signal.aborted) setPendingRestoreFailed(true);
      },
    );
    return () => abort.abort();
  }, [pendingKey]);

  useEffect(() => {
    try {
      sessionStorage.setItem(selectionKey, selected);
    } catch {
      /* Selection is advisory. */
    }
  }, [selectionKey, selected]);

  async function updatePending(value?: PendingCreation) {
    const abort = commandLifetime.current;
    pendingRef.current = value;
    setPending(value);
    if (!(await savePending(pendingKey, value)) && !abort?.signal.aborted)
      setError(t('managed.workspaceStorageUnavailable'));
  }

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const page = await binding.list({
          clientId,
          limit: 50,
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setSupported(page.supported);
        setCanCreateWorkspace(page.canCreateWorkspace === true);
        setCanSelectDirectory(page.canSelectDirectory === true);
        setCanImportLocalDirectory(page.canImportLocalDirectory === true);
        setSupportsApprovalModeSelection(
          page.supportsApprovalModeSelection === true,
        );
        setItems([
          ...new Map(
            [
              ...page.data,
              ...(page.defaultWorkspace ? [page.defaultWorkspace] : []),
            ].map((item) => [item.workspaceId, item]),
          ).values(),
        ]);
        setNextCursor(page.nextCursor);
        const previous = selectedRef.current;
        const explicit = previous === requestedWorkspaceRef.current;
        if (previous) {
          try {
            const retained = await binding.get(previous, {
              clientId,
              signal: abort.signal,
            });
            if (abort.signal.aborted) return;
            if (retained.workspaceId !== previous)
              throw new Error(t('managed.workspaceLoadFailed'));
            if (!cwdEdited.current)
              setCwdRelative(retained.defaultCwdRelative ?? '.');
            setItems((current) => [
              ...new Map(
                [...current, retained].map((item) => [item.workspaceId, item]),
              ).values(),
            ]);
            if (!retained.canCreateSession) {
              if (explicit) {
                setError(t('managed.workspacePermission'));
                return;
              }
              setSelected(
                page.defaultWorkspace?.workspaceId !== previous
                  ? (page.defaultWorkspace?.workspaceId ?? '')
                  : '',
              );
              setCwdRelative(page.defaultWorkspace?.defaultCwdRelative ?? '.');
            }
          } catch (failure) {
            if (abort.signal.aborted) return;
            if (explicit) {
              setItems((current) =>
                current.filter((item) => item.workspaceId !== previous),
              );
              setError(
                `${t('managed.workspaceLoadFailed')} ${message(failure)}`,
              );
              return;
            }
            if (
              failure instanceof JavaManagedAgentHttpError &&
              failure.status === 404
            ) {
              setItems((current) =>
                current.filter((item) => item.workspaceId !== previous),
              );
              setSelected(
                page.defaultWorkspace?.workspaceId !== previous
                  ? (page.defaultWorkspace?.workspaceId ?? '')
                  : '',
              );
              setCwdRelative(page.defaultWorkspace?.defaultCwdRelative ?? '.');
            } else {
              setError(
                `${t('managed.workspaceLoadFailed')} ${message(failure)}`,
              );
            }
          }
        } else {
          setSelected(page.defaultWorkspace?.workspaceId ?? '');
          setCwdRelative(page.defaultWorkspace?.defaultCwdRelative ?? '.');
        }
      } catch (failure) {
        if (abort.signal.aborted) return;
        setSupported(false);
        setCanCreateWorkspace(false);
        setCanSelectDirectory(false);
        setCanImportLocalDirectory(false);
        setSupportsApprovalModeSelection(false);
        setError(
          failure instanceof JavaManagedAgentHttpError && failure.status === 404
            ? t('managed.workspaceUnsupported')
            : failure instanceof JavaManagedAgentHttpError &&
                (failure.status === 401 || failure.status === 403)
              ? t('managed.workspacePermission')
              : `${t('managed.workspaceLoadFailed')} ${message(failure)}`,
        );
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [binding, clientId, revision, t]);

  useEffect(() => {
    const abort = new AbortController();
    if (!supportsApprovalModeSelection) {
      setSessionOptions(undefined);
      setOptionsError(undefined);
      setOptionsLoading(false);
      return () => abort.abort();
    }
    setOptionsLoading(true);
    setOptionsError(undefined);
    void (async () => {
      try {
        if (!binding.getSessionOptions)
          throw new Error(t('managed.approvalOptionsInvalid'));
        const options = await binding.getSessionOptions(agentId, {
          clientId,
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        if (
          !isManagedApprovalMode(options.approvalMode) ||
          !Array.isArray(options.availableApprovalModes) ||
          !options.availableApprovalModes.every(isManagedApprovalMode) ||
          !options.availableApprovalModes.includes(options.approvalMode)
        ) {
          throw new Error(t('managed.approvalOptionsInvalid'));
        }
        setSessionOptions((current) => ({
          ...options,
          agentId,
          approvalMode:
            current?.agentId === agentId &&
            options.availableApprovalModes.includes(current.approvalMode)
              ? current.approvalMode
              : options.approvalMode,
        }));
      } catch (failure) {
        if (abort.signal.aborted) return;
        setSessionOptions(undefined);
        setOptionsError(
          `${t('managed.approvalOptionsLoadFailed')} ${message(failure)}`,
        );
      } finally {
        if (!abort.signal.aborted) setOptionsLoading(false);
      }
    })();
    return () => abort.abort();
  }, [
    binding,
    clientId,
    agentId,
    supportsApprovalModeSelection,
    optionsRevision,
    t,
  ]);

  const currentOptions =
    sessionOptions?.agentId === agentId ? sessionOptions : undefined;
  const supportedSkillsSource = currentOptions?.skillsSupported
    ? creationSkills
    : undefined;
  const skills = useManagedSkills(
    provider,
    clientId,
    undefined,
    supportedSkillsSource,
  );
  const fileReferences = useManagedFileReferences(
    provider,
    clientId,
    currentOptions?.inputAttachments
      ? { workspaceId: selected, cwdRelative }
      : undefined,
  );
  const approvalReady =
    !supportsApprovalModeSelection ||
    (!optionsLoading && Boolean(currentOptions));
  const displayedApprovalMode = pending
    ? pending.approvalMode
    : supportsApprovalModeSelection
      ? currentOptions?.approvalMode
      : undefined;

  async function loadMore() {
    const abort = lifetime.current;
    if (!abort || abort.signal.aborted || !nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await binding.list({
        clientId,
        cursor: nextCursor,
        limit: 50,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setSupported(page.supported);
      setCanCreateWorkspace(page.canCreateWorkspace === true);
      setSupportsApprovalModeSelection(
        page.supportsApprovalModeSelection === true,
      );
      setItems((current) => [
        ...new Map(
          [...current, ...page.data].map((item) => [item.workspaceId, item]),
        ).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (failure) {
      if (!abort.signal.aborted) setError(message(failure));
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }

  async function createOrRead(
    text?: string,
    commit?: ComposerSubmitCommit,
    images?: PromptImage[],
    files?: PromptFile[],
    metadata?: ComposerSubmitMetadata,
  ) {
    const abort = commandLifetime.current;
    if (
      creationOnly ||
      !abort ||
      abort.signal.aborted ||
      busy ||
      encoding.current ||
      workspaceCreatingRef.current
    )
      return;
    let attempt = pendingRef.current;
    if (
      attempt?.approvalMode !== undefined &&
      !attempt.sessionId &&
      !supportsApprovalModeSelection
    )
      return;
    const firstSubmission = !attempt;
    if (!attempt) {
      if (
        loading ||
        workspaceSelectionBlocked ||
        switchTo ||
        (requestedWorkspaceRef.current &&
          handledWorkspaceRequest.current !== requestedWorkspaceRef.current)
      )
        return;
      if (
        text !== undefined &&
        !text.trim() &&
        !images?.length &&
        !files?.length
      )
        return;
      if (!approvalReady) return;
      if (
        !supported ||
        !availableModels.some((item) => item.agentId === agentId) ||
        !items.find(
          (item) => item.workspaceId === selected && item.canCreateSession,
        )
      ) {
        if (text !== undefined) setError(t('managed.workspaceChoose'));
        return;
      }
      let input: ManagedInputBlock[] = [];
      let skills: ManagedSessionSkill[] = [];
      const source = supportedSkillsSource;
      encoding.current = true;
      setBusy(true);
      try {
        if (source) {
          skills = await source.load(abort.signal);
          if (source !== skillsSourceRef.current)
            throw new Error(t('managed.creationSkillsSourceChanged'));
          if (!isManagedSessionSkills(skills))
            throw new Error(t('managed.creationSkillsUnavailable'));
        }
        if (text !== undefined) {
          const prepared = await fileReferences.prepareInput(
            text,
            files,
            metadata,
          );
          input = await encodeManagedInput(
            prepared.text,
            images,
            prepared.files,
          );
          fileReferences.assertCurrent();
        }
      } catch (failure) {
        setError(message(failure));
        return;
      } finally {
        encoding.current = false;
        setBusy(false);
      }
      if (abort.signal.aborted) return;
      if (source && source !== skillsSourceRef.current) {
        setError(t('managed.creationSkillsSourceChanged'));
        return;
      }
      attempt = {
        agentId,
        workspaceId: selected,
        cwdRelative,
        input,
        clientId,
        idempotencyKey: managedRequestId(),
        ...(skills.length ? { skills: structuredClone(skills) } : {}),
        ...(supportsApprovalModeSelection && currentOptions
          ? { approvalMode: currentOptions.approvalMode }
          : {}),
        ...(planMode && currentOptions?.planModeSupported
          ? { planMode: true }
          : {}),
      };
      encoding.current = true;
      setBusy(true);
      const persisted = await savePending(pendingKey, attempt);
      encoding.current = false;
      if (abort.signal.aborted) return;
      if (!persisted) {
        setError(t('managed.workspaceStorageUnavailable'));
        setBusy(false);
        return;
      }
      pendingRef.current = attempt;
      setPending(attempt);
      acceptedCommit.current = commit;
    }
    setBusy(true);
    setError(undefined);
    setPathError(undefined);
    try {
      if (!attempt.sessionId) {
        const request = {
          agentId: attempt.agentId,
          workspaceId: attempt.workspaceId,
          cwdRelative: attempt.cwdRelative,
          ...(attempt.skills?.length ? { skills: attempt.skills } : {}),
          ...(attempt.approvalMode === undefined
            ? {}
            : { approvalMode: attempt.approvalMode }),
          ...(attempt.planMode === undefined
            ? {}
            : { planMode: attempt.planMode }),
        };
        const command = {
          clientId: attempt.clientId,
          idempotencyKey: attempt.idempotencyKey,
          signal: abort.signal,
        };
        const initial = attempt.input.length > 0;
        if (initial && !binding.createSession)
          throw new Error(
            'The provider no longer supports initial Workspace input',
          );
        const admitted = initial
          ? await binding.createSession!(
              {
                ...request,
                text: managedInputText(attempt.input),
                ...(attempt.input.some(
                  (block) =>
                    block.type === 'input_file' || block.type === 'input_image',
                )
                  ? { input: attempt.input }
                  : {}),
              },
              command,
            )
          : await binding.createEmpty(request, command);
        if (abort.signal.aborted) return;
        attempt = { ...attempt, sessionId: admitted.sessionId };
        await updatePending(attempt);
        if (abort.signal.aborted) return;
      }
      const createdSessionId = attempt.sessionId;
      if (!createdSessionId)
        throw new Error('Create response is missing sessionId');
      const session = await provider.getSession(createdSessionId, {
        clientId: attempt.clientId,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (
        session.sessionId !== createdSessionId ||
        (attempt.approvalMode !== undefined &&
          (session.initialApprovalMode ?? session.approvalMode) !==
            attempt.approvalMode) ||
        ((modelPresets.length > 0 || session.agentId !== undefined) &&
          session.agentId !== attempt.agentId) ||
        !session.workspace ||
        session.workspace.workspaceId !== attempt.workspaceId ||
        typeof session.workspace.cwdRelative !== 'string' ||
        !session.workspace.cwdRelative
      ) {
        throw new Error(
          t('managed.workspaceProtocolError', {
            sessionId: createdSessionId,
          }),
        );
      }
      if (attempt.input.length) {
        if (acceptedCommit.current) acceptedCommit.current();
        else editor.current?.clear();
      }
      acceptedCommit.current = undefined;
      await updatePending(undefined);
      if (abort.signal.aborted) return;
      onCreated(createdSessionId, session.workspace.workspaceId);
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (
        attempt.sessionId === undefined &&
        failure instanceof JavaManagedAgentHttpError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 408 &&
        failure.status !== 429 &&
        firstSubmission
      ) {
        await updatePending(undefined);
        if (abort.signal.aborted) return;
        if (failure.code === 'unsupported_approval_mode')
          setOptionsRevision((value) => value + 1);
        if (failure.code === 'invalid_cwd') setPathError(message(failure));
        else setError(message(failure));
      } else {
        await updatePending(attempt);
        if (abort.signal.aborted) return;
        setError(message(failure));
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  const selectWorkspace = useCallback(
    (workspaceId: string, target?: ManagedAgentWorkspace) => {
      selectedRef.current = workspaceId;
      setSelected(workspaceId);
      setCwdRelative(
        (target ?? items.find((item) => item.workspaceId === workspaceId))
          ?.defaultCwdRelative ?? '.',
      );
      cwdEdited.current = false;
      onSelectWorkspace?.(workspaceId);
    },
    [items, onSelectWorkspace],
  );

  const choose = useCallback(
    (workspaceId: string, target?: ManagedAgentWorkspace) => {
      if (!workspaceId) return;
      if (workspaceId === selected) return;
      setError(undefined);
      if (
        cwdRelative !==
        (items.find((item) => item.workspaceId === selected)
          ?.defaultCwdRelative ?? '.')
      )
        setSwitchTo(workspaceId);
      else selectWorkspace(workspaceId, target);
    },
    [selected, cwdRelative, items, selectWorkspace],
  );

  useEffect(() => {
    if (!workspaceId) handledWorkspaceRequest.current = undefined;
    if (!workspaceId || workspaceId === handledWorkspaceRequest.current) {
      setSelectingWorkspace(false);
      return;
    }
    if (!interactive || loading || busy || pending || workspaceCreating) return;
    const abort = new AbortController();
    setSelectingWorkspace(true);
    void binding
      .get(workspaceId, { clientId, signal: abort.signal })
      .then((target) => {
        if (abort.signal.aborted) return;
        if (target.workspaceId !== workspaceId || !target.canCreateSession)
          throw new Error(t('managed.workspacePermission'));
        handledWorkspaceRequest.current = workspaceId;
        setItems((current) => [
          ...current.filter((item) => item.workspaceId !== workspaceId),
          target,
        ]);
        choose(workspaceId, target);
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        handledWorkspaceRequest.current = workspaceId;
        setSelected(workspaceId);
        setItems((current) =>
          current.filter((item) => item.workspaceId !== workspaceId),
        );
        setError(`${t('managed.workspaceLoadFailed')} ${message(failure)}`);
      })
      .finally(() => {
        if (!abort.signal.aborted) setSelectingWorkspace(false);
      });
    return () => abort.abort();
  }, [
    workspaceId,
    interactive,
    loading,
    busy,
    pending,
    workspaceCreating,
    binding,
    clientId,
    choose,
    t,
  ]);

  async function createWorkspace(
    directory?: Omit<PendingWorkspace, 'idempotencyKey'>,
  ) {
    const abort = commandLifetime.current;
    if (
      !creationInteractive ||
      !abort ||
      abort.signal.aborted ||
      !binding.createWorkspace ||
      !((directory ?? pendingWorkspaceRef.current)?.localPath
        ? canImportLocalDirectory
        : (directory ?? pendingWorkspaceRef.current)?.sourceWorkspaceId
          ? canSelectDirectory
          : canCreateWorkspace) ||
      busy ||
      pendingRef.current ||
      workspaceCreatingRef.current
    )
      return;
    let attempt = pendingWorkspaceRef.current;
    const firstSubmission = !attempt;
    if (!attempt) {
      const displayName = (directory?.displayName ?? workspaceName).trim();
      if (!validWorkspaceName(displayName)) {
        setWorkspaceError(t('managed.newWorkspaceNameInvalid'));
        if (directory) throw new Error(t('managed.newWorkspaceNameInvalid'));
        return;
      }
      attempt = {
        ...directory,
        displayName,
        idempotencyKey: managedRequestId(),
      };
      try {
        sessionStorage.setItem(workspacePendingKey, JSON.stringify(attempt));
      } catch {
        setWorkspaceError(t('managed.workspaceStorageUnavailable'));
        if (directory)
          throw new Error(t('managed.workspaceStorageUnavailable'));
        return;
      }
      pendingWorkspaceRef.current = attempt;
      setPendingWorkspace(attempt);
      setWorkspaceName(displayName);
    }
    workspaceCreatingRef.current = true;
    setWorkspaceCreating(true);
    setWorkspaceError(undefined);
    try {
      const created = await binding.createWorkspace(
        {
          displayName: attempt.displayName,
          ...(attempt.localPath ? { localPath: attempt.localPath } : {}),
          ...(attempt.sourceWorkspaceId
            ? {
                sourceWorkspaceId: attempt.sourceWorkspaceId,
                cwdRelative: attempt.cwdRelative,
              }
            : {}),
        },
        {
          clientId,
          idempotencyKey: attempt.idempotencyKey,
          signal: abort.signal,
        },
      );
      if (abort.signal.aborted) return;
      setItems((current) => [
        ...new Map(
          [...current, created].map((item) => [item.workspaceId, item]),
        ).values(),
      ]);
      setSelected(created.workspaceId);
      setCwdRelative(created.defaultCwdRelative ?? '.');
      cwdEdited.current = false;
      pendingWorkspaceRef.current = undefined;
      setPendingWorkspace(undefined);
      try {
        sessionStorage.removeItem(workspacePendingKey);
      } catch {
        // A retained receipt only replays the same completed creation.
      }
      setWorkspaceName('');
      setWorkspaceDialogOpen(false);
      onSelectWorkspace?.(created.workspaceId);
      onWorkspaceCreated?.(created.workspaceId);
      onWorkspaceCreationOpenChange?.(false);
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (
        firstSubmission &&
        failure instanceof JavaManagedAgentHttpError &&
        [
          'invalid_workspace_name',
          'invalid_local_directory',
          'invalid_cwd',
          'invalid_request',
          'invalid_idempotency_key',
          'workspace_creation_unavailable',
        ].includes(failure.code)
      ) {
        try {
          sessionStorage.removeItem(workspacePendingKey);
          pendingWorkspaceRef.current = undefined;
          setPendingWorkspace(undefined);
        } catch {
          // Preserve the frozen operation if local persistence cannot change.
        }
      }
      setWorkspaceError(message(failure));
      if (directory) setWorkspaceDialogOpen(true);
    } finally {
      workspaceCreatingRef.current = false;
      if (!abort.signal.aborted) setWorkspaceCreating(false);
    }
  }

  const directInput = Boolean(binding.createSession);
  const workspaceCreationSupported = Boolean(
    (canCreateWorkspace || canSelectDirectory || canImportLocalDirectory) &&
      binding.createWorkspace,
  );

  async function browseDirectories() {
    if (pendingWorkspaceRef.current) {
      setWorkspaceDialogOpen(true);
      return;
    }
    const workspaceId =
      directorySource ||
      items.find((item) => item.canSelectDirectory)?.workspaceId;
    if ((!workspaceId && !canImportLocalDirectory) || !binding.directories)
      return;
    setWorkspaceError(undefined);
    try {
      const result = await binding.directories(
        canImportLocalDirectory
          ? { localPath: '' }
          : { workspaceId: workspaceId!, cwdRelative: '.' },
        { clientId, signal: commandLifetime.current?.signal },
      );
      if (commandLifetime.current?.signal.aborted) return;
      setDirectoryPicker({
        workspaceId: canImportLocalDirectory ? undefined : workspaceId,
        root: result.root,
      });
      setWorkspaceDialogOpen(false);
    } catch (failure) {
      if (commandLifetime.current?.signal.aborted) return;
      setWorkspaceError(message(failure));
      setWorkspaceDialogOpen(true);
    }
  }

  const suggestDirectories = useCallback(
    async (prefix: string) => {
      const { root, workspaceId } = directoryPicker!;
      const clean = prefix.replace(/\/+$/, '') || '/';
      if (workspaceId && clean !== root && !clean.startsWith(`${root}/`))
        throw new Error(t('managed.workspaceDirectoryScope'));
      const result = await binding.directories!(
        workspaceId
          ? {
              workspaceId,
              cwdRelative: clean.slice(root.length + 1) || '.',
            }
          : { localPath: clean },
        { clientId, signal: commandLifetime.current?.signal },
      );
      return {
        dir: workspaceId ? clean : result.root,
        sep: '/',
        truncated: result.truncated,
        suggestions: result.directories.map((item) => ({
          name: item.name,
          path: `${workspaceId ? root : result.root.replace(/\/$/, '')}/${item.cwdRelative}`,
        })),
      };
    },
    [binding, clientId, directoryPicker, t],
  );

  const sessionCreator = (
    <div
      className={`${directInput ? shellStyles.appChatEmpty : ''} flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2`}
    >
      {!directInput && (
        <h2 className="text-base font-medium">
          {t('managed.workspaceCreateTitle')}
        </h2>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {pendingRestoreFailed && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            {t('managed.pendingRestoreFailed')}
          </p>
          <Button
            variant="outline"
            onClick={async () => {
              const abort = commandLifetime.current;
              if (!abort || abort.signal.aborted) return;
              const discarded = await savePending(pendingKey);
              if (abort.signal.aborted) return;
              if (!discarded) {
                setError(t('managed.pendingDiscardFailed'));
                return;
              }
              pendingRef.current = undefined;
              setPending(undefined);
              setPendingRestoreFailed(false);
              setBusy(false);
              setError(undefined);
            }}
          >
            {t('managed.discard')}
          </Button>
        </div>
      )}
      {directInput && pathError && (
        <p role="alert" className="text-sm text-destructive">
          {pathError}
        </p>
      )}
      {loading && <p role="status">{t('managed.loading')}</p>}
      {supportsApprovalModeSelection && optionsLoading && !pending && (
        <p role="status">{t('managed.approvalOptionsLoading')}</p>
      )}
      {supportsApprovalModeSelection && optionsError && !pending && (
        <div className="flex items-center gap-2 text-sm">
          <p role="alert" className="text-destructive">
            {optionsError}
          </p>
          <Button
            variant="outline"
            disabled={!interactive || optionsLoading}
            onClick={() => setOptionsRevision((value) => value + 1)}
          >
            {t('managed.refresh')}
          </Button>
        </div>
      )}
      {!loading && !supported && !error && (
        <p role="status">{t('managed.workspaceUnsupported')}</p>
      )}
      {!loading && supported && !items.length && !error && (
        <p role="status">{t('managed.workspaceEmpty')}</p>
      )}
      {pendingWorkspace && !workspaceDialogOpen && (
        <Button
          variant="outline"
          disabled={!interactive || busy || Boolean(pending)}
          onClick={() => setWorkspaceDialogOpen(true)}
        >
          {t('managed.newWorkspaceResume')}
        </Button>
      )}
      {(supportedSkillsSource || pending?.skills?.length) && (
        <p className="my-2 text-sm text-muted-foreground">
          {pending?.skills?.length
            ? t('managed.creationSkillsPinned', {
                count: pending.skills.length,
              })
            : t('managed.creationSkillsFromSettings')}
          {onManageSkills && (
            <Button
              type="button"
              variant="link"
              title={supportedSkillsSource?.workspaceCwd}
              onClick={onManageSkills}
            >
              {t('managed.creationSkillsManage')}
            </Button>
          )}
        </p>
      )}
      {pending && !busy ? (
        <div className="space-y-2 text-sm">
          <p>{t('managed.workspaceUncertain')}</p>
          <p>
            {pending.workspaceId} / {pending.cwdRelative}
          </p>
          <p>{pending.agentId}</p>
          {pending.sessionId && (
            <p>
              {t('managed.workspaceSessionId')}: {pending.sessionId}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                (!pending.sessionId &&
                  (loading ||
                    !supported ||
                    (pending.approvalMode !== undefined &&
                      !supportsApprovalModeSelection)))
              }
              onClick={() => void createOrRead()}
            >
              {pending.sessionId
                ? t('managed.workspaceRetryRead')
                : t('managed.retry')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const initial = pending.input;
                void updatePending(undefined);
                acceptedCommit.current = undefined;
                if (initial.length) {
                  editor.current?.setText(managedInputText(initial));
                  restoreManagedAttachments(editor.current, initial);
                }
                onAbandoned?.();
              }}
            >
              {t('managed.workspaceAbandon')}
            </Button>
          </div>
          <p className="text-muted-foreground">
            {t(
              pending.input.length > 0
                ? 'managed.workspaceAbandonInputWarning'
                : 'managed.workspaceAbandonWarning',
            )}
          </p>
        </div>
      ) : !directInput && interactive ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createOrRead();
          }}
        >
          {displayedApprovalMode && (
            <>
              <label htmlFor="managed-approval-select">
                {t('status.mode')}
              </label>
              <Select
                value={displayedApprovalMode}
                disabled={
                  busy ||
                  workspaceCreating ||
                  optionsLoading ||
                  !currentOptions ||
                  currentOptions.availableApprovalModes.length <= 1
                }
                onValueChange={(value) => {
                  if (
                    isManagedApprovalMode(value) &&
                    currentOptions?.availableApprovalModes.includes(value)
                  )
                    setSessionOptions({
                      ...currentOptions,
                      approvalMode: value,
                    });
                }}
              >
                <SelectTrigger id="managed-approval-select" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currentOptions?.availableApprovalModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`mode.label.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          {modelPresets.length > 0 && (
            <>
              <label className="block text-sm" htmlFor="managed-model-select">
                {t('managed.modelPreset')}
              </label>
              <Select
                value={agentId}
                onValueChange={setAgentId}
                disabled={busy}
              >
                <SelectTrigger id="managed-model-select" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((item) => (
                    <SelectItem key={item.agentId} value={item.agentId}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('managed.modelPinned')}
              </p>
            </>
          )}
          <label className="block text-sm" htmlFor="managed-workspace-select">
            {t('managed.workspaceLabel')}
          </label>
          <Select
            value={selected}
            onValueChange={(id) => choose(id)}
            disabled={
              !supported || loading || busy || workspaceSelectionBlocked
            }
          >
            <SelectTrigger id="managed-workspace-select" className="w-full">
              <SelectValue placeholder={t('managed.workspaceChoose')} />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem
                  key={item.workspaceId}
                  value={item.workspaceId}
                  disabled={!item.canCreateSession}
                >
                  {item.displayName} ({item.workspaceId})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {registrationAvailable && binding.registration && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setRegistrationOpen(true)}
            >
              {t('managed.remoteWorkspaceAdd')}
            </Button>
          )}
          {workspaceCreationSupported && (
            <Button
              type="button"
              variant="outline"
              disabled={loading || busy || workspaceCreating}
              onClick={() => setWorkspaceDialogOpen(true)}
            >
              {t('managed.newWorkspaceTitle')}
            </Button>
          )}
          {nextCursor && (
            <Button
              type="button"
              variant="ghost"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {t('managed.more')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRevision((n) => n + 1)}
          >
            {t('managed.refresh')}
          </Button>
          <label className="block text-sm" htmlFor="managed-workspace-cwd">
            {t('managed.workspaceDirectory')}
          </label>
          <Input
            id="managed-workspace-cwd"
            value={cwdRelative}
            onChange={(event) => {
              cwdEdited.current = true;
              setCwdRelative(event.target.value);
              setPathError(undefined);
            }}
            aria-invalid={Boolean(pathError)}
            aria-describedby={
              pathError ? 'managed-workspace-path-error' : undefined
            }
            disabled={!supported || busy}
          />
          {pathError && (
            <p
              id="managed-workspace-path-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {pathError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t('managed.workspaceSharedFiles')}
          </p>
          <Button
            type="submit"
            disabled={
              !supported ||
              loading ||
              workspaceSelectionBlocked ||
              Boolean(switchTo) ||
              !approvalReady ||
              busy ||
              !availableModels.some((item) => item.agentId === agentId) ||
              !items.some(
                (item) =>
                  item.workspaceId === selected && item.canCreateSession,
              )
            }
          >
            {t('managed.workspaceCreate')}
          </Button>
        </form>
      ) : null}
      {directInput && (
        <div className={shellStyles.chatPane} data-managed-standard-chat>
          <div className={shellStyles.content}>
            <WelcomeHeader
              version=""
              cwd=""
              currentModel={agentId}
              currentMode=""
            />
          </div>
          <div className={shellStyles.footer}>
            {fileReferences.error && <p role="alert">{fileReferences.error}</p>}
            <ChatEditor
              ref={editor}
              commands={skills.commands}
              composerScopeKey={`managed:${provider.storageKey}:new`}
              disableLegacyHistoryFallback
              shellModeEnabled={false}
              workspaceFeaturesEnabled={false}
              skills={skills.skills}
              onSkillsOpenChange={
                skills.supported ? skills.onOpenChange : undefined
              }
              skillsLoading={skills.loading}
              skillsLoadError={skills.error}
              skillsLoaded={skills.loaded}
              fileReferenceActions={fileReferences.actions}
              persistFileReferences
              existingFolderWorkspaceSupported={
                registrationAvailable && Boolean(binding.registration)
              }
              onOpenExistingWorkspace={() => {
                if (!busy && !encoding.current && !pendingRef.current)
                  setRegistrationOpen(true);
              }}
              attachmentsEnabled={currentOptions?.inputAttachments === true}
              visibleToolbarActions={
                interactive
                  ? [
                      ...(currentOptions?.inputAttachments ||
                      fileReferences.actions ||
                      skills.supported ||
                      currentOptions?.planModeSupported
                        ? ['addMenu' as const]
                        : []),
                      ...(currentOptions?.planModeSupported
                        ? ['plan' as const]
                        : []),
                      ...(displayedApprovalMode
                        ? ['approvalMode' as const]
                        : []),
                      'model',
                      'workspace',
                    ]
                  : []
              }
              showChatWidthToggle={false}
              contextChipPlacement="below"
              currentModel={pending?.agentId ?? agentId}
              modelControlsDisabled={
                busy || workspaceCreating || Boolean(pending)
              }
              currentMode={displayedApprovalMode ?? ''}
              planMode={
                pending?.planMode ??
                (currentOptions?.planModeSupported === true && planMode)
              }
              onTogglePlan={
                currentOptions?.planModeSupported
                  ? () => {
                      if (
                        !busy &&
                        !encoding.current &&
                        !pendingRef.current &&
                        !workspaceCreating &&
                        !optionsLoading
                      )
                        setPlanMode((value) => !value);
                    }
                  : undefined
              }
              availableModes={
                pending?.approvalMode
                  ? [pending.approvalMode]
                  : currentOptions?.availableApprovalModes
              }
              modeControlsDisabled={
                busy ||
                workspaceCreating ||
                Boolean(pending) ||
                optionsLoading ||
                !currentOptions ||
                (currentOptions.availableApprovalModes.length <= 1 &&
                  !currentOptions.planModeSupported)
              }
              onSelectMode={(value) => {
                if (
                  !busy &&
                  !encoding.current &&
                  !workspaceCreating &&
                  !pendingRef.current &&
                  !optionsLoading &&
                  isManagedApprovalMode(value) &&
                  currentOptions?.availableApprovalModes.includes(value)
                ) {
                  setSessionOptions({
                    ...currentOptions,
                    approvalMode: value,
                  });
                }
              }}
              availableModels={availableModels.map((item) => ({
                id: item.agentId,
                label: item.label,
              }))}
              onSelectModel={(id) => {
                if (!busy && !encoding.current && !pendingRef.current)
                  setAgentId(id);
              }}
              workspaces={items.map((item) => ({
                id: item.workspaceId,
                cwd: item.workspaceId,
                label: `${item.displayName} · ${t('managed.managedMode')}`,
                primary: false,
                trusted: supported && item.canCreateSession,
              }))}
              selectedWorkspaceCwd={pending?.workspaceId ?? selected}
              workspaceSelectorAlwaysVisible
              workspaceMenuItems={
                <>
                  {onSelectDaemonWorkspace &&
                    daemonWorkspaces?.map((item) => (
                      <DropdownMenuItem
                        key={item.id}
                        disabled={!item.trusted || Boolean(pendingWorkspace)}
                        title={item.cwd}
                        onSelect={() => {
                          if (
                            interactive &&
                            !creationOnly &&
                            !loading &&
                            !workspaceSelectionBlocked &&
                            !busy &&
                            !workspaceCreatingRef.current &&
                            !pendingRef.current &&
                            !pendingWorkspaceRef.current &&
                            !encoding.current &&
                            item.trusted
                          )
                            onSelectDaemonWorkspace(item);
                        }}
                      >
                        {item.label}
                        {item.hostOrigin &&
                          item.hostOrigin !== window.location.origin && (
                            <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                              <HostLabel origin={item.hostOrigin} />
                            </span>
                          )}
                      </DropdownMenuItem>
                    ))}
                  {onSelectDaemonWorkspace &&
                    Boolean(daemonWorkspaces?.length) && (
                      <DropdownMenuSeparator />
                    )}
                  <DropdownMenuItem
                    disabled={
                      !supported ||
                      !items.some(
                        (item) =>
                          item.workspaceId === selected &&
                          item.canCreateSession,
                      )
                    }
                    onSelect={() => setCwdDraft(cwdRelative)}
                  >
                    {t('managed.workspaceWorkingDirectory')}
                  </DropdownMenuItem>
                  {canImportLocalDirectory && binding.directories && (
                    <DropdownMenuItem
                      disabled={Boolean(pendingWorkspace)}
                      onSelect={() => void browseDirectories()}
                    >
                      {t('managed.workspaceChooseDirectory')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => setRevision((value) => value + 1)}
                  >
                    {t('managed.refresh')}
                  </DropdownMenuItem>
                  {nextCursor && (
                    <DropdownMenuItem onSelect={() => void loadMore()}>
                      {t('managed.more')}
                    </DropdownMenuItem>
                  )}
                </>
              }
              scratchWorkspaceSupported={
                interactive && workspaceCreationSupported
              }
              onCreateScratchWorkspace={() => {
                if (!encoding.current) setWorkspaceDialogOpen(true);
              }}
              workspaceMutationBusy={
                busy || workspaceCreating || Boolean(pending)
              }
              workspaceSelectionDisabled={
                !interactive ||
                creationOnly ||
                loading ||
                workspaceSelectionBlocked ||
                busy ||
                workspaceCreating ||
                Boolean(pending)
              }
              onSelectWorkspace={(id) => {
                if (
                  id &&
                  supported &&
                  !loading &&
                  !busy &&
                  !encoding.current &&
                  !pendingRef.current
                )
                  choose(id);
              }}
              composerInput={
                pending?.input.length
                  ? { text: managedInputText(pending.input) }
                  : undefined
              }
              composerInputVersion={0}
              disabled={
                !interactive ||
                busy ||
                workspaceSelectionBlocked ||
                workspaceCreating ||
                Boolean(pending) ||
                !approvalReady
              }
              dialogOpen={
                !interactive ||
                workspaceDialogOpen ||
                cwdDraft !== undefined ||
                Boolean(directoryPicker) ||
                registrationOpen
              }
              isPreparing={
                busy || fileReferences.busy || loading || optionsLoading
              }
              placeholderText={t('managed.prompt')}
              onSubmit={(text, images, files, commit, metadata) => {
                void createOrRead(text, commit, images, files, metadata);
                return false;
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
  return (
    <>
      {!creationOnly && sessionCreator}
      {interactive && !creationOnly && cwdDraft !== undefined && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setCwdDraft(undefined);
          }}
        >
          <DialogContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                setCwdRelative(cwdDraft);
                cwdEdited.current = true;
                setPathError(undefined);
                setCwdDraft(undefined);
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {t('managed.workspaceWorkingDirectory')}
                </DialogTitle>
                <DialogDescription>
                  {t('managed.workspaceWorkingDirectoryDescription')}
                </DialogDescription>
              </DialogHeader>
              <label htmlFor="managed-workspace-cwd">
                {t('managed.cwd.path')}
              </label>
              <Input
                id="managed-workspace-cwd"
                value={cwdDraft}
                onChange={(event) => setCwdDraft(event.target.value)}
                required
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCwdDraft(undefined)}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="submit">{t('common.save')}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {creationInteractive && directoryPicker && binding.directories && (
        <AddWorkspaceDialog
          executionMode={onOpenLocalWorkspace ? 'managed' : undefined}
          onExecutionModeChange={(mode) => {
            if (mode === 'daemon') openLocalWorkspace();
          }}
          executionModeLocked={
            busy || workspaceCreating || Boolean(pendingWorkspace)
          }
          browseDirectories
          initialPath={`${directoryPicker.root}/`}
          pathHint={t(
            directoryPicker.workspaceId
              ? 'managed.workspaceDirectoryHint'
              : 'managed.localDirectoryHint',
          )}
          pathPlaceholder="/absolute/project/path"
          displayNameEnabled
          persistenceSupported={false}
          onClose={() => {
            setDirectoryPicker(undefined);
            if (pendingWorkspaceRef.current) setWorkspaceDialogOpen(true);
            else onWorkspaceCreationOpenChange?.(false);
          }}
          onSuggest={suggestDirectories}
          onAdd={async (path, _persist, displayName) => {
            const root = directoryPicker.root;
            const clean = path.replace(/\/+$/, '') || '/';
            if (
              directoryPicker.workspaceId &&
              clean !== root &&
              !clean.startsWith(`${root}/`)
            )
              throw new Error(t('managed.workspaceDirectoryScope'));
            await createWorkspace({
              displayName:
                displayName ||
                workspaceName ||
                clean.split('/').pop() ||
                'Workspace',
              ...(directoryPicker.workspaceId
                ? {
                    sourceWorkspaceId: directoryPicker.workspaceId,
                    cwdRelative: clean.slice(root.length + 1) || '.',
                  }
                : { localPath: clean }),
            });
          }}
        />
      )}
      {interactive && binding.registration && (
        <RemoteWorkspaceRegistration
          key={provider.storageKey}
          provider={provider}
          clientId={clientId}
          open={registrationOpen}
          onOpenChange={setRegistrationOpen}
          onAvailable={setRegistrationAvailable}
          onRegistered={(workspace) => {
            setItems((current) => [
              ...current.filter(
                (item) => item.workspaceId !== workspace.workspaceId,
              ),
              workspace,
            ]);
            setSelected(workspace.workspaceId);
            setCwdRelative(workspace.defaultCwdRelative ?? '.');
            cwdEdited.current = false;
            setError(undefined);
            setPathError(undefined);
            onSelectWorkspace?.(workspace.workspaceId);
            onWorkspaceCreated?.(workspace.workspaceId);
          }}
        />
      )}
      <Dialog
        open={creationInteractive && workspaceDialogOpen}
        onOpenChange={(open) => {
          setWorkspaceDialogOpen(open);
          if (!open) onWorkspaceCreationOpenChange?.(false);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (directoryPicker) event.preventDefault();
          }}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void createWorkspace();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('managed.newWorkspaceTitle')}</DialogTitle>
              <DialogDescription>
                {t('managed.newWorkspaceDescription')}
              </DialogDescription>
            </DialogHeader>
            {onOpenLocalWorkspace && (
              <WorkspaceExecutionSelect
                value="managed"
                onValueChange={(mode) => {
                  if (mode === 'daemon') openLocalWorkspace();
                }}
                disabled={
                  busy || workspaceCreating || Boolean(pendingWorkspace)
                }
              />
            )}
            {(canSelectDirectory || canImportLocalDirectory) &&
              binding.directories &&
              !pendingWorkspace && (
                <div className="space-y-2">
                  {!canImportLocalDirectory && (
                    <>
                      <label id="managed-directory-root-label">
                        {t('managed.workspaceDirectoryRoot')}
                      </label>
                      <Select
                        value={
                          directorySource ||
                          items.find((item) => item.canSelectDirectory)
                            ?.workspaceId ||
                          ''
                        }
                        onValueChange={setDirectorySource}
                      >
                        <SelectTrigger aria-labelledby="managed-directory-root-label">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {items
                            .filter((item) => item.canSelectDirectory)
                            .map((item) => (
                              <SelectItem
                                key={item.workspaceId}
                                value={item.workspaceId}
                              >
                                {item.displayName}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      workspaceCreating ||
                      (!canImportLocalDirectory &&
                        !items.some((item) => item.canSelectDirectory))
                    }
                    onClick={() => void browseDirectories()}
                  >
                    {t('managed.workspaceChooseDirectory')}
                  </Button>
                </div>
              )}
            {(pendingWorkspace?.sourceWorkspaceId ||
              pendingWorkspace?.localPath) && (
              <p className="text-sm">
                {t('managed.workspaceDirectory')}:{' '}
                {pendingWorkspace.localPath ?? pendingWorkspace.cwdRelative}
              </p>
            )}
            <div className="space-y-2">
              <label htmlFor="managed-new-workspace-name">
                {t('managed.newWorkspaceName')}
              </label>
              <Input
                id="managed-new-workspace-name"
                value={workspaceName}
                disabled={workspaceCreating || Boolean(pendingWorkspace)}
                maxLength={128}
                autoComplete="off"
                onChange={(event) => {
                  setWorkspaceName(event.target.value);
                  setWorkspaceError(undefined);
                }}
              />
              {pendingWorkspace && !workspaceCreating && (
                <p className="text-sm text-muted-foreground">
                  {t('managed.newWorkspaceUncertain')}
                </p>
              )}
              {workspaceCreating && (
                <p role="status">{t('managed.newWorkspaceCreating')}</p>
              )}
              {workspaceError && (
                <p role="alert" className="text-sm text-destructive">
                  {workspaceError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setWorkspaceDialogOpen(false);
                  onWorkspaceCreationOpenChange?.(false);
                }}
              >
                {t('managed.newWorkspaceClose')}
              </Button>
              {pendingWorkspace && !workspaceCreating && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(workspacePendingKey);
                      pendingWorkspaceRef.current = undefined;
                      setPendingWorkspace(undefined);
                      setWorkspaceError(undefined);
                    } catch {
                      setWorkspaceError(
                        t('managed.workspaceStorageUnavailable'),
                      );
                    }
                  }}
                >
                  {t('managed.workspaceAbandon')}
                </Button>
              )}
              <Button
                type="submit"
                disabled={
                  loading ||
                  !workspaceCreationSupported ||
                  workspaceCreating ||
                  busy ||
                  Boolean(pending) ||
                  (!pendingWorkspace &&
                    (!canCreateWorkspace ||
                      !validWorkspaceName(workspaceName.trim())))
                }
              >
                {pendingWorkspace
                  ? t('managed.retry')
                  : t('managed.newWorkspaceCreate')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={interactive && Boolean(switchTo)}
        onOpenChange={(open) => {
          if (!open) {
            setSwitchTo(undefined);
            onSelectWorkspace?.(selectedRef.current);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('managed.workspaceSwitchTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('managed.workspaceSwitchDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('managed.workspaceKeep')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (switchTo) selectWorkspace(switchTo);
                setSwitchTo(undefined);
              }}
            >
              {t('managed.workspaceSwitch')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
