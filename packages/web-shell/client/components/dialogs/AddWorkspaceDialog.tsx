import { useState, useCallback, useRef, useEffect } from 'react';
import { useI18n } from '../../i18n';
import { getShadowAwareActiveElement } from '../../utils/dom';
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
  CornerLeftUpIcon,
  FolderOpenIcon,
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

interface AddWorkspaceDialogProps {
  browseDirectories?: boolean;
  initialPath?: string;
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
  onPick?: () => Promise<string | undefined>;
  persistenceSupported?: boolean;
}

const HINT_ID = 'add-workspace-hint';
const DISPLAY_NAME_HINT_ID = 'add-workspace-display-name-hint';
const ERROR_ID = 'add-workspace-error';
const LISTBOX_ID = 'add-workspace-suggestions';
const SUGGEST_DEBOUNCE_MS = 150;

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export function AddWorkspaceDialog({
  browseDirectories = false,
  initialPath = '',
  onClose,
  onAdd,
  displayNameEnabled = false,
  locations,
  selectedLocation,
  onLocationChange,
  onSuggest,
  onPick,
  persistenceSupported = true,
}: AddWorkspaceDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(initialPath);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [persist, setPersist] = useState(true);
  const [suggestions, setSuggestions] = useState<WorkspacePathSuggestion[]>([]);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [hostSep, setHostSep] = useState('/');
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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
    if (!isAbsoluteLike(path)) {
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
    inputRef.current?.blur();
    // The blur above scheduled the delayed dismiss; cancel it and apply the
    // close + suppress now so the timer cannot fire after the outcome below.
    cancelBlurDismiss();
    closeList();
    suppressNextFetchOpenRef.current = true;
    setBrowsing(true);
    setError(null);
    let pickedPath: string | undefined;
    try {
      pickedPath = await onPick();
      if (pickedPath && pickedPath !== path) {
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
    } catch {
      suppressNextFetchOpenRef.current = false;
      setError(t('sidebar.addWorkspaceBrowseError'));
    } finally {
      setBrowsing(false);
    }
  }, [onPick, path, closeList, cancelBlurDismiss, t]);

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
        onClose();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('sidebar.addWorkspaceError'),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      path,
      displayName,
      displayNameEnabled,
      persist,
      persistenceSupported,
      onAdd,
      onClose,
      closeList,
      t,
    ],
  );

  const showList = (browseDirectories || listOpen) && suggestions.length > 0;

  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      size="md"
      dismissible={!submitting}
      onClose={onClose}
    >
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <FieldGroup>
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
                      const Icon = location.remote ? ServerIcon : LaptopIcon;
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
                  placeholder="/absolute/path/to/project"
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
                  aria-describedby={error ? `${ERROR_ID} ${HINT_ID}` : HINT_ID}
                  aria-invalid={error ? true : undefined}
                />
                {browseDirectories && (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    title={t('workspaceHost.parent')}
                    aria-label={t('workspaceHost.parent')}
                    disabled={submitting}
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
                        index >= 0 ? trimmed.slice(0, index + 1) : hostSep,
                      );
                    }}
                  >
                    <CornerLeftUpIcon aria-hidden="true" />
                  </Button>
                )}
                {onPick && (
                  <Button
                    type="button"
                    variant="outline"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void pickDirectory()}
                    disabled={submitting || browsing}
                  >
                    <FolderOpenIcon aria-hidden="true" />
                    {t('sidebar.addWorkspaceBrowse')}
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
                      <span className="text-muted-foreground">{hostSep}</span>
                    </li>
                  ))}
                </ul>
              )}
              {browseDirectories && suggestionsLoaded && !showList && (
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
            {!browseDirectories && (
              <FieldDescription id={HINT_ID}>
                {t('sidebar.addWorkspaceHint')}
              </FieldDescription>
            )}
            {error && <FieldError id={ERROR_ID}>{error}</FieldError>}
          </Field>
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
                  browseDirectories
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
            onClick={onClose}
            disabled={submitting}
          >
            {t('sidebar.addWorkspaceCancel')}
          </Button>
          <Button
            type="submit"
            className="flex-1 sm:flex-none"
            disabled={submitting || !path.trim()}
          >
            {submitting
              ? t('sidebar.addWorkspaceAdding')
              : t(
                  browseDirectories
                    ? 'workspaceHost.addFolder'
                    : 'sidebar.addWorkspaceRegister',
                )}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
