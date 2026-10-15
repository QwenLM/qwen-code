import { safeDisplayText } from '../../hooks/useAtMentionSources';
import { usePanelRef } from 'react-resizable-panels';
import { FileTree, type ContextMenuOpenContext } from '@pierre/trees';
import {
  Code2Icon,
  EyeIcon,
  FolderIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type DragEvent,
} from 'react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../themeContext';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useWebShellCustomization } from '../../customization';
import { useFileUpload } from '../../hooks/useFileUpload';
import type { DaemonDirectoryEntry } from '@qwen-code/web-shell/daemon-react-sdk';
import type { ArtifactWorkspaceActions } from './useArtifactWorkspaceTarget';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import {
  downloadWorkspaceFile,
  getImageMimeTypeFromPath,
  isExcelFile,
} from './artifactUtils';
import { writeClipboardText } from '../../utils/clipboard';
import { Input } from '../ui/input';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../ui/resizable';
import styles from './WorkspaceFileBrowser.module.css';

interface DirectoryState {
  path: string;
  error?: string;
  empty?: boolean;
  truncated?: boolean;
}

interface WorkspaceFileBrowserProps {
  workspaceCwd: string;
  actions: ArtifactWorkspaceActions;
  onOpenPreview: (path: string) => void;
  onReferenceFile?: (path: string) => void;
  renderPreview: (path: string, source: boolean, version: number) => ReactNode;
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\/$/, '');
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')));
}

export function WorkspaceFileBrowser({
  workspaceCwd,
  actions,
  renderPreview,
  onOpenPreview,
  onReferenceFile,
}: WorkspaceFileBrowserProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const workspace = useWorkspace();
  const { fileUploadEnabled } = useWebShellCustomization();
  const uploadClient = useMemo(
    () =>
      fileUploadEnabled !== false && actions.uploadWorkspaceFile
        ? { uploadWorkspaceFile: actions.uploadWorkspaceFile }
        : undefined,
    [actions, fileUploadEnabled],
  );
  const maxUploadBytes =
    workspace.capabilities?.limits?.maxWorkspaceFileUploadBytes ??
    50 * 1024 * 1024;
  const { uploads, isBusy, uploadFiles, removeUpload } = useFileUpload({
    client: uploadClient,
    maxBytes: maxUploadBytes,
    targetKey: `${workspaceCwd}:${uploadClient ? 'enabled' : 'disabled'}`,
  });
  const progressRef = useRef(
    new Map<string, { size: number; progress: number }>(),
  );
  const previousDoneRef = useRef(new Set<string>());
  const [dropDirectory, setDropDirectory] = useState<string>();
  const uploadedRef = useRef<((path: string) => void) | undefined>(undefined);
  const treePanelRef = usePanelRef();
  const contentPanelRef = usePanelRef();
  const hostRef = useRef<HTMLDivElement>(null);
  const treeLabelRef = useRef(t('files.title'));
  treeLabelRef.current = t('files.title');
  const treeRef = useRef<FileTree | undefined>(undefined);
  const retryRef = useRef<((path: string) => void) | undefined>(undefined);
  const [selectedPath, setSelectedPath] = useState<string>();
  const hasPreview = selectedPath !== undefined;
  const [source, setSource] = useState(false);
  const [treeVisible, setTreeVisible] = useState(true);
  const [filter, setFilter] = useState('');
  const [noMatches, setNoMatches] = useState(false);
  const [version, setVersion] = useState(0);
  const [directories, setDirectories] = useState<DirectoryState[]>([]);
  const [menu, setMenu] = useState<{
    path: string;
    context: ContextMenuOpenContext;
  }>();
  const [actionError, setActionError] = useState<string>();
  const lifetimeRef = useRef<object | undefined>(undefined);
  // Pierre restores focus synchronously and can reenter Radix dismissal.
  const closingMenuRef = useRef(false);

  useEffect(() => {
    if (!hasPreview) return undefined;
    // Wait for the group to register the nonzero preview constraints.
    const frame = requestAnimationFrame(() =>
      contentPanelRef.current?.resize('70%'),
    );
    return () => cancelAnimationFrame(frame);
  }, [hasPreview, contentPanelRef]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    const lifetime = {};
    lifetimeRef.current = lifetime;
    setMenu(undefined);
    const entries = new Map<string, DaemonDirectoryEntry>();
    const cache = new Map<string, DirectoryState>();
    const tree = new FileTree({
      paths: [],
      initialExpansion: 'closed',
      flattenEmptyDirectories: false,
      icons: 'complete',
      unsafeCSS: `
        [data-file-tree-virtualized-scroll] { overflow: auto; }
        [data-file-tree-virtualized-list] {
          width: max-content;
          min-width: 100%;
        }
        [data-item-section="content"] {
          min-width: max-content;
          flex-shrink: 0;
        }
        [data-item-section="spacing"] { flex-shrink: 0; }
      `,
      // The host supplies the visible filter instead of Pierre's search input.
      search: false,
      searchFakeFocus: true,
      searchBlurBehavior: 'retain',
      fileTreeSearchMode: 'hide-non-matches',
      composition: {
        contextMenu: {
          triggerMode: 'right-click',
          onOpen(item, context) {
            const entry = entries.get(item.path);
            if (entry?.kind === 'file' || entry?.kind === 'symlink') {
              closingMenuRef.current = false;
              setActionError(undefined);
              setMenu({ path: item.path, context });
            } else {
              context.close();
            }
          },
          onClose() {
            closingMenuRef.current = true;
            if (!disposed) setMenu(undefined);
          },
        },
      },
      onSearchChange(value) {
        // Selection and Escape close search; normalized queries must not edit input.
        if (value === null) setFilter('');
      },
      onSelectionChange(paths) {
        const path = paths.at(-1);
        const entry = path ? entries.get(path) : undefined;
        if (path && (entry?.kind === 'file' || entry?.kind === 'symlink')) {
          setSelectedPath(path);
          setSource(false);
        }
      },
    });
    treeRef.current = tree;
    setDirectories([]);
    setNoMatches(false);
    tree.render({ fileTreeContainer: host });
    const shadow = tree.getFileTreeContainer()?.shadowRoot;
    const labelTree = () =>
      shadow
        ?.querySelector('[role="tree"]')
        ?.setAttribute('aria-label', treeLabelRef.current);
    const observer = new MutationObserver(labelTree);
    if (shadow) observer.observe(shadow, { childList: true, subtree: true });
    labelTree();

    const publish = () => {
      if (!disposed) setDirectories([...cache.values()]);
    };
    const load = async (path: string) => {
      if (disposed || cache.has(path)) return;
      cache.set(path, { path });
      publish();
      try {
        const listing = await actions.listDirectory(path || '.');
        if (disposed) return;
        cache.set(path, {
          path,
          empty:
            listing.entries.length === 0 &&
            ![...entries.keys()].some(
              (child) => parentDirectory(child) === path,
            ),
          truncated: listing.truncated,
        });
        const added = listing.entries.flatMap((entry) => {
          const child = `${path ? `${path}/` : ''}${entry.name}${entry.kind === 'directory' ? '/' : ''}`;
          const exists = entries.has(child);
          entries.set(child, entry);
          return exists ? [] : [{ type: 'add' as const, path: child }];
        });
        if (added.length) tree.batch(added);
      } catch (error) {
        if (disposed) return;
        cache.set(path, {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      publish();
    };
    const unsubscribe = tree.subscribe(() => {
      const searching = Boolean(tree.getSearchValue());
      setNoMatches(searching && tree.getSearchMatchingPaths().length === 0);
      // Search expands matching ancestors without requesting their contents.
      if (searching) return;
      for (const [path, entry] of entries) {
        if (entry.kind !== 'directory') continue;
        const item = tree.getItem(path);
        if (item && 'isExpanded' in item && item.isExpanded()) {
          void load(path.slice(0, -1));
        }
      }
    });
    retryRef.current = (path) => {
      cache.delete(path);
      void load(path);
    };
    uploadedRef.current = (path) => {
      const parent = parentDirectory(path);
      if (!entries.has(path)) {
        entries.set(path, {
          name: path.split('/').at(-1)!,
          kind: 'file',
          ignored: false,
        });
        tree.add(path);
      }
      const directory = cache.get(parent);
      if (directory) cache.set(parent, { ...directory, empty: false });
      publish();
    };
    void load('');
    return () => {
      disposed = true;
      if (lifetimeRef.current === lifetime) lifetimeRef.current = undefined;
      observer.disconnect();
      unsubscribe();
      tree.cleanUp();
      host.replaceChildren();
      treeRef.current = undefined;
      retryRef.current = undefined;
      uploadedRef.current = undefined;
    };
  }, [actions, version]);

  useEffect(() => {
    treeRef.current?.setSearch(filter || null);
  }, [filter, version, actions]);

  useEffect(() => {
    treeRef.current
      ?.getFileTreeContainer()
      ?.shadowRoot?.querySelector('[role="tree"]')
      ?.setAttribute('aria-label', t('files.title'));
  }, [t]);

  const dropTarget = (event: DragEvent<HTMLDivElement>) => {
    const row = event.nativeEvent
      .composedPath()
      .find(
        (node) =>
          node instanceof HTMLElement &&
          node.getAttribute('role') === 'treeitem',
      );
    const path =
      row instanceof HTMLElement
        ? row.getAttribute('data-item-path')
        : undefined;
    if (!path) return '.';
    if (treeRef.current?.getItem(path)?.isDirectory())
      return path.replace(/\/$/, '');
    return parentDirectory(path) || '.';
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = uploadClient ? 'copy' : 'none';
    if (uploadClient) setDropDirectory(dropTarget(event));
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    setDropDirectory(undefined);
    if (!uploadClient) return;
    const items = Array.from(event.dataTransfer.items ?? []);
    const files = items.length
      ? items.flatMap((item) => {
          if (item.kind !== 'file' || item.webkitGetAsEntry?.()?.isDirectory)
            return [];
          const file = item.getAsFile();
          return file ? [file] : [];
        })
      : Array.from(event.dataTransfer.files);
    uploadFiles(files, dropTarget(event), (path) =>
      uploadedRef.current?.(path),
    );
  };
  const failedUploads = uploads.filter((upload) => upload.status === 'error');
  // Success notices expire after three seconds; byte accounting lasts until idle.
  if (!isBusy) {
    progressRef.current.clear();
    previousDoneRef.current = new Set(
      uploads
        .filter((upload) => upload.status === 'done')
        .map((upload) => upload.id),
    );
  } else {
    for (const upload of uploads) {
      if (upload.status === 'error') progressRef.current.delete(upload.id);
      else if (!previousDoneRef.current.has(upload.id))
        progressRef.current.set(upload.id, {
          size: Math.max(1, upload.file.size),
          progress: upload.progress,
        });
    }
  }
  const progressItems = [...progressRef.current.values()];
  const totalBytes = progressItems.reduce((sum, item) => sum + item.size, 0);
  const progress = totalBytes
    ? progressItems.reduce((sum, item) => sum + item.size * item.progress, 0) /
      totalBytes
    : 0;
  const uploadErrorText = (upload: (typeof uploads)[number]) =>
    `${safeDisplayText(upload.file.name)}: ${
      upload.error ??
      (upload.errorCode === 'tooLarge'
        ? t('composer.upload.error.tooLarge', {
            limit: `${Math.round(maxUploadBytes / (1024 * 1024))} MiB`,
          })
        : upload.errorCode === 'tooManyFiles'
          ? t('composer.upload.error.tooManyFiles', {
              count: upload.skippedCount ?? 0,
            })
          : t('composer.upload.error.noDaemon'))
    }`;
  const uploadProgress = isBusy && (
    <div
      className={styles.uploadProgress}
      role="progressbar"
      aria-label={t('composer.upload.uploading')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    >
      <div style={{ width: `${Math.max(2, progress * 100)}%` }} />
    </div>
  );
  const preventFileDrop = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'none';
    }
  };

  const runMenuAction = async (
    action: () => void | Promise<void>,
    transferFocus = false,
  ) => {
    const lifetime = lifetimeRef.current;
    closingMenuRef.current = true;
    menu?.context.close({ restoreFocus: !transferFocus });
    setMenu(undefined);
    try {
      await action();
    } catch (error) {
      if (lifetimeRef.current === lifetime) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const separator = /^(?:[a-z]:[\\/]|\\\\)/i.test(workspaceCwd) ? '\\' : '/';
  const absolutePath = (path: string) =>
    path
      ? `${workspaceCwd.replace(separator === '\\' ? /[\\/]+$/ : /\/+$/, '')}${separator}${path.replaceAll('/', separator)}`
      : workspaceCwd;
  const workspaceName = safeDisplayText(
    workspaceCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceCwd,
  );
  const absoluteMenuPath = absolutePath(menu?.path ?? '');
  const canPreview =
    selectedPath && /\.(?:md|markdown|html?)$/i.test(selectedPath);
  const notices = directories.filter(
    (directory) => directory.error || directory.empty || directory.truncated,
  );
  return (
    <section
      className={styles.browser}
      data-testid="workspace-file-browser"
      style={{ colorScheme: theme }}
      onDragOver={preventFileDrop}
      onDrop={preventFileDrop}
    >
      {menu && (
        <DropdownMenu
          open
          modal={false}
          onOpenChange={(open) => {
            if (!open && !closingMenuRef.current) {
              closingMenuRef.current = true;
              menu.context.close();
              setMenu(undefined);
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              tabIndex={-1}
              style={{
                position: 'fixed',
                left: menu.context.anchorRect.left,
                top: menu.context.anchorRect.top,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-48"
            aria-label={`${t('files.title')}: ${safeDisplayText(menu.path)}`}
            aria-labelledby={undefined}
            data-file-tree-context-menu-root="true"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              menu.context.restoreFocus();
            }}
          >
            {(/\.(?:md|markdown|html?)$/i.test(menu.path) ||
              getImageMimeTypeFromPath(menu.path) ||
              isExcelFile(menu.path)) && (
              <DropdownMenuItem
                onSelect={() =>
                  void runMenuAction(() => onOpenPreview(menu.path), true)
                }
              >
                {t('attachment.showPreview')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={!onReferenceFile}
              onSelect={() =>
                void runMenuAction(() => onReferenceFile?.(menu.path), true)
              }
            >
              {t('files.reference')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void runMenuAction(() => writeClipboardText(menu.path))
              }
            >
              {t('files.copyRelativePath')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void runMenuAction(() => writeClipboardText(absoluteMenuPath))
              }
            >
              {t('files.copyAbsolutePath')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                const lifetime = lifetimeRef.current;
                void runMenuAction(() =>
                  downloadWorkspaceFile(
                    actions,
                    menu.path,
                    undefined,
                    () => lifetimeRef.current !== lifetime,
                  ),
                );
              }}
            >
              {t('common.download')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <header className={styles.toolbar}>
        <span
          className={styles.path}
          title={safeDisplayText(absolutePath(selectedPath ?? ''))}
        >
          {workspaceName}
          {selectedPath && <> / {safeDisplayText(selectedPath)}</>}
        </span>
        {canPreview && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSource((value) => !value)}
          >
            {source ? <EyeIcon /> : <Code2Icon />}
            {t(source ? 'attachment.showPreview' : 'attachment.showSource')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setVersion((value) => value + 1)}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
        >
          <RefreshCwIcon />
        </Button>
        {hasPreview && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() =>
              treeVisible
                ? treePanelRef.current?.collapse()
                : treePanelRef.current?.expand()
            }
            aria-label={t('files.toggleTree')}
            title={t('files.toggleTree')}
            aria-pressed={treeVisible}
          >
            <FolderIcon />
          </Button>
        )}
      </header>
      {actionError && (
        <div className={styles.notices} role="alert">
          {actionError}
        </div>
      )}
      <div
        className="sr-only"
        role="status"
        data-testid="workspace-file-upload-status"
      >
        {uploads
          .filter(
            (upload) => upload.status === 'done' || upload.status === 'error',
          )
          .map((upload) =>
            upload.status === 'done'
              ? `${t('composer.upload.done')}: ${safeDisplayText(upload.resultPath)}`
              : uploadErrorText(upload),
          )
          .join('; ')}
      </div>
      {failedUploads.length > 0 && (
        <div className={styles.notices}>
          {failedUploads.map((upload) => (
            <div className={styles.uploadError} key={upload.id}>
              <span>{uploadErrorText(upload)}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('composer.upload.dismiss')}
                onClick={() => removeUpload(upload.id)}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      )}
      <ResizablePanelGroup
        className={styles.columns}
        orientation="horizontal"
        // Drawer pointer capture would retarget clicks out of Pierre's shadow DOM.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ResizablePanel
          defaultSize="0%"
          minSize={hasPreview ? 120 : 0}
          maxSize={hasPreview ? '100%' : '0%'}
          panelRef={contentPanelRef}
        >
          <div
            className={styles.content}
            data-testid="workspace-file-content"
            hidden={!hasPreview}
          >
            {selectedPath && renderPreview(selectedPath, source, version)}
          </div>
        </ResizablePanel>
        <ResizableHandle
          className={styles.splitHandle}
          hidden={!hasPreview || !treeVisible}
          aria-label={t('files.resizeTree')}
        />
        <ResizablePanel
          defaultSize="100%"
          minSize={150}
          maxSize={hasPreview ? '70%' : '100%'}
          collapsible
          panelRef={treePanelRef}
          onResize={(size) => setTreeVisible(size.asPercentage > 0)}
        >
          <div
            className={styles.sidebar}
            hidden={!treeVisible}
            data-testid="workspace-file-sidebar"
            onDragOverCapture={handleDragOver}
            onDropCapture={handleDrop}
            onDragLeaveCapture={(event) => {
              if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                setDropDirectory(undefined);
              }
            }}
          >
            {dropDirectory !== undefined && uploadClient && (
              <div className={styles.dropHint}>
                {t('files.uploadTo')}:{' '}
                {dropDirectory === '.'
                  ? workspaceName
                  : safeDisplayText(dropDirectory)}
              </div>
            )}
            <div className={styles.search}>
              <SearchIcon aria-hidden />
              <Input
                data-workspace-file-filter
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Escape' ||
                    !filter ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  setFilter('');
                }}
                placeholder={t('files.filter')}
                aria-label={t('files.filter')}
              />
            </div>
            <div
              ref={hostRef}
              className={styles.tree}
              hidden={noMatches}
              onClickCapture={(event) => {
                const row = event.nativeEvent
                  .composedPath()
                  .find(
                    (node) =>
                      node instanceof HTMLElement &&
                      node.getAttribute('role') === 'treeitem',
                  );
                if (!(row instanceof HTMLElement) || row.matches(':focus'))
                  return;
                const path = row.getAttribute('data-item-path');
                const root = row.getRootNode();
                const lifetime = lifetimeRef.current;
                if (!path || !(root instanceof ShadowRoot)) return;
                // Pierre can reuse the clicked DOM row before bubbling finishes.
                requestAnimationFrame(() => {
                  if (lifetimeRef.current !== lifetime) return;
                  root
                    .querySelector<HTMLElement>(
                      `[role="treeitem"][data-item-path="${CSS.escape(path)}"]`,
                    )
                    ?.focus({ preventScroll: true });
                });
              }}
              onMouseDownCapture={(event) => {
                // Native focus can scroll virtual rows before the click lands.
                if (
                  event.button === 0 &&
                  event.nativeEvent
                    .composedPath()
                    .some(
                      (node) =>
                        node instanceof HTMLElement &&
                        node.getAttribute('role') === 'treeitem',
                    )
                ) {
                  event.preventDefault();
                }
              }}
            />
            {noMatches && (
              <div className={styles.noMatches} role="status">
                {t('files.noMatches')}
              </div>
            )}
            {notices.length > 0 && (
              <div className={styles.notices}>
                {notices.map((directory) => (
                  <div key={directory.path}>
                    <span>
                      {directory.path
                        ? safeDisplayText(directory.path)
                        : t('files.title')}
                      :{' '}
                    </span>
                    {directory.empty && (
                      <span>{t('files.emptyDirectory')}</span>
                    )}
                    {directory.truncated && (
                      <span role="status">{t('files.truncated')}</span>
                    )}
                    {directory.error && (
                      <>
                        <span role="alert">{directory.error}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => retryRef.current?.(directory.path)}
                        >
                          {t('common.retry')}
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {treeVisible && uploadProgress}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {!treeVisible && uploadProgress}
    </section>
  );
}
