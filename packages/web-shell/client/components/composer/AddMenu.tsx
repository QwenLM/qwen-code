import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ArrowLeftIcon, PlusIcon, SlashIcon, XIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { CommandInfo } from '../../adapters/types';
import {
  getSlashCommandCompletionResult,
  type SkillInfo,
} from '../../completions/slashCompletion';
import type { CommandDisplayCategoryOrder } from '../../utils/commandDisplay';
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
import { ModeIcon } from '../ModeIcon';
import { Button } from '../ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from '../ui/drawer';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
  onSkillsOpenChange?: (open: boolean) => void;
  skillsLoading?: boolean;
  skillsLoadError?: boolean;
  skillsLoaded?: boolean;
  /**
   * Plan is chosen rarely, so its entry lives here rather than on the toolbar.
   * Omitted when the host has not enabled Plan.
   */
  plan?: AddMenuPlanControl;
  mobileActions?: {
    commands: readonly CommandInfo[];
    categoryOrder?: CommandDisplayCategoryOrder;
    onHistory: () => void;
    onToggleShell: () => void;
    shellMode: boolean;
    onLiveVoice?: () => void;
  };
  commandsOnly?: boolean;
}

export interface AddMenuPlanControl {
  checked: boolean;
  disabled?: boolean;
  /** Shown while disabled: a row is never disabled without a reason. */
  disabledReason: string;
  label: string;
  description: string;
  onToggle: () => void;
}

type MobilePage =
  | 'root'
  | 'files'
  | 'extensions'
  | 'mcp'
  | 'skills'
  | 'commands';

const ADD_MENU_SEARCH_DEBOUNCE_MS = 150;

function SearchableProviderSubmenu({
  provider,
  onInsertReference,
  placeholder,
  testIdPrefix,
  allowDirectories = false,
  emptyMessage,
  autoFocusSearch = false,
  mobile = false,
}: {
  provider: WebShellAtProvider;
  onInsertReference: (tag: WebShellComposerTag) => void;
  placeholder?: string;
  testIdPrefix: string;
  allowDirectories?: boolean;
  emptyMessage?: string;
  autoFocusSearch?: boolean;
  mobile?: boolean;
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
    <div
      className={
        mobile
          ? 'flex w-full flex-col gap-2'
          : 'flex w-52 max-w-[calc(100vw-1rem)] flex-col gap-1 p-1 sm:w-72'
      }
    >
      {placeholder ? (
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          autoCapitalize={mobile ? 'off' : undefined}
          autoCorrect={mobile ? 'off' : undefined}
          spellCheck={mobile ? false : undefined}
          enterKeyHint={mobile ? 'search' : undefined}
          data-testid={`${testIdPrefix}-search`}
          onChange={(event) => setQuery(event.target.value)}
          className={
            mobile
              ? 'h-11 rounded-md border bg-background px-3 text-base outline-none'
              : 'h-7 rounded-md border bg-background px-2 text-sm outline-none'
          }
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
          {items.map((item) => {
            const content = (
              <span className="flex min-w-0 flex-col">
                <span
                  className={mobile ? '[overflow-wrap:anywhere]' : 'truncate'}
                >
                  {item.label}
                </span>
                {(provider.id === EXTENSIONS_PROVIDER_ID
                  ? item.detail
                  : item.description) && provider.id !== FILE_PROVIDER_ID ? (
                  <span
                    className={
                      mobile
                        ? '[overflow-wrap:anywhere] text-xs text-muted-foreground'
                        : 'hidden truncate text-xs text-muted-foreground sm:block'
                    }
                  >
                    {provider.id === EXTENSIONS_PROVIDER_ID
                      ? item.detail
                      : item.description}
                  </span>
                ) : null}
              </span>
            );
            return mobile ? (
              <Button
                key={item.id}
                variant="ghost"
                className="h-auto min-h-11 w-full justify-start whitespace-normal text-left"
                data-testid={`${testIdPrefix}-item`}
                onClick={() => pick(item)}
              >
                {content}
              </Button>
            ) : (
              <DropdownMenuItem
                key={item.id}
                data-testid={`${testIdPrefix}-item`}
                onSelect={(event) => {
                  if (item.kind === 'directory') event.preventDefault();
                  pick(item);
                }}
              >
                {content}
              </DropdownMenuItem>
            );
          })}
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
  onSkillsOpenChange,
  skillsLoading,
  skillsLoadError,
  skillsLoaded = false,
  plan,
  mobileActions,
  commandsOnly = false,
}: AddMenuProps) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<MobilePage>('root');
  const [commandQuery, setCommandQuery] = useState('');
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
    pendingCloseActionRef.current = null;
    setPage('root');
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
      skills: Boolean(onSkillsOpenChange) || skills.length > 0,
    };
  }, [open, getWorkspaceActions, onSkillsOpenChange, skills.length]);
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

  useEffect(() => {
    if (!open) onSkillsOpenChange?.(false);
    return () => onSkillsOpenChange?.(false);
  }, [open, onSkillsOpenChange]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      cacheRef.current = createBuiltinProviderCache();
      pendingCloseActionRef.current = null;
      setPage(commandsOnly ? 'commands' : 'root');
      setCommandQuery('');
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

  const pickMobileFiles = (kind: 'photos' | 'camera' | 'attach' | 'upload') => {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = kind === 'photos' || kind === 'camera' ? 'image/*' : '';
    input.multiple = kind !== 'camera';
    if (kind === 'camera') input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    pickFiles(kind === 'upload' ? 'upload' : 'attach');
    setOpen(false);
  };

  const insertReference = (tag: WebShellComposerTag) => {
    pendingCloseActionRef.current = () => onInsertReference(tag);
    setOpen(false);
  };

  const prependSkill = (invocation: string) => {
    pendingCloseActionRef.current = () => onPrependSkill(invocation);
    setOpen(false);
  };

  const closeAndRun = (action: () => void) => {
    pendingCloseActionRef.current = action;
    setOpen(false);
  };

  const matchingCommands = useMemo(() => {
    if (!mobileActions || mobileActions.shellMode) return [];
    const query = commandQuery.trim().replace(/^\/+/, '');
    const commands = [...mobileActions.commands];
    const text = `/${query}`;
    const result = getSlashCommandCompletionResult(
      text,
      text.length,
      commands,
      [...skills],
      language,
      t,
      mobileActions.categoryOrder,
      true,
    );
    if (result?.items.length || !query) return result?.items ?? [];
    const descriptionMatches = commands.filter((command) =>
      command.description.toLowerCase().includes(query.toLowerCase()),
    );
    return (
      getSlashCommandCompletionResult(
        '/',
        1,
        descriptionMatches,
        [...skills],
        language,
        t,
        mobileActions.categoryOrder,
        true,
      )?.items ?? []
    );
  }, [commandQuery, mobileActions, skills, language, t]);
  const pageLabels: Record<MobilePage, string> = {
    root: t('composerAdd.trigger'),
    files: t('composerAdd.referenceFile.label'),
    extensions: t('composerAdd.extensions.label'),
    mcp: t('composerAdd.mcp.label'),
    skills: t('composerAdd.skills.label'),
    commands: t('composerMobile.commands'),
  };
  const mobileRowClass =
    'h-auto min-h-11 w-full justify-start whitespace-normal text-left';

  return (
    <>
      {mobileActions ? (
        <Drawer
          open={open}
          onOpenChange={handleOpenChange}
          shouldScaleBackground={false}
        >
          <DrawerTrigger asChild>
            <button
              type="button"
              className={`${styles.toolBtn} ${styles.addMenuBtn}`}
              disabled={disabled}
              aria-label={
                commandsOnly
                  ? t('composerMobile.commands')
                  : t('composerAdd.trigger')
              }
              data-testid="composer-add-menu-trigger"
              onClick={(event) => event.stopPropagation()}
            >
              {commandsOnly ? <SlashIcon size={18} /> : <PlusIcon size={18} />}
            </button>
          </DrawerTrigger>
          <DrawerContent
            aria-describedby={undefined}
            data-web-shell-mobile-add-menu
            className="pb-[max(1rem,env(safe-area-inset-bottom))]"
            onClick={(event) => event.stopPropagation()}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              const action = pendingCloseActionRef.current;
              pendingCloseActionRef.current = null;
              if (action) {
                event.preventDefault();
                action();
              }
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              {page !== 'root' && !commandsOnly && (
                <Button
                  variant="ghost"
                  className="size-11"
                  aria-label={t('common.back')}
                  onClick={() => {
                    setPage('root');
                    onSkillsOpenChange?.(false);
                  }}
                >
                  <ArrowLeftIcon />
                </Button>
              )}
              <DrawerTitle className="flex-1">{pageLabels[page]}</DrawerTitle>
              <Button
                variant="ghost"
                className="size-11"
                aria-label={t('common.close')}
                onClick={() => setOpen(false)}
              >
                <XIcon />
              </Button>
            </div>
            <div className="min-h-0 overflow-y-auto px-3" data-vaul-no-drag>
              {page === 'root' && (
                <div className="flex flex-col gap-1">
                  {addFileAvailable && (
                    <>
                      <Button
                        variant="ghost"
                        className={mobileRowClass}
                        onClick={() => pickMobileFiles('photos')}
                      >
                        {t('composerMobile.photos')}
                      </Button>
                      <Button
                        variant="ghost"
                        className={mobileRowClass}
                        onClick={() => pickMobileFiles('camera')}
                      >
                        {t('composerMobile.camera')}
                      </Button>
                      <Button
                        variant="ghost"
                        className={mobileRowClass}
                        onClick={() => pickMobileFiles('attach')}
                      >
                        {t('composerMobile.files')}
                      </Button>
                    </>
                  )}
                  {uploadAvailable && (
                    <Button
                      variant="ghost"
                      className={mobileRowClass}
                      onClick={() => pickMobileFiles('upload')}
                    >
                      {t('composer.dropChoice.upload')}
                    </Button>
                  )}
                  {(
                    [
                      ['files', availability.referenceFile],
                      ['extensions', availability.extensions],
                      ['mcp', availability.mcp],
                      [
                        'skills',
                        availability.skills && !mobileActions.shellMode,
                      ],
                    ] as const
                  )
                    .filter(([, available]) => available)
                    .map(([id]) => (
                      <Button
                        key={id}
                        data-testid={`composer-add-menu-${id === 'files' ? 'reference-file' : id}`}
                        variant="ghost"
                        className={mobileRowClass}
                        onClick={() => {
                          setPage(id);
                          if (id === 'skills') onSkillsOpenChange?.(true);
                        }}
                      >
                        {pageLabels[id]}
                      </Button>
                    ))}
                  <div className="my-1 border-t" />
                  {!mobileActions.shellMode &&
                    mobileActions.commands.length > 0 && (
                      <Button
                        variant="ghost"
                        className={mobileRowClass}
                        onClick={() => setPage('commands')}
                      >
                        {t('composerMobile.commands')}
                      </Button>
                    )}
                  <Button
                    variant="ghost"
                    className={mobileRowClass}
                    onClick={() => closeAndRun(mobileActions.onHistory)}
                  >
                    {t('composerMobile.history')}
                  </Button>
                  <Button
                    variant="ghost"
                    className={mobileRowClass}
                    onClick={() => closeAndRun(mobileActions.onToggleShell)}
                  >
                    {t(
                      mobileActions.shellMode
                        ? 'quickActions.exitShellMode'
                        : 'quickActions.shellMode',
                    )}
                  </Button>
                  {mobileActions.onLiveVoice && (
                    <Button
                      variant="ghost"
                      className={mobileRowClass}
                      onClick={() => closeAndRun(mobileActions.onLiveVoice!)}
                    >
                      {t('live.open')}
                    </Button>
                  )}
                  {plan && (
                    <Button
                      variant="ghost"
                      className={mobileRowClass}
                      aria-pressed={plan.checked}
                      disabled={plan.disabled}
                      data-testid="composer-add-menu-plan"
                      onClick={() => closeAndRun(plan.onToggle)}
                    >
                      <ModeIcon mode="plan" />
                      {plan.label}
                      {plan.checked ? ' ✓' : ''}
                      {plan.disabled && (
                        <span className="text-xs text-muted-foreground">
                          {plan.disabledReason}
                        </span>
                      )}
                    </Button>
                  )}
                </div>
              )}
              {(page === 'files' ||
                page === 'extensions' ||
                page === 'mcp') && (
                <SearchableProviderSubmenu
                  key={page}
                  mobile
                  provider={
                    page === 'files'
                      ? referenceFileProvider
                      : page === 'extensions'
                        ? extensionsProvider
                        : mcpProvider
                  }
                  onInsertReference={insertReference}
                  allowDirectories={page === 'files'}
                  placeholder={
                    page === 'files'
                      ? t('composerAdd.referenceFile.searchPlaceholder')
                      : undefined
                  }
                  emptyMessage={
                    page === 'extensions'
                      ? t('composerAdd.extensions.empty')
                      : page === 'mcp'
                        ? t('composerAdd.mcp.empty')
                        : undefined
                  }
                  testIdPrefix={`composer-add-menu-${page === 'files' ? 'reference-file' : page}`}
                />
              )}
              {page === 'skills' && !mobileActions.shellMode && (
                <>
                  {(skillsLoading ||
                    skillsLoadError ||
                    (skillsLoaded && skills.length === 0)) && (
                    <div role="status" className="p-3 text-muted-foreground">
                      {t(
                        skillsLoading
                          ? 'skills.loading'
                          : skillsLoadError
                            ? 'composerAdd.loadError'
                            : 'composerAdd.noResults',
                      )}
                    </div>
                  )}
                  {skills.map((skill) => (
                    <Button
                      key={skill.name}
                      data-testid="composer-add-menu-skills-item"
                      variant="ghost"
                      className={mobileRowClass}
                      onClick={() => prependSkill(`/${skill.name}`)}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span>/{skill.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {skill.description}
                        </span>
                      </span>
                    </Button>
                  ))}
                </>
              )}
              {page === 'commands' && (
                <div className="flex min-h-0 flex-col">
                  <input
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    className="sticky top-0 z-10 shrink-0 mb-2 h-11 w-full rounded-md border bg-background px-3 text-base"
                    value={commandQuery}
                    aria-label={t('composerMobile.searchCommands')}
                    placeholder={t('composerMobile.searchCommands')}
                    onChange={(event) => setCommandQuery(event.target.value)}
                  />
                  {matchingCommands.length === 0 && (
                    <div role="status" className="p-3 text-muted-foreground">
                      {t('composerAdd.noResults')}
                    </div>
                  )}
                  {matchingCommands.map((command) => (
                    <Button
                      key={command.id}
                      variant="ghost"
                      className={mobileRowClass}
                      onClick={() => prependSkill(command.apply.trimEnd())}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span>{command.label}</span>
                        {command.argumentHint && (
                          <span className="text-xs text-muted-foreground">
                            {command.argumentHint}
                          </span>
                        )}
                        {command.section && (
                          <span className="text-xs text-muted-foreground">
                            {command.section}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {command.detail}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
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
              const pendingCloseAction = pendingCloseActionRef.current;
              pendingCloseActionRef.current = null;
              if (pendingCloseAction) {
                event.preventDefault();
                pendingCloseAction();
              }
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
                <DropdownMenuSub onOpenChange={onSkillsOpenChange}>
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
                    {(skillsLoading ||
                      skillsLoadError ||
                      (skillsLoaded && skills.length === 0)) && (
                      <div
                        role="status"
                        className="px-2 py-1.5 text-xs text-muted-foreground"
                      >
                        {t(
                          skillsLoading
                            ? 'skills.loading'
                            : skillsLoadError
                              ? 'composerAdd.loadError'
                              : 'composerAdd.noResults',
                        )}
                      </div>
                    )}
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
            {plan ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={plan.checked}
                  disabled={plan.disabled}
                  data-testid="composer-add-menu-plan"
                  onSelect={() => closeAndRun(plan.onToggle)}
                >
                  <span className={styles.addMenuPlanIcon}>
                    <ModeIcon mode="plan" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{plan.label}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:block">
                      {plan.description}
                    </span>
                  </span>
                  {plan.disabled ? (
                    <span className="text-xs text-muted-foreground">
                      {plan.disabledReason}
                    </span>
                  ) : null}
                </DropdownMenuCheckboxItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
