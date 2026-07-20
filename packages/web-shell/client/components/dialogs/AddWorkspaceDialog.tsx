import { useState, useCallback, useRef, useEffect } from 'react';
import { useI18n } from '../../i18n';
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
import { Switch } from '../ui/switch';

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

interface AddWorkspaceDialogProps {
  onClose: () => void;
  onAdd: (cwd: string, persist: boolean, displayName?: string) => Promise<void>;
  displayNameEnabled?: boolean;
  /**
   * Directory autocomplete backend. When provided, typing an absolute path
   * surfaces matching subdirectories in a listbox under the input.
   */
  onSuggest?: (prefix: string) => Promise<WorkspacePathSuggestions>;
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
  onClose,
  onAdd,
  displayNameEnabled = false,
  onSuggest,
  persistenceSupported = true,
}: AddWorkspaceDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [persist, setPersist] = useState(true);
  const [suggestions, setSuggestions] = useState<WorkspacePathSuggestion[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [hostSep, setHostSep] = useState('/');
  const inputRef = useRef<HTMLInputElement>(null);
  const listOpenRef = useRef(false);
  listOpenRef.current = listOpen && suggestions.length > 0;
  const suggestSeqRef = useRef(0);
  // Set when a suggestion is accepted or the list is dismissed, so the
  // path-change effect knows whether to reopen the list for that update.
  const suppressNextFetchOpenRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const closeList = useCallback(() => {
    setListOpen(false);
    setHighlight(-1);
  }, []);

  // Debounced suggestion fetch, keyed off the current path value. A stale
  // response (older sequence number) never overwrites a newer one.
  useEffect(() => {
    if (!onSuggest) return undefined;
    if (!isAbsoluteLike(path)) {
      setSuggestions([]);
      closeList();
      return undefined;
    }
    const seq = ++suggestSeqRef.current;
    const openOnResult = !suppressNextFetchOpenRef.current;
    suppressNextFetchOpenRef.current = false;
    const timer = setTimeout(() => {
      onSuggest(path).then(
        (result) => {
          if (seq !== suggestSeqRef.current) return;
          setSuggestions(result.suggestions);
          setHostSep(result.sep || '/');
          setHighlight(-1);
          if (openOnResult || listOpenRef.current) {
            setListOpen(result.suggestions.length > 0);
          }
        },
        () => {
          if (seq !== suggestSeqRef.current) return;
          // Autocomplete is best-effort; a failed lookup just yields no list.
          setSuggestions([]);
          closeList();
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [path, onSuggest, closeList]);

  // Radix listens for Escape on document capture; intercept one step earlier
  // (window capture) so an open suggestion list consumes the Escape instead
  // of closing the whole dialog (DialogShell skips `defaultPrevented`).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !listOpenRef.current) return;
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      closeList();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () =>
      window.removeEventListener('keydown', handler, { capture: true });
  }, [closeList]);

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
        // Enter accepts the highlighted directory instead of submitting.
        event.preventDefault();
        acceptSuggestion(suggestions[highlight]);
      }
    },
    [listOpen, suggestions, highlight, acceptSuggestion],
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
        const trimmedDisplayName = displayNameEnabled ? displayName.trim() : '';
        if (trimmedDisplayName) {
          await onAdd(trimmed, persist, trimmedDisplayName);
        } else {
          await onAdd(trimmed, persist);
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
      onAdd,
      onClose,
      closeList,
      t,
    ],
  );

  const showList = listOpen && suggestions.length > 0;

  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      size="md"
      onClose={onClose}
    >
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="add-workspace-path">
              {t('sidebar.addWorkspacePath')}
            </FieldLabel>
            <div className="relative">
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
                onBlur={() => {
                  // Delay so a mousedown on a suggestion wins over blur.
                  setTimeout(() => {
                    suppressNextFetchOpenRef.current = true;
                    closeList();
                  }, 100);
                }}
                disabled={submitting}
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
              {showList && (
                <ul
                  id={LISTBOX_ID}
                  role="listbox"
                  aria-label={t('sidebar.addWorkspaceSuggestions')}
                  className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
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
                      {suggestion.name}
                      <span className="text-muted-foreground">{hostSep}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <FieldDescription id={HINT_ID}>
              {t('sidebar.addWorkspaceHint')}
            </FieldDescription>
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
        </FieldGroup>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
          >
            {t('sidebar.addWorkspaceCancel')}
          </Button>
          <Button type="submit" disabled={submitting || !path.trim()}>
            {submitting
              ? t('sidebar.addWorkspaceAdding')
              : t('sidebar.addWorkspaceRegister')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
