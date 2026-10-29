import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
} from 'react';
import type { WebShellWorkspaceDirectoryPicker } from '../../customization';
import { useI18n } from '../../i18n';
import { getShadowAwareActiveElement } from '../../utils/dom';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../ui/field';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Switch } from '../ui/switch';
import {
  WorkspaceExecutionSelect,
  type WorkspaceExecutionMode,
} from '../workspaces/WorkspaceExecutionSelect';
import {
  CornerLeftUpIcon,
  FolderOpenIcon,
  GitBranchIcon,
  LaptopIcon,
  ServerIcon,
} from 'lucide-react';

export interface WorkspacePathSuggestion {
  name: string;
  path: string;
}

export interface WorkspacePathSuggestions {
  dir: string;
  sep: string;
  suggestions: WorkspacePathSuggestion[];
  truncated: boolean;
}

export interface WorkspaceLocationOption {
  origin: string;
  label: string;
  remote: boolean;
}

export type WorkspaceSource = 'directory' | 'git';

export interface GitWorkspaceCloneJob {
  jobId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  percent?: number;
  message?: string;
  cwd?: string;
  error?: { code: string; message: string };
}

export interface GitWorkspaceCloneControls {
  start(input: { url: string; target: string }): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<GitWorkspaceCloneJob>;
  cancel(jobId: string): Promise<void>;
}

interface AddWorkspaceDialogProps {
  /** Overrides the default "Add workspace" heading. */
  title?: string;
  /** Overrides the default submit label; the in-flight label is unchanged. */
  submitLabel?: string;
  executionMode?: WorkspaceExecutionMode;
  onExecutionModeChange?: (mode: WorkspaceExecutionMode) => void;
  executionModeLocked?: boolean;
  browseDirectories?: boolean;
  initialPath?: string;
  pathHint?: string;
  pathPlaceholder?: string;
  onClose: () => void;
  onAdd: (cwd: string, persist: boolean, displayName?: string) => Promise<void>;
  displayNameEnabled?: boolean;
  locations?: WorkspaceLocationOption[];
  selectedLocation?: string;
  onLocationChange?: (origin: string) => boolean | void;
  /**
   * Directory autocomplete backend. When provided, typing an absolute path
   * surfaces matching subdirectories in a listbox under the input.
   */
  onSuggest?: (prefix: string) => Promise<WorkspacePathSuggestions>;
  onPick?: WebShellWorkspaceDirectoryPicker;
  /** Stable identity for the current connection/target; replace it to cancel a pick. */
  pickerTarget?: unknown;
  pickerUsesHostUi?: boolean;
  persistenceSupported?: boolean;
  /**
   * Git clone controls. Presence means the connected daemon advertises
   * `git_workspace_clone`; the source selector is hidden otherwise.
   */
  gitClone?: GitWorkspaceCloneControls;
}

const HINT_ID = 'add-workspace-hint';
const DISPLAY_NAME_HINT_ID = 'add-workspace-display-name-hint';
const ERROR_ID = 'add-workspace-error';
const LISTBOX_ID = 'add-workspace-suggestions';
const GIT_LISTBOX_ID = 'add-workspace-git-suggestions';
const SUGGEST_DEBOUNCE_MS = 150;

function isAbsoluteLike(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('ssh://')
  );
}

function isAbsoluteTarget(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/:]/).pop() ?? '';
  return last.replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]/g, '') || 'repo';
}

function targetBasename(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}

export function AddWorkspaceDialog({
  title,
  submitLabel,
  executionMode,
  onExecutionModeChange,
  executionModeLocked,
  browseDirectories = false,
  initialPath = '',
  pathHint,
  pathPlaceholder = '/absolute/path or ssh://user@host/project',
  onClose,
  onAdd,
  displayNameEnabled = false,
  locations,
  selectedLocation,
  onLocationChange,
  onSuggest,
  onPick,
  pickerTarget,
  pickerUsesHostUi = false,
  persistenceSupported = true,
  gitClone,
}: AddWorkspaceDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(initialPath);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [persist, setPersist] = useState(true);
  const [source, setSource] = useState<WorkspaceSource>('directory');
  const [gitUrl, setGitUrl] = useState('');
  const [gitTarget, setGitTarget] = useState('');
  const [cloneJob, setCloneJob] = useState<GitWorkspaceCloneJob | undefined>();
  const [clonedCwd, setClonedCwd] = useState<string | undefined>();
  const [cloneUnknown, setCloneUnknown] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const clonePollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const cloneJobIdRef = useRef<string | undefined>(undefined);
  const cloneRegisteredJobRef = useRef<string | undefined>(undefined);
  const cloneCancelRequestedRef = useRef<string | undefined>(undefined);
  const cloneUnmountedRef = useRef(false);
  const autoGitTargetRef = useRef<string | undefined>(undefined);
  const [gitSuggestions, setGitSuggestions] = useState<
    WorkspacePathSuggestion[]
  >([]);
  const [gitSuggestOpen, setGitSuggestOpen] = useState(false);
  const [gitSuggestHighlight, setGitSuggestHighlight] = useState(-1);
  const [gitSuggestSep, setGitSuggestSep] = useState('/');
  const [gitSuggestEpoch, setGitSuggestEpoch] = useState(0);
  const gitSuggestSeqRef = useRef(0);
  const gitBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [suggestions, setSuggestions] = useState<WorkspacePathSuggestion[]>([]);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [hostSep, setHostSep] = useState('/');
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const suggestionListRef = useRef<HTMLUListElement | null>(null);
  const pickerListSnapshotRef = useRef<
    | {
        suggestions: WorkspacePathSuggestion[];
        scrollTop: number;
        height: number;
      }
    | undefined
  >(undefined);
  const setSuggestionListRef = useCallback(
    (node: HTMLUListElement | null) => {
      suggestionListRef.current = node;
      if (!node) return;
      const snapshot = pickerListSnapshotRef.current;
      if (snapshot?.suggestions === suggestions) {
        node.scrollTop = snapshot.scrollTop;
      }
      pickerListSnapshotRef.current = undefined;
    },
    [suggestions],
  );
  const listOpenRef = useRef(false);
  listOpenRef.current = listOpen && suggestions.length > 0;
  const suggestSeqRef = useRef(0);
  // Set while Browse is in flight, so the path-change effect keeps the
  // pick-triggered lookup closed until the first edit; blur dismissal
  // invalidates in-flight lookups via suggestSeqRef instead.
  const suppressNextFetchOpenRef = useRef(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pickerRequestRef = useRef<AbortController | undefined>(undefined);
  const cancelPicker = useCallback(() => {
    const request = pickerRequestRef.current;
    pickerRequestRef.current = undefined;
    request?.abort();
  }, []);
  const pickerAvailable = Boolean(onPick);

  // Callback identity may change on ordinary host renders. Only the target,
  // connection, or picker source invalidates an in-flight selection.
  useLayoutEffect(() => {
    setBrowsing(false);
    suppressNextFetchOpenRef.current = false;
    return cancelPicker;
  }, [
    pickerTarget,
    selectedLocation,
    pickerAvailable,
    pickerUsesHostUi,
    source,
    cancelPicker,
  ]);

  const handleClose = useCallback(() => {
    cancelPicker();
    setBrowsing(false);
    suppressNextFetchOpenRef.current = false;
    onClose();
  }, [cancelPicker, onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const cancelBlurDismiss = useCallback(() => {
    if (blurTimeoutRef.current !== undefined) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => () => cancelBlurDismiss(), [cancelBlurDismiss]);

  useEffect(() => {
    // StrictMode replays setup/cleanup/setup in development; resetting here
    // keeps the cleanup reversible, or every later poll would be discarded.
    cloneUnmountedRef.current = false;
    return () => {
      cloneUnmountedRef.current = true;
      if (clonePollTimerRef.current !== undefined) {
        clearTimeout(clonePollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (gitClone) return;
    // Withdrawing the capability mid-clone (a daemon reconnect or host
    // switch) leaves the poll's controls dead, so the clone state must go
    // with it; otherwise the dialog stays submitting and undismissible.
    setSource('directory');
    if (clonePollTimerRef.current !== undefined) {
      clearTimeout(clonePollTimerRef.current);
      clonePollTimerRef.current = undefined;
    }
    cloneJobIdRef.current = undefined;
    cloneRegisteredJobRef.current = undefined;
    cloneCancelRequestedRef.current = undefined;
    setCloneJob(undefined);
    setCloneUnknown(false);
    setCancelling(false);
    setSubmitting(false);
  }, [gitClone]);

  const closeList = useCallback(() => {
    setListOpen(false);
    setHighlight(-1);
  }, []);

  // Reset the path when the location changes, since each daemon has its own
  // filesystem. The effect below re-fetches suggestions for the new root.
  const prevLocationRef = useRef(selectedLocation);
  useEffect(() => {
    if (prevLocationRef.current === selectedLocation) return;
    prevLocationRef.current = selectedLocation;
    setPath(initialPath || '/');
    setError(null);
    setSuggestions([]);
    setSuggestionsLoaded(false);
    setSuggestionsError(false);
    closeList();
  }, [selectedLocation, initialPath, closeList]);

  // Debounced suggestion fetch, keyed off the current path value. A stale
  // response (older sequence number) never overwrites a newer one.
  useEffect(() => {
    if (!onSuggest) return undefined;
    if (!isAbsoluteLike(path) || path.trim().startsWith('ssh://')) {
      ++suggestSeqRef.current;
      setSuggestions([]);
      setSuggestionsLoaded(false);
      setSuggestionsError(false);
      closeList();
      return undefined;
    }
    const seq = ++suggestSeqRef.current;
    // Browse mode drives the list from the typed path, so results for the
    // previous directory must not linger. The typed-path autocomplete keeps its
    // previous list visible until the next answer instead of blanking here.
    if (browseDirectories) setSuggestions([]);
    setSuggestionsLoaded(false);
    setSuggestionsError(false);
    const openOnResult = !suppressNextFetchOpenRef.current;
    suppressNextFetchOpenRef.current = false;
    const timer = setTimeout(() => {
      onSuggest(path).then(
        (result) => {
          if (seq !== suggestSeqRef.current) return;
          setSuggestions(result.suggestions);
          setSuggestionsLoaded(true);
          setSuggestionsError(false);
          setHostSep(result.sep || '/');
          setHighlight(-1);
          const input = inputRef.current;
          if (
            browseDirectories ||
            (input !== null &&
              getShadowAwareActiveElement(input) === input &&
              (openOnResult || listOpenRef.current))
          ) {
            setListOpen(result.suggestions.length > 0);
          }
        },
        () => {
          if (seq !== suggestSeqRef.current) return;
          setSuggestions([]);
          setSuggestionsLoaded(true);
          setSuggestionsError(browseDirectories);
          closeList();
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [browseDirectories, path, onSuggest, closeList]);

  // Debounced directory suggestions for the clone target. A suggestion is an
  // existing directory, so accepting one uses it as the parent and appends the
  // repository name; the target itself must remain a new path.
  useEffect(() => {
    if (!onSuggest || source !== 'git' || clonedCwd !== undefined) {
      ++gitSuggestSeqRef.current;
      setGitSuggestions([]);
      setGitSuggestOpen(false);
      return undefined;
    }
    const trimmed = gitTarget.trim();
    if (!isAbsoluteLike(trimmed) || trimmed.startsWith('ssh://')) {
      ++gitSuggestSeqRef.current;
      setGitSuggestions([]);
      setGitSuggestOpen(false);
      return undefined;
    }
    const seq = ++gitSuggestSeqRef.current;
    const timer = setTimeout(() => {
      onSuggest(trimmed).then(
        (result) => {
          if (seq !== gitSuggestSeqRef.current) return;
          setGitSuggestions(result.suggestions);
          setGitSuggestSep(result.sep || '/');
          setGitSuggestHighlight(-1);
        },
        () => {
          if (seq !== gitSuggestSeqRef.current) return;
          setGitSuggestions([]);
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [clonedCwd, gitSuggestEpoch, gitTarget, onSuggest, source]);

  // Radix listens for Escape on document capture; intercept one step earlier
  // (window capture) so an open suggestion list consumes the Escape instead
  // of closing the whole dialog (DialogShell skips `defaultPrevented`).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Browse mode keeps the list open by design, so there is nothing for
      // Escape to dismiss there — leave it to close the dialog instead.
      if (browseDirectories) return;
      if (event.key !== 'Escape' || !listOpenRef.current) return;
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      closeList();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () =>
      window.removeEventListener('keydown', handler, { capture: true });
  }, [browseDirectories, closeList]);

  const acceptSuggestion = useCallback(
    (suggestion: WorkspacePathSuggestion) => {
      // Append the host separator so the next keystroke (or the immediate
      // refetch below) descends into the accepted directory.
      suppressNextFetchOpenRef.current = false;
      setPath(suggestion.path + hostSep);
      setError(null);
      closeList();
      inputRef.current?.focus();
    },
    [hostSep, closeList],
  );

  const pickDirectory = useCallback(async () => {
    if (!onPick) return;
    cancelPicker();
    const request = new AbortController();
    pickerRequestRef.current = request;
    const list = suggestionListRef.current;
    pickerListSnapshotRef.current = list
      ? { suggestions, scrollTop: list.scrollTop, height: list.offsetHeight }
      : undefined;
    inputRef.current?.blur();
    // The blur above scheduled the delayed dismiss; cancel it and apply the
    // close + suppress now so the timer cannot fire after the outcome below.
    cancelBlurDismiss();
    closeList();
    setGitSuggestOpen(false);
    ++gitSuggestSeqRef.current;
    suppressNextFetchOpenRef.current = source === 'directory';
    setBrowsing(true);
    setError(null);
    let pickedPath: string | undefined;
    try {
      pickedPath = await onPick({ signal: request.signal });
      if (pickerRequestRef.current !== request || request.signal.aborted)
        return;
      if (source === 'git') {
        if (pickedPath) {
          autoGitTargetRef.current = undefined;
          setGitTarget(
            `${pickedPath.replace(/[\\/]+$/, '')}/${repoNameFromUrl(gitUrl)}`,
          );
        }
      } else if (pickedPath && pickedPath !== path) {
        // Leave the suppress flag set: the path-change effect consumes it,
        // keeping the pick-triggered lookup closed until the first edit.
        ++suggestSeqRef.current;
        setPath(pickedPath);
        setSuggestions([]);
      } else {
        // Cancelled, failed, or same-value pick: the first edit must open.
        // A same-value pick keeps the typed path, so invalidate any lookup
        // already in flight from before Browse was clicked.
        if (pickedPath) ++suggestSeqRef.current;
        suppressNextFetchOpenRef.current = false;
      }
    } catch (error) {
      if (pickerRequestRef.current !== request || request.signal.aborted)
        return;
      suppressNextFetchOpenRef.current = false;
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          error.name === 'AbortError'
        )
      ) {
        setError(t('sidebar.addWorkspaceBrowseError'));
      }
    } finally {
      if (pickerRequestRef.current === request) {
        pickerRequestRef.current = undefined;
        setBrowsing(false);
      }
    }
  }, [
    onPick,
    source,
    gitUrl,
    path,
    suggestions,
    closeList,
    cancelBlurDismiss,
    cancelPicker,
    t,
  ]);

  const registerClonedWorkspace = useCallback(
    async (cwd: string) => {
      const effectivePersist = persistenceSupported ? persist : false;
      const trimmedDisplayName = displayNameEnabled ? displayName.trim() : '';
      if (trimmedDisplayName) {
        await onAdd(cwd, effectivePersist, trimmedDisplayName);
      } else {
        await onAdd(cwd, effectivePersist);
      }
    },
    [displayName, displayNameEnabled, onAdd, persist, persistenceSupported],
  );

  const pollCloneJob = useCallback(
    async (jobId: string) => {
      if (!gitClone) return;
      if (clonePollTimerRef.current !== undefined) {
        clearTimeout(clonePollTimerRef.current);
        clonePollTimerRef.current = undefined;
      }
      try {
        const job = await gitClone.poll(jobId);
        if (cloneUnmountedRef.current || cloneJobIdRef.current !== jobId)
          return;
        setCloneJob(job);
        if (job.status === 'running') {
          clonePollTimerRef.current = setTimeout(() => {
            void pollCloneJob(jobId);
          }, 1000);
          return;
        }
        if (job.status === 'succeeded' && job.cwd) {
          // A cancel that lost the race with a finished clone must not
          // register the repository the user asked to abort; fall through to
          // the completed-clone form so Register stays an explicit action.
          if (cloneCancelRequestedRef.current === jobId) {
            setClonedCwd(job.cwd);
            setSubmitting(false);
            return;
          }
          if (cloneRegisteredJobRef.current === jobId) return;
          cloneRegisteredJobRef.current = jobId;
          setClonedCwd(job.cwd);
          try {
            await registerClonedWorkspace(job.cwd);
            handleClose();
          } catch (err) {
            cloneRegisteredJobRef.current = undefined;
            setError(
              err instanceof Error
                ? err.message
                : t('sidebar.addWorkspaceError'),
            );
          } finally {
            setSubmitting(false);
          }
          return;
        }
        cloneCancelRequestedRef.current = undefined;
        if (job.status === 'failed') {
          setError(job.error?.message ?? t('sidebar.gitCloneFailed'));
        } else if (job.status === 'cancelled') {
          setError(t('sidebar.gitCloneCancelled'));
        }
        setSubmitting(false);
      } catch (err) {
        if (cloneUnmountedRef.current || cloneJobIdRef.current !== jobId)
          return;
        // A pruned or forgotten job answers 404 forever: retrying cannot
        // resolve it, so report that the job is gone instead of leaving the
        // user in an endless "Check again" loop.
        if (
          err instanceof DaemonHttpError &&
          err.status === 404 &&
          (err.body as { code?: unknown } | undefined)?.code ===
            'clone_job_not_found'
        ) {
          setError(t('sidebar.gitCloneJobGone'));
          setCloneUnknown(false);
          setCloneJob((job) =>
            job?.jobId === jobId ? { ...job, status: 'failed' } : job,
          );
        } else {
          setCloneUnknown(true);
        }
        setSubmitting(false);
      }
    },
    [gitClone, handleClose, registerClonedWorkspace, t],
  );

  const cancelClone = useCallback(async () => {
    const jobId = cloneJob?.jobId ?? cloneJobIdRef.current;
    if (!gitClone || !jobId) return;
    setCancelling(true);
    cloneCancelRequestedRef.current = jobId;
    if (clonePollTimerRef.current !== undefined) {
      clearTimeout(clonePollTimerRef.current);
      clonePollTimerRef.current = undefined;
    }
    try {
      await gitClone.cancel(jobId);
      await pollCloneJob(jobId);
    } catch {
      setCloneUnknown(true);
      setSubmitting(false);
    } finally {
      setCancelling(false);
    }
  }, [cloneJob, gitClone, pollCloneJob]);

  const recheckClone = useCallback(() => {
    const jobId = cloneJob?.jobId ?? cloneJobIdRef.current;
    if (!jobId || !gitClone) return;
    setCloneUnknown(false);
    setSubmitting(true);
    void pollCloneJob(jobId);
  }, [cloneJob, gitClone, pollCloneJob]);

  const backToForm = useCallback(() => {
    if (submitting) return;
    cloneCancelRequestedRef.current = undefined;
    cloneJobIdRef.current = undefined;
    setCloneJob(undefined);
    setCloneUnknown(false);
    setSubmitting(false);
  }, [submitting]);

  /**
   * Reuses the directory path as the clone parent. It only writes while the
   * target is empty or still the value this helper produced, so a target the
   * user edited (or picked with Browse) survives URL changes.
   */
  const seedGitTargetFromDirectoryPath = useCallback(
    (url: string) => {
      const rawParent = path.trim();
      if (
        !rawParent ||
        rawParent.startsWith('ssh://') ||
        !isAbsoluteTarget(rawParent)
      ) {
        return;
      }
      const currentTarget = gitTarget.trim();
      const autoTarget = autoGitTargetRef.current;
      if (currentTarget && currentTarget !== autoTarget) return;
      const parent = rawParent === '/' ? '/' : rawParent.replace(/[\\/]+$/, '');
      const name = url.trim() ? repoNameFromUrl(url) : '';
      const next =
        name && targetBasename(parent) !== name
          ? `${parent === '/' ? '' : parent}/${name}`
          : parent;
      if (next !== gitTarget) {
        setGitTarget(next);
        autoGitTargetRef.current = next;
      }
    },
    [gitTarget, path],
  );

  const cancelGitBlur = useCallback(() => {
    if (gitBlurTimeoutRef.current !== undefined) {
      clearTimeout(gitBlurTimeoutRef.current);
      gitBlurTimeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => () => cancelGitBlur(), [cancelGitBlur]);

  useEffect(() => {
    if (!gitSuggestOpen || gitSuggestions.length === 0) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      event.preventDefault();
      setGitSuggestOpen(false);
      setGitSuggestHighlight(-1);
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () =>
      window.removeEventListener('keydown', handler, { capture: true });
  }, [gitSuggestOpen, gitSuggestions.length]);

  const acceptGitSuggestion = useCallback(
    (suggestion: WorkspacePathSuggestion) => {
      const name = repoNameFromUrl(gitUrl);
      autoGitTargetRef.current = undefined;
      setGitTarget(
        `${suggestion.path.replace(/[\\/]+$/, '')}${gitSuggestSep}${name}`,
      );
      setGitSuggestOpen(false);
      setGitSuggestHighlight(-1);
      setError(null);
    },
    [gitSuggestSep, gitUrl],
  );

  const handleGitTargetKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      const open = gitSuggestOpen && gitSuggestions.length > 0;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!open) {
          if (gitSuggestions.length > 0) setGitSuggestOpen(true);
          return;
        }
        setGitSuggestHighlight(
          (current) => (current + 1) % gitSuggestions.length,
        );
        return;
      }
      if (event.key === 'ArrowUp') {
        if (!open) return;
        event.preventDefault();
        setGitSuggestHighlight(
          (current) => (current <= 0 ? gitSuggestions.length : current) - 1,
        );
        return;
      }
      if (event.key === 'Tab' && open && !event.shiftKey) {
        const target =
          gitSuggestHighlight >= 0
            ? gitSuggestions[gitSuggestHighlight]
            : gitSuggestions.length === 1
              ? gitSuggestions[0]
              : undefined;
        if (target) {
          event.preventDefault();
          acceptGitSuggestion(target);
        }
        return;
      }
      if (event.key === 'Enter' && open && gitSuggestHighlight >= 0) {
        event.preventDefault();
        acceptGitSuggestion(gitSuggestions[gitSuggestHighlight]);
      }
    },
    [acceptGitSuggestion, gitSuggestHighlight, gitSuggestOpen, gitSuggestions],
  );

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const open = listOpen && suggestions.length > 0;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!open) {
          if (suggestions.length > 0) setListOpen(true);
          return;
        }
        setHighlight((current) => (current + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        if (!open) return;
        event.preventDefault();
        setHighlight(
          (current) => (current <= 0 ? suggestions.length : current) - 1,
        );
        return;
      }
      if (event.key === 'Tab' && open && !event.shiftKey) {
        const target =
          highlight >= 0
            ? suggestions[highlight]
            : suggestions.length === 1
              ? suggestions[0]
              : undefined;
        if (target) {
          event.preventDefault();
          acceptSuggestion(target);
        }
        return;
      }
      if (event.key === 'Enter' && open && highlight >= 0) {
        event.preventDefault();
        acceptSuggestion(suggestions[highlight]);
        return;
      }
      if (
        event.key === 'Enter' &&
        browseDirectories &&
        !path.trim().startsWith('ssh://') &&
        !event.nativeEvent.isComposing
      ) {
        // Enter opens the typed directory rather than submitting: registering a
        // workspace stays a deliberate button press. Give it a visible outcome
        // in every case, or the key reads as broken.
        event.preventDefault();
        const trimmed = path.trim();
        if (!isAbsoluteLike(trimmed)) {
          setError(t('sidebar.addWorkspaceAbsError'));
          return;
        }
        if (!/[\\/]$/.test(trimmed)) {
          setPath(trimmed + hostSep);
          return;
        }
        if (suggestions.length > 0) setHighlight(0);
      }
    },
    [
      listOpen,
      suggestions,
      highlight,
      acceptSuggestion,
      browseDirectories,
      path,
      hostSep,
      t,
    ],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (pickerRequestRef.current) return;
      // A double Enter can fire before the disabled state renders; clone is
      // not idempotent, so the second submission must not start another job.
      if (submitting) return;
      if (source === 'git' && gitClone) {
        if (clonedCwd) {
          setError(null);
          setSubmitting(true);
          try {
            await registerClonedWorkspace(clonedCwd);
            handleClose();
          } catch (err) {
            setError(
              err instanceof Error
                ? err.message
                : t('sidebar.addWorkspaceError'),
            );
          } finally {
            setSubmitting(false);
          }
          return;
        }
        const trimmedUrl = gitUrl.trim();
        const trimmedTarget = gitTarget.trim();
        if (!trimmedUrl || !trimmedTarget) {
          setError(t('sidebar.gitCloneInvalidInput'));
          return;
        }
        if (!isAbsoluteTarget(trimmedTarget)) {
          setError(t('sidebar.gitCloneInvalidTarget'));
          return;
        }
        setError(null);
        setCloneUnknown(false);
        cloneCancelRequestedRef.current = undefined;
        setGitSuggestOpen(false);
        setGitSuggestHighlight(-1);
        setSubmitting(true);
        try {
          const { jobId } = await gitClone.start({
            url: trimmedUrl,
            target: trimmedTarget,
          });
          cloneJobIdRef.current = jobId;
          setCloneJob({ jobId, status: 'running' });
          void pollCloneJob(jobId);
        } catch (err) {
          setSubmitting(false);
          setError(
            err instanceof Error ? err.message : t('sidebar.gitCloneFailed'),
          );
        }
        return;
      }
      const trimmed = path.trim();
      if (!trimmed) return;
      if (!isAbsoluteLike(trimmed)) {
        setError(t('sidebar.addWorkspaceAbsError'));
        return;
      }
      setError(null);
      setSubmitting(true);
      closeList();
      try {
        const effectivePersist = persistenceSupported ? persist : false;
        const trimmedDisplayName = displayNameEnabled ? displayName.trim() : '';
        if (trimmedDisplayName) {
          await onAdd(trimmed, effectivePersist, trimmedDisplayName);
        } else {
          await onAdd(trimmed, effectivePersist);
        }
        handleClose();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('sidebar.addWorkspaceError'),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      source,
      gitClone,
      clonedCwd,
      registerClonedWorkspace,
      gitUrl,
      gitTarget,
      pollCloneJob,
      path,
      displayName,
      displayNameEnabled,
      persist,
      persistenceSupported,
      onAdd,
      handleClose,
      closeList,
      submitting,
      t,
    ],
  );

  const showList =
    !browsing && (browseDirectories || listOpen) && suggestions.length > 0;
  const showGitSuggestions =
    gitSuggestOpen &&
    !submitting &&
    !browsing &&
    !clonedCwd &&
    gitSuggestions.length > 0;

  return (
    <DialogShell
      title={title ?? t('sidebar.addWorkspaceTitle')}
      size="md"
      dismissible={!submitting}
      modal={!(pickerUsesHostUi && browsing)}
      modalRestoreFocusRef={browseButtonRef}
      aria-busy={browsing || undefined}
      onClose={handleClose}
    >
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        {cloneJob || cloneUnknown ? (
          <div className="flex flex-col gap-4">
            {cloneJob?.status === 'running' && (
              <>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={cloneJob.percent ?? 0}
                  aria-label={t('sidebar.gitCloneProgressLabel')}
                >
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${cloneJob.percent ?? 5}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {cloneJob.message ??
                    t('sidebar.gitCloneProgress', {
                      percent: String(cloneJob.percent ?? 0),
                    })}
                </p>
              </>
            )}
            {cloneUnknown && (
              <p role="alert" className="text-sm text-muted-foreground">
                {t('sidebar.gitCloneUnknown')}
              </p>
            )}
            {error && <FieldError>{error}</FieldError>}
            <div className="flex w-full justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 sm:flex-none"
                onClick={
                  cloneJob?.status === 'running' && !cloneUnknown
                    ? () => void cancelClone()
                    : handleClose
                }
                disabled={
                  cloneJob?.status === 'running' && !cloneUnknown
                    ? cancelling
                    : submitting
                }
              >
                {t('sidebar.addWorkspaceCancel')}
              </Button>
              {cloneUnknown ? (
                <Button
                  type="button"
                  className="flex-1 sm:flex-none"
                  onClick={recheckClone}
                >
                  {t('sidebar.gitCloneRecheck')}
                </Button>
              ) : cloneJob?.status === 'running' ? (
                <Button
                  type="button"
                  className="flex-1 sm:flex-none"
                  onClick={() => void cancelClone()}
                  disabled={cancelling}
                >
                  {t('sidebar.gitCloneCancel')}
                </Button>
              ) : cloneJob ? (
                <Button
                  type="button"
                  className="flex-1 sm:flex-none"
                  onClick={backToForm}
                  disabled={submitting}
                >
                  {t('sidebar.gitCloneBack')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <FieldGroup>
              {executionMode && onExecutionModeChange && (
                <WorkspaceExecutionSelect
                  value={executionMode}
                  onValueChange={onExecutionModeChange}
                  disabled={submitting || browsing || executionModeLocked}
                />
              )}
              {gitClone && (
                <Field>
                  <FieldLabel htmlFor="add-workspace-source">
                    {t('sidebar.addWorkspaceSource')}
                  </FieldLabel>
                  <Select
                    value={source}
                    disabled={submitting || browsing}
                    onValueChange={(value) => {
                      const nextSource = value as WorkspaceSource;
                      setSource(nextSource);
                      setError(null);
                      setCloneUnknown(false);
                      if (nextSource === 'git') {
                        seedGitTargetFromDirectoryPath(gitUrl);
                      }
                    }}
                  >
                    <SelectTrigger
                      id="add-workspace-source"
                      className="w-full"
                      aria-label={t('sidebar.addWorkspaceSource')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="directory">
                        <FolderOpenIcon aria-hidden="true" />
                        {t('sidebar.addWorkspaceSourceDirectory')}
                      </SelectItem>
                      <SelectItem value="git">
                        <GitBranchIcon aria-hidden="true" />
                        {t('sidebar.addWorkspaceSourceGit')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {browseDirectories &&
                locations &&
                locations.length > 0 &&
                selectedLocation &&
                onLocationChange && (
                  <Field>
                    <FieldLabel id="workspace-location-label">
                      {t('workspaceHost.source')}
                    </FieldLabel>
                    <Select
                      value={selectedLocation}
                      disabled={submitting}
                      onValueChange={(origin) => {
                        if (origin === selectedLocation) return;
                        if (onLocationChange(origin) === false) {
                          setError(t('workspaceHost.navigationUnavailable'));
                        }
                      }}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-labelledby="workspace-location-label"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {locations.map((location) => {
                          const Icon = location.remote
                            ? ServerIcon
                            : LaptopIcon;
                          return (
                            <SelectItem
                              key={location.origin}
                              value={location.origin}
                            >
                              <Icon aria-hidden="true" />
                              {location.label}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              {source === 'directory' && (
                <Field data-invalid={error ? true : undefined}>
                  <FieldLabel htmlFor="add-workspace-path">
                    {t('sidebar.addWorkspacePath')}
                  </FieldLabel>
                  <div className="relative">
                    <div className="flex gap-2">
                      <Input
                        ref={inputRef}
                        id="add-workspace-path"
                        type="text"
                        placeholder={pathPlaceholder}
                        value={path}
                        onChange={(e) => {
                          setPath(e.target.value);
                          if (error) setError(null);
                        }}
                        onKeyDown={handleInputKeyDown}
                        onFocus={cancelBlurDismiss}
                        onBlur={() => {
                          if (browseDirectories) return;
                          // Delay so a mousedown on a suggestion wins over blur.
                          cancelBlurDismiss();
                          blurTimeoutRef.current = setTimeout(() => {
                            blurTimeoutRef.current = undefined;
                            // Invalidate in-flight lookups via the sequence counter
                            // rather than suppressing the next fetch, which would
                            // leak into the first edit after the user refocuses.
                            ++suggestSeqRef.current;
                            // Drop the stale entries too: the invalidated lookup
                            // never refreshes them, and ArrowDown would reopen
                            // whatever is left against the current input.
                            setSuggestions([]);
                            closeList();
                          }, 100);
                        }}
                        disabled={submitting || browsing}
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                        role="combobox"
                        aria-expanded={showList}
                        aria-controls={showList ? LISTBOX_ID : undefined}
                        aria-activedescendant={
                          showList && highlight >= 0
                            ? `${LISTBOX_ID}-${highlight}`
                            : undefined
                        }
                        aria-describedby={
                          error ? `${ERROR_ID} ${HINT_ID}` : HINT_ID
                        }
                        aria-invalid={error ? true : undefined}
                      />
                      {browseDirectories &&
                        !path.trim().startsWith('ssh://') && (
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            title={t('workspaceHost.parent')}
                            aria-label={t('workspaceHost.parent')}
                            disabled={submitting || browsing}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              const trimmed = path.replace(/[\\/]+$/, '');
                              if (/^[A-Za-z]:$/.test(trimmed)) {
                                setPath(`${trimmed}\\`);
                                return;
                              }
                              const index = Math.max(
                                trimmed.lastIndexOf('/'),
                                trimmed.lastIndexOf('\\'),
                              );
                              setPath(
                                index >= 0
                                  ? trimmed.slice(0, index + 1)
                                  : hostSep,
                              );
                            }}
                          >
                            <CornerLeftUpIcon aria-hidden="true" />
                          </Button>
                        )}
                      {onPick && (
                        <Button
                          ref={browseButtonRef}
                          type="button"
                          variant="outline"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void pickDirectory()}
                          disabled={submitting || browsing}
                        >
                          <FolderOpenIcon aria-hidden="true" />
                          {browsing
                            ? t('sidebar.addWorkspaceBrowsing')
                            : t('sidebar.addWorkspaceBrowse')}
                        </Button>
                      )}
                    </div>
                    {browseDirectories && (
                      // Above the list, because it points at it. A plain paragraph
                      // rather than FieldDescription, whose last-child margin rules
                      // are written for the end of a Field.
                      <p
                        id={HINT_ID}
                        className="mt-2 text-sm leading-normal text-muted-foreground"
                      >
                        {t('workspaceHost.browseHint')}
                      </p>
                    )}
                    {showList && (
                      <ul
                        ref={setSuggestionListRef}
                        id={LISTBOX_ID}
                        role="listbox"
                        aria-label={t('sidebar.addWorkspaceSuggestions')}
                        className={`${browseDirectories ? 'relative' : 'absolute inset-x-0 top-full z-50'} mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md`}
                      >
                        {suggestions.map((suggestion, index) => (
                          <li
                            key={suggestion.path}
                            id={`${LISTBOX_ID}-${index}`}
                            role="option"
                            aria-selected={index === highlight}
                            className={`cursor-pointer truncate px-3 py-1.5 ${
                              index === highlight
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-accent/50'
                            }`}
                            onMouseDown={(event) => {
                              // Keep focus in the input; blur would close the list
                              // before click lands.
                              event.preventDefault();
                              acceptSuggestion(suggestion);
                            }}
                            onMouseEnter={() => setHighlight(index)}
                          >
                            {browseDirectories && (
                              <FolderOpenIcon
                                className="mr-2 inline size-4"
                                aria-hidden="true"
                              />
                            )}
                            {suggestion.name}
                            <span className="text-muted-foreground">
                              {hostSep}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {browseDirectories &&
                      browsing &&
                      pickerListSnapshotRef.current && (
                        // Keep the body from shrinking and clamping its scroll offset.
                        <div
                          aria-hidden="true"
                          className="mt-1"
                          style={{
                            height: pickerListSnapshotRef.current.height,
                          }}
                        />
                      )}
                    {browseDirectories &&
                      !browsing &&
                      suggestionsLoaded &&
                      !showList && (
                        <div
                          role={suggestionsError ? 'alert' : 'status'}
                          className="mt-1 rounded-md border px-3 py-3 text-sm text-muted-foreground"
                        >
                          {t(
                            suggestionsError
                              ? 'workspaceHost.folderListError'
                              : 'workspaceHost.noFolders',
                          )}
                        </div>
                      )}
                  </div>
                  <FieldDescription
                    id={browseDirectories ? undefined : HINT_ID}
                  >
                    {pathHint ?? t('sidebar.addWorkspaceHint')}
                  </FieldDescription>
                  {error && <FieldError id={ERROR_ID}>{error}</FieldError>}
                </Field>
              )}
              {source === 'git' && gitClone && (
                <>
                  <Field data-invalid={error ? true : undefined}>
                    <FieldLabel htmlFor="add-workspace-git-url">
                      {t('sidebar.gitCloneUrl')}
                    </FieldLabel>
                    <Input
                      id="add-workspace-git-url"
                      type="text"
                      placeholder={t('sidebar.gitCloneUrlPlaceholder')}
                      value={gitUrl}
                      onChange={(event) => {
                        const nextUrl = event.target.value;
                        setGitUrl(nextUrl);
                        if (error) setError(null);
                        if (source === 'git') {
                          seedGitTargetFromDirectoryPath(nextUrl);
                        }
                      }}
                      disabled={
                        submitting || browsing || clonedCwd !== undefined
                      }
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <FieldDescription>
                      {t('sidebar.gitCloneUrlHint')}
                    </FieldDescription>
                  </Field>
                  <Field data-invalid={error ? true : undefined}>
                    <FieldLabel htmlFor="add-workspace-git-target">
                      {t('sidebar.gitCloneTarget')}
                    </FieldLabel>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Input
                          id="add-workspace-git-target"
                          type="text"
                          placeholder={t('sidebar.gitCloneTargetPlaceholder')}
                          value={gitTarget}
                          onChange={(event) => {
                            autoGitTargetRef.current = undefined;
                            setGitTarget(event.target.value);
                            setGitSuggestOpen(true);
                            if (error) setError(null);
                          }}
                          onKeyDown={handleGitTargetKeyDown}
                          onFocus={() => {
                            cancelGitBlur();
                            setGitSuggestOpen(true);
                            setGitSuggestEpoch((value) => value + 1);
                          }}
                          onBlur={() => {
                            cancelGitBlur();
                            gitBlurTimeoutRef.current = setTimeout(() => {
                              gitBlurTimeoutRef.current = undefined;
                              ++gitSuggestSeqRef.current;
                              setGitSuggestions([]);
                              setGitSuggestOpen(false);
                            }, 100);
                          }}
                          disabled={
                            submitting || browsing || clonedCwd !== undefined
                          }
                          autoCapitalize="off"
                          autoCorrect="off"
                          autoComplete="off"
                          spellCheck={false}
                          role="combobox"
                          aria-expanded={showGitSuggestions}
                          aria-controls={
                            showGitSuggestions ? GIT_LISTBOX_ID : undefined
                          }
                          aria-activedescendant={
                            showGitSuggestions && gitSuggestHighlight >= 0
                              ? `${GIT_LISTBOX_ID}-${gitSuggestHighlight}`
                              : undefined
                          }
                          aria-autocomplete="list"
                        />
                        {showGitSuggestions && (
                          <ul
                            id={GIT_LISTBOX_ID}
                            role="listbox"
                            aria-label={t('sidebar.addWorkspaceSuggestions')}
                            className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
                          >
                            {gitSuggestions.map((suggestion, index) => (
                              <li
                                key={suggestion.path}
                                id={`${GIT_LISTBOX_ID}-${index}`}
                                role="option"
                                aria-selected={index === gitSuggestHighlight}
                                className={`cursor-pointer truncate px-3 py-1.5 ${
                                  index === gitSuggestHighlight
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-accent/50'
                                }`}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  acceptGitSuggestion(suggestion);
                                }}
                                onMouseEnter={() =>
                                  setGitSuggestHighlight(index)
                                }
                              >
                                <FolderOpenIcon
                                  className="mr-2 inline size-4"
                                  aria-hidden="true"
                                />
                                {suggestion.name}
                                <span className="text-muted-foreground">
                                  {gitSuggestSep}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      {onPick && (
                        <Button
                          ref={browseButtonRef}
                          type="button"
                          variant="outline"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void pickDirectory()}
                          disabled={
                            submitting || browsing || clonedCwd !== undefined
                          }
                        >
                          <FolderOpenIcon aria-hidden="true" />
                          {browsing
                            ? t('sidebar.addWorkspaceBrowsing')
                            : t('sidebar.addWorkspaceBrowse')}
                        </Button>
                      )}
                    </div>
                    <FieldDescription>
                      {clonedCwd
                        ? t('sidebar.gitCloneRegisterRetry', {
                            path: clonedCwd,
                          })
                        : t('sidebar.gitCloneTargetHint')}
                      {!clonedCwd && onSuggest
                        ? ` ${t('sidebar.gitCloneTargetSuggestHint')}`
                        : ''}
                    </FieldDescription>
                    {error && <FieldError id={ERROR_ID}>{error}</FieldError>}
                  </Field>
                </>
              )}
              {displayNameEnabled && (
                <Field>
                  <FieldLabel htmlFor="add-workspace-display-name">
                    {t('sidebar.addWorkspaceDisplayName')}
                  </FieldLabel>
                  <Input
                    id="add-workspace-display-name"
                    type="text"
                    value={displayName}
                    placeholder={
                      source === 'git'
                        ? repoNameFromUrl(gitUrl)
                        : browseDirectories
                          ? path.split(/[\\/]/).filter(Boolean).pop()
                          : undefined
                    }
                    onChange={(event) => setDisplayName(event.target.value)}
                    disabled={submitting}
                    maxLength={256}
                    autoComplete="off"
                    aria-describedby={DISPLAY_NAME_HINT_ID}
                  />
                  <FieldDescription id={DISPLAY_NAME_HINT_ID}>
                    {t('sidebar.addWorkspaceDisplayNameHint')}
                  </FieldDescription>
                </Field>
              )}
              {persistenceSupported && (
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="add-workspace-persist">
                      {t('sidebar.addWorkspacePersist')}
                    </FieldLabel>
                    <FieldDescription>
                      {t('sidebar.addWorkspacePersistHint')}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="add-workspace-persist"
                    checked={persist}
                    onCheckedChange={setPersist}
                    disabled={submitting}
                  />
                </Field>
              )}
            </FieldGroup>
            <div className="flex w-full justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 sm:flex-none"
                onClick={handleClose}
                disabled={submitting}
              >
                {t('sidebar.addWorkspaceCancel')}
              </Button>
              <Button
                type="submit"
                className="flex-1 sm:flex-none"
                disabled={
                  submitting ||
                  browsing ||
                  (source === 'git'
                    ? clonedCwd === undefined &&
                      (!gitUrl.trim() || !gitTarget.trim())
                    : !path.trim())
                }
              >
                {submitting
                  ? t('sidebar.addWorkspaceAdding')
                  : (submitLabel ??
                    t(
                      source === 'git'
                        ? clonedCwd
                          ? 'sidebar.addWorkspaceRegister'
                          : 'sidebar.gitCloneSubmit'
                        : browseDirectories
                          ? 'workspaceHost.addFolder'
                          : 'sidebar.addWorkspaceRegister',
                    ))}
              </Button>
            </div>
          </>
        )}
      </form>
    </DialogShell>
  );
}
