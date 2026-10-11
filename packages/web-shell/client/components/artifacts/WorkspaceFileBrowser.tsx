import { usePanelRef } from 'react-resizable-panels';
import { FileTree, type ContextMenuOpenContext } from '@pierre/trees';
import {
  Code2Icon,
  EyeIcon,
  FolderIcon,
  RefreshCwIcon,
  SearchIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../themeContext';
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

export function WorkspaceFileBrowser({
  workspaceCwd,
  actions,
  renderPreview,
  onOpenPreview,
  onReferenceFile,
}: WorkspaceFileBrowserProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const treePanelRef = usePanelRef();
  const contentPanelRef = usePanelRef();
  const hostRef = useRef<HTMLDivElement>(null);
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
          empty: listing.entries.length === 0,
          truncated: listing.truncated,
        });
        const added = listing.entries.map((entry) => {
          const child = `${path ? `${path}/` : ''}${entry.name}${entry.kind === 'directory' ? '/' : ''}`;
          entries.set(child, entry);
          return { type: 'add' as const, path: child };
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
    void load('');
    return () => {
      disposed = true;
      if (lifetimeRef.current === lifetime) lifetimeRef.current = undefined;
      unsubscribe();
      tree.cleanUp();
      host.replaceChildren();
      treeRef.current = undefined;
      retryRef.current = undefined;
    };
  }, [actions, version]);

  useEffect(() => {
    treeRef.current?.setSearch(filter || null);
  }, [filter, version, actions]);

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
  const absoluteMenuPath = `${workspaceCwd.replace(separator === '\\' ? /[\\/]+$/ : /\/+$/, '')}${separator}${menu?.path.replaceAll('/', separator) ?? ''}`;
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
            data-file-tree-context-menu-root="true"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              menu.context.restoreFocus();
            }}
          >
            {(/\.(?:md|markdown|html?)$/i.test(menu.path) ||
              getImageMimeTypeFromPath(menu.path)) && (
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
          title={`${workspaceCwd}/${selectedPath ?? ''}`}
        >
          {workspaceCwd.split(/[\\/]/).filter(Boolean).at(-1)}
          {selectedPath && <> / {selectedPath}</>}
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
          >
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
              aria-label={t('files.title')}
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
                    <span>{directory.path || t('files.title')}: </span>
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
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}
