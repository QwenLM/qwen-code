import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { PlusIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { SkillInfo } from '../../completions/slashCompletion';
import type {
  WebShellAtProvider,
  WebShellComposerTag,
} from '../../customization';
import {
  createBuiltinProviderCache,
  createComposerTagForItem,
  createExtensionProvider,
  createFileProvider,
  createMcpResourcesProvider,
  escapeAtReferenceText,
  EXTENSIONS_PROVIDER_ID,
  FILE_PROVIDER_ID,
  sanitizeInsertText,
} from '../../hooks/useAtMentionSources';
import type {
  AtMentionItem,
  AtMentionWorkspaceActions,
  BuiltinProviderCache,
} from '../../hooks/useAtMentionSources';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import styles from '../ChatEditor.module.css';

export interface AddMenuProps {
  disabled?: boolean;
  availabilityKey: string;
  addFileAvailable: boolean;
  uploadAvailable: boolean;
  onAddFiles: (files: File[], destination: 'attach' | 'upload') => void;
  onFilePickerCancel: () => void;
  onInsertReference: (tag: WebShellComposerTag) => void;
  onPrependSkill: (invocation: string) => void;
  getWorkspaceActions: () => AtMentionWorkspaceActions | undefined;
  skills: readonly SkillInfo[];
}

const ADD_MENU_SEARCH_DEBOUNCE_MS = 150;

function SearchableProviderSubmenu({
  provider,
  onInsertReference,
  placeholder,
  testIdPrefix,
  allowDirectories = false,
  emptyMessage,
  autoFocusSearch = false,
}: {
  provider: WebShellAtProvider;
  onInsertReference: (tag: WebShellComposerTag) => void;
  placeholder?: string;
  testIdPrefix: string;
  allowDirectories?: boolean;
  emptyMessage?: string;
  autoFocusSearch?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly AtMentionItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef<{ id: number; abort: AbortController | null }>({
    id: 0,
    abort: null,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const state = requestRef.current;
    state.abort?.abort();
    setSearched(false);
    setFailed(false);
    const requestId = ++state.id;
    const abort = new AbortController();
    state.abort = abort;
    const timer = setTimeout(
      () => {
        void provider
          .search({ query, signal: abort.signal })
          .then((results) => {
            if (abort.signal.aborted || requestId !== requestRef.current.id) {
              return;
            }
            // Only built-in providers are wired here; they emit
            // AtMentionItem, which the WebShellAtProvider interface widens
            // to WebShellAtItem. Drill-in and upload items carry no
            // insertText, which is what makes them non-pickable here.
            const mentionItems = results as readonly AtMentionItem[];
            setItems(
              mentionItems.filter(
                (item) =>
                  Boolean(item.insertText) ||
                  (allowDirectories && item.kind === 'directory'),
              ),
            );
            setSearched(true);
          })
          .catch(() => {
            if (abort.signal.aborted || requestId !== requestRef.current.id) {
              return;
            }
            setItems([]);
            setSearched(true);
            setFailed(true);
          });
      },
      query ? ADD_MENU_SEARCH_DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [allowDirectories, provider, query]);

  useEffect(() => () => requestRef.current.abort?.abort(), []);
  useEffect(() => {
    if (autoFocusSearch) inputRef.current?.focus();
  }, [autoFocusSearch]);

  const pick = (item: AtMentionItem) => {
    if (item.kind === 'directory' && item.targetPath) {
      setQuery(`${item.targetPath}/`);
      setSearched(false);
      setFailed(false);
      return;
    }
    const insert = item.insertText ?? '';
    if (!insert) return;
    const tag = createComposerTagForItem(provider.id, item, insert);
    if (tag) {
      onInsertReference(tag);
    }
  };

  return (
    <div className="flex w-52 max-w-[calc(100vw-1rem)] flex-col gap-1 p-1 sm:w-72">
      {placeholder ? (
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid={`${testIdPrefix}-search`}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 rounded-md border bg-background px-2 text-sm outline-none"
        />
      ) : null}
      {failed ? (
        <div className="px-1.5 py-1 text-xs text-destructive">
          {t('composerAdd.loadError')}
        </div>
      ) : !searched ? (
        <div className="px-1.5 py-1 text-xs text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : items.length === 0 ? (
        <div
          className="px-1.5 py-1 text-xs text-muted-foreground"
          data-testid={`${testIdPrefix}-none`}
        >
          {emptyMessage ?? t('composerAdd.noResults')}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          {items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              data-testid={`${testIdPrefix}-item`}
              onSelect={(event) => {
                if (item.kind === 'directory') event.preventDefault();
                pick(item);
              }}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.label}</span>
                {(provider.id === EXTENSIONS_PROVIDER_ID
                  ? item.detail
                  : item.description) && provider.id !== FILE_PROVIDER_ID ? (
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">
                    {provider.id === EXTENSIONS_PROVIDER_ID
                      ? item.detail
                      : item.description}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

export function AddMenu({
  disabled,
  availabilityKey,
  addFileAvailable,
  uploadAvailable,
  onAddFiles,
  onFilePickerCancel,
  onInsertReference,
  onPrependSkill,
  getWorkspaceActions,
  skills,
}: AddMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [referenceSearchAutoFocus, setReferenceSearchAutoFocus] =
    useState(false);
  const [fileInputGeneration, setFileInputGeneration] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filePickerPendingRef = useRef(false);
  const availabilityKeyRef = useRef(availabilityKey);
  const fileDestinationRef = useRef<'attach' | 'upload'>('attach');
  const pendingCloseActionRef = useRef<(() => void) | null>(null);
  const cacheRef = useRef<BuiltinProviderCache>(createBuiltinProviderCache());
  const getCache = useCallback(() => cacheRef.current, []);

  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const handleCancel = () => {
      filePickerPendingRef.current = false;
      onFilePickerCancel();
    };
    input.addEventListener('cancel', handleCancel);
    return () => input.removeEventListener('cancel', handleCancel);
  }, [fileInputGeneration, onFilePickerCancel]);

  useEffect(() => {
    if (availabilityKeyRef.current === availabilityKey) return;
    availabilityKeyRef.current = availabilityKey;
    const restoreFocus = open || filePickerPendingRef.current;
    filePickerPendingRef.current = false;
    cacheRef.current = createBuiltinProviderCache();
    setOpen(false);
    setReferenceSearchAutoFocus(false);
    setFileInputGeneration((generation) => generation + 1);
    if (restoreFocus) onFilePickerCancel();
  }, [availabilityKey, onFilePickerCancel, open]);

  // Availability is recomputed on every open so the menu reflects the
  // current workspace without subscribing to it.
  const availability = useMemo(() => {
    const actions = open ? getWorkspaceActions() : undefined;
    return {
      referenceFile: Boolean(actions?.globWorkspace ?? actions?.listDirectory),
      extensions: Boolean(actions?.loadExtensionsStatus),
      mcp: Boolean(actions?.loadMcpStatus),
      skills: skills.length > 0,
    };
  }, [open, getWorkspaceActions, skills.length]);
  const anyAvailable =
    addFileAvailable ||
    uploadAvailable ||
    availability.referenceFile ||
    availability.extensions ||
    availability.mcp ||
    availability.skills;

  const referenceFileProvider = useMemo(
    () =>
      createFileProvider(
        getWorkspaceActions,
        () => '.',
        getCache,
        '',
        '',
        () => null,
        true,
      ),
    [getWorkspaceActions, getCache],
  );

  const extensionsProvider = useMemo(
    () => createExtensionProvider(getWorkspaceActions, getCache, '', ''),
    [getWorkspaceActions, getCache],
  );

  const mcpProvider = useMemo(() => {
    const base = createMcpResourcesProvider(
      getWorkspaceActions,
      getCache,
      '',
      '',
      (count) => t('mcp.resourceCount', { count }),
    );
    return {
      ...base,
      // ponytail: MCP stops at the server level. The Web Shell backend
      // ignores resource-level references, so servers that expose resources
      // are coerced to plain server inserts instead of a dead drill-in
      // (design doc, Constraint #1). Upgrade path: end-to-end resource refs.
      async search(params: Parameters<(typeof base)['search']>[0]) {
        const results = await base.search(params);
        return (results as readonly AtMentionItem[]).map((item) => {
          if (item.kind !== 'mcp-server' || !item.serverName) return item;
          const safeName = sanitizeInsertText(item.serverName);
          return {
            ...item,
            id: `mcp-server-ref:${item.serverName}`,
            kind: 'insert',
            insertText: `@mcp:${escapeAtReferenceText(safeName)} `,
          };
        });
      },
    };
  }, [getWorkspaceActions, getCache, t]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      cacheRef.current = createBuiltinProviderCache();
      pendingCloseActionRef.current = null;
    }
    setOpen(nextOpen);
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const destination = fileDestinationRef.current;
    filePickerPendingRef.current = false;
    event.target.value = '';
    if (
      files.length > 0 &&
      (destination === 'attach' ? addFileAvailable : uploadAvailable)
    ) {
      onAddFiles(files, destination);
    }
  };

  const pickFiles = (destination: 'attach' | 'upload') => {
    fileDestinationRef.current = destination;
    filePickerPendingRef.current = true;
    fileInputRef.current?.click();
  };

  const insertReference = (tag: WebShellComposerTag) => {
    pendingCloseActionRef.current = () => onInsertReference(tag);
    setOpen(false);
  };

  const prependSkill = (invocation: string) => {
    pendingCloseActionRef.current = () => onPrependSkill(invocation);
    setOpen(false);
  };

  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`${styles.toolBtn} ${styles.addMenuBtn}`}
            disabled={disabled}
            aria-label={t('composerAdd.trigger')}
            data-testid="composer-add-menu-trigger"
            onClick={(event) => event.stopPropagation()}
          >
            <span className={styles.toolBtnIcon}>
              <PlusIcon size={14} strokeWidth={2} />
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className="min-w-56 max-w-[calc(100vw-1rem)] sm:min-w-64"
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const pendingCloseAction = pendingCloseActionRef.current;
            pendingCloseActionRef.current = null;
            pendingCloseAction?.();
          }}
        >
          {!anyAvailable ? (
            <DropdownMenuLabel data-testid="composer-add-menu-empty">
              {t('composerAdd.emptyState')}
            </DropdownMenuLabel>
          ) : (
            <>
              {addFileAvailable || uploadAvailable ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="composer-add-menu-file">
                    {t('composerAdd.file.label')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    collisionPadding={8}
                    className="w-48 max-w-[calc(100vw-1rem)] sm:w-56"
                  >
                    <DropdownMenuItem
                      disabled={!addFileAvailable}
                      data-testid="composer-add-menu-file-attach"
                      onSelect={() => pickFiles('attach')}
                    >
                      {addFileAvailable
                        ? t('composer.dropChoice.reference')
                        : t('composerAdd.file.attachDisabled')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!uploadAvailable}
                      data-testid="composer-add-menu-file-upload"
                      onSelect={() => pickFiles('upload')}
                    >
                      {uploadAvailable
                        ? t('composer.dropChoice.upload')
                        : t('composerAdd.file.uploadDisabled')}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={!availability.referenceFile}
                  data-testid="composer-add-menu-reference-file"
                  onPointerMove={() => setReferenceSearchAutoFocus(false)}
                  onClick={() => setReferenceSearchAutoFocus(true)}
                >
                  <span className="min-w-0 flex-1">
                    {t('composerAdd.referenceFile.label')}
                  </span>
                  {!availability.referenceFile ? (
                    <span className="text-xs text-muted-foreground">
                      {t('composerAdd.unavailable')}
                    </span>
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  collisionPadding={8}
                  className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto p-0"
                >
                  <SearchableProviderSubmenu
                    provider={referenceFileProvider}
                    onInsertReference={insertReference}
                    placeholder={t(
                      'composerAdd.referenceFile.searchPlaceholder',
                    )}
                    testIdPrefix="composer-add-menu-reference-file"
                    allowDirectories
                    autoFocusSearch={referenceSearchAutoFocus}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={!availability.extensions}
                  data-testid="composer-add-menu-extensions"
                >
                  <span className="min-w-0 flex-1">
                    {t('composerAdd.extensions.label')}
                  </span>
                  {!availability.extensions ? (
                    <span className="text-xs text-muted-foreground">
                      {t('composerAdd.unavailable')}
                    </span>
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  collisionPadding={8}
                  className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto p-0"
                >
                  <SearchableProviderSubmenu
                    provider={extensionsProvider}
                    onInsertReference={insertReference}
                    testIdPrefix="composer-add-menu-extensions"
                    emptyMessage={t('composerAdd.extensions.empty')}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={!availability.mcp}
                  data-testid="composer-add-menu-mcp"
                >
                  <span className="min-w-0 flex-1">
                    {t('composerAdd.mcp.label')}
                  </span>
                  {!availability.mcp ? (
                    <span className="text-xs text-muted-foreground">
                      {t('composerAdd.unavailable')}
                    </span>
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  collisionPadding={8}
                  className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto p-0"
                >
                  <SearchableProviderSubmenu
                    provider={mcpProvider}
                    onInsertReference={insertReference}
                    testIdPrefix="composer-add-menu-mcp"
                    emptyMessage={t('composerAdd.mcp.empty')}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={!availability.skills}
                  data-testid="composer-add-menu-skills"
                >
                  <span className="min-w-0 flex-1">
                    {t('composerAdd.skills.label')}
                  </span>
                  {!availability.skills ? (
                    <span className="text-xs text-muted-foreground">
                      {t('composerAdd.unavailable')}
                    </span>
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  collisionPadding={8}
                  className="max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] w-52 max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-h-80 sm:w-80"
                >
                  {skills.map((skill) => {
                    const invocation = `/${skill.name}`;
                    return (
                      <DropdownMenuItem
                        key={skill.name}
                        data-testid="composer-add-menu-skills-item"
                        onSelect={() => prependSkill(invocation)}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{invocation}</span>
                          {skill.description ? (
                            <span className="hidden truncate text-xs text-muted-foreground sm:block">
                              {skill.description}
                            </span>
                          ) : null}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        key={fileInputGeneration}
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={handleFileInputChange}
      />
    </>
  );
}
