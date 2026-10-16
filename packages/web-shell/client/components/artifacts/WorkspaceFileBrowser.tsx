import { formatFileName } from './file-name-display';
import { safeDisplayText } from '../../hooks/useAtMentionSources';
import { usePanelRef } from 'react-resizable-panels';
import { FileTree, type ContextMenuOpenContext } from '@pierre/trees';
import {
  Code2Icon,
  EyeIcon,
  FolderIcon,
  RotateCwIcon,
  StickyNotePlusIcon,
  FolderPlusIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import {
  useEffect,
  useId,
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
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '../ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Label } from '../ui/label';
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
  const filterRef = useRef<HTMLInputElement>(null);
  const restoreFilterFocusRef = useRef(false);
  const treeLabelRef = useRef(t('files.title'));
  treeLabelRef.current = t('files.title');
  const treeRef = useRef<FileTree | undefined>(undefined);
  const nameInputId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const transferMenuFocusRef = useRef(false);
  const dialogRestoreFocusRef = useRef<(() => void) | undefined>(undefined);
  const createdRef = useRef<
    ((path: string, kind: 'file' | 'directory') => void) | undefined
  >(undefined);
  const [createTarget, setCreateTarget] = useState<{
    parent: string;
    kind: 'file' | 'directory';
  }>();
  const deletedRef = useRef<((path: string) => void) | undefined>(undefined);
  const [deletePath, setDeletePath] = useState<string>();
  const [deleteKind, setDeleteKind] = useState<'file' | 'directory'>('file');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
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
    kind: DaemonDirectoryEntry['kind'];
    context: ContextMenuOpenContext;
  }>();
  const [actionError, setActionError] = useState<string>();
  const lifetimeRef = useRef<object | undefined>(undefined);
  // Pierre restores focus synchronously and can reenter Radix dismissal.
  const closingMenuRef = useRef(false);

  useEffect(() => {
    // Wait for the group to register the nonzero preview constraints.
    const frame = requestAnimationFrame(() => {
      if (hasPreview) contentPanelRef.current?.resize('70%');
      else treePanelRef.current?.resize('100%');
    });
    return () => cancelAnimationFrame(frame);
  }, [hasPreview, contentPanelRef, treePanelRef]);

  useEffect(() => {
    if (hasPreview || !treeVisible || !restoreFilterFocusRef.current) return;
    restoreFilterFocusRef.current = false;
    const frame = requestAnimationFrame(() => {
      filterRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hasPreview, treeVisible]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    const lifetime = {};
    lifetimeRef.current = lifetime;
    setMenu(undefined);
    setCreateTarget(undefined);
    setCreating(false);
    setDeletePath(undefined);
    setDeleting(false);
    const deletedPaths = new Set<string>();
    const loads = new Map<string, object>();
    const createdEntries = new Map<string, DaemonDirectoryEntry>();
    const entries = new Map<string, DaemonDirectoryEntry>();
    const cache = new Map<string, DirectoryState>();
    const hasDirectoryActions = Boolean(
      actions.createFile || actions.createDirectory || actions.deleteDirectory,
    );
    const tree = new FileTree({
      paths: [],
      initialExpansion: 'closed',
      flattenEmptyDirectories: false,
      icons: 'complete',
      formatItemName: formatFileName,
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
        [data-truncate-content] { white-space: pre; }
      `,
      // The host supplies the visible filter instead of Pierre's search input.
      search: false,
      searchFakeFocus: true,
      searchBlurBehavior: 'retain',
      fileTreeSearchMode: 'hide-non-matches',
      composition: {
        contextMenu: {
          triggerMode: hasDirectoryActions ? 'both' : 'right-click',
          buttonVisibility: 'when-needed',
          onOpen(item, context) {
            const entry = entries.get(item.path);
            if (
              entry &&
              (entry.kind === 'file' ||
                entry.kind === 'symlink' ||
                (entry.kind === 'directory' && hasDirectoryActions))
            ) {
              closingMenuRef.current = false;
              transferMenuFocusRef.current = false;
              setActionError(undefined);
              setMenu({ path: item.path, kind: entry.kind, context });
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
      const request = {};
      loads.set(path, request);
      cache.set(path, { path });
      publish();
      try {
        const listing = await actions.listDirectory(path || '.');
        if (disposed || loads.get(path) !== request) return;
        const mergedEntries = new Map(
          listing.entries.map((entry) => [entry.name, entry]),
        );
        for (const [createdPath, entry] of createdEntries) {
          const parent = createdPath
            .replace(/\/$/, '')
            .split('/')
            .slice(0, -1)
            .join('/');
          if (parent === path) mergedEntries.set(entry.name, entry);
        }
        const listedEntries = [...mergedEntries.values()].filter(
          (entry) =>
            !deletedPaths.has(`${path ? `${path}/` : ''}${entry.name}`),
        );
        cache.set(path, {
          path,
          empty: listedEntries.length === 0,
          truncated: listing.truncated,
        });
        const added = listedEntries.flatMap((entry) => {
          const child = `${path ? `${path}/` : ''}${entry.name}${entry.kind === 'directory' ? '/' : ''}`;
          const exists = entries.has(child);
          entries.set(child, entry);
          return exists ? [] : [{ type: 'add' as const, path: child }];
        });
        const missing = added.filter((entry) => !tree.getItem(entry.path));
        if (missing.length) tree.batch(missing);
      } catch (error) {
        if (disposed || loads.get(path) !== request) return;
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
    createdRef.current = (path, kind) => {
      const child = `${path}${kind === 'directory' ? '/' : ''}`;
      if (kind === 'directory' && tree.getItem(child)) {
        deletedRef.current?.(path);
        setSelectedPath((selected) =>
          selected?.startsWith(child) ? undefined : selected,
        );
      }
      const entry: DaemonDirectoryEntry = {
        name: path.split('/').at(-1)!,
        kind,
        ignored: false,
      };
      deletedPaths.delete(path);
      createdEntries.set(child, entry);
      entries.set(child, entry);
      const parent = path.split('/').slice(0, -1).join('/');
      const directory = cache.get(parent);
      if (directory) cache.set(parent, { ...directory, empty: false });
      if (!tree.getItem(child)) tree.add(child);
      const parentItem = parent ? tree.getItem(`${parent}/`) : undefined;
      if (parentItem && 'expand' in parentItem) parentItem.expand();
      publish();
    };
    deletedRef.current = (path) => {
      const child = `${path}/`;
      deletedPaths.add(path);
      for (const key of entries.keys()) {
        if (key === path || key === child || key.startsWith(child)) {
          entries.delete(key);
          createdEntries.delete(key);
        }
      }
      for (const key of cache.keys()) {
        if (key === path || key.startsWith(child)) {
          cache.delete(key);
          loads.delete(key);
        }
      }
      if (tree.getItem(child)) tree.remove(child, { recursive: true });
      else if (tree.getItem(path)) tree.remove(path);
      const parent = path.split('/').slice(0, -1).join('/');
      const directory = cache.get(parent);
      if (directory)
        cache.set(parent, {
          ...directory,
          empty: ![...entries.keys()].some(
            (key) =>
              key.startsWith(parent ? `${parent}/` : '') &&
              key !== `${parent}/`,
          ),
        });
      publish();
    };
    uploadedRef.current = (path) => {
      if ([...deletedPaths].some((deleted) => path.startsWith(`${deleted}/`)))
        return;
      deletedPaths.delete(path);
      const parent = parentDirectory(path);
      if (!entries.has(path)) {
        const entry: DaemonDirectoryEntry = {
          name: path.split('/').at(-1)!,
          kind: 'file',
          ignored: false,
        };
        createdEntries.set(path, entry);
        entries.set(path, entry);
        if (!tree.getItem(path)) tree.add(path);
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
      createdRef.current = undefined;
      deletedRef.current = undefined;
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
    event.dataTransfer.dropEffect = uploadClient && !deleting ? 'copy' : 'none';
    if (uploadClient && !deleting) setDropDirectory(dropTarget(event));
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    setDropDirectory(undefined);
    if (!uploadClient || deleting) return;
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
    transferMenuFocusRef.current = transferFocus;
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

  const captureDialogFocus = () => {
    const focused = document.activeElement;
    const menuPath = menu?.path;
    const lifetime = lifetimeRef.current;
    dialogRestoreFocusRef.current = () => {
      if (lifetimeRef.current !== lifetime) return;
      if (menuPath) {
        const shadow = treeRef.current?.getFileTreeContainer()?.shadowRoot;
        const row = Array.from(
          shadow?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
        ).find((item) => item.dataset.itemPath === menuPath);
        (
          row ??
          shadow?.querySelector<HTMLElement>(
            '[role="treeitem"][tabindex="0"]',
          ) ??
          shadow?.querySelector<HTMLElement>('[role="tree"]')
        )?.focus();
      } else if (focused instanceof HTMLElement && focused.isConnected) {
        focused.focus();
      }
    };
  };
  const openCreate = (kind: 'file' | 'directory', parent: string) => {
    captureDialogFocus();
    setCreateName('');
    setCreateError(undefined);
    setCreateTarget({ kind, parent: parent.replace(/\/$/, '') });
  };
  const confirmCreate = async () => {
    if (!createTarget || creating) return;
    if (
      !createName.trim() ||
      createName === '.' ||
      createName === '..' ||
      /[\\/\p{Cc}]/u.test(createName)
    ) {
      setCreateError(t('files.invalidName'));
      return;
    }
    const target = createTarget;
    const create =
      target.kind === 'file' ? actions.createFile : actions.createDirectory;
    if (!create) return;
    const path = `${target.parent ? `${target.parent}/` : ''}${createName}`;
    const lifetime = lifetimeRef.current;
    setCreating(true);
    setCreateError(undefined);
    try {
      await create(path);
      if (lifetimeRef.current !== lifetime) return;
      createdRef.current?.(path, target.kind);
      setCreateTarget(undefined);
    } catch (error) {
      if (lifetimeRef.current === lifetime)
        setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      if (lifetimeRef.current === lifetime) setCreating(false);
    }
  };

  const confirmDelete = async () => {
    const remove =
      deleteKind === 'directory'
        ? actions.deleteDirectory
        : actions.deleteWorkspaceFile;
    if (!deletePath || deleting || isBusy || !remove) return;
    const path = deletePath;
    const lifetime = lifetimeRef.current;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await remove(path);
      if (lifetimeRef.current !== lifetime) return;
      deletedRef.current?.(path);
      setSelectedPath((selected) =>
        selected === path || selected?.startsWith(`${path}/`)
          ? undefined
          : selected,
      );
      setDeletePath(undefined);
    } catch (error) {
      if (lifetimeRef.current === lifetime)
        setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      if (lifetimeRef.current === lifetime) setDeleting(false);
    }
  };

  const separator = /^(?:[a-z]:[\\/]|\\\\)/i.test(workspaceCwd) ? '\\' : '/';
  const absolutePath = (path: string) =>
    path
      ? `${workspaceCwd.replace(separator === '\\' ? /[\\/]+$/ : /\/+$/, '')}${separator}${path.replaceAll('/', separator)}`
      : workspaceCwd;
  const workspaceName = formatFileName(
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
            aria-label={`${t('files.title')}: ${formatFileName(menu.path)}`}
            aria-labelledby={undefined}
            data-file-tree-context-menu-root="true"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!transferMenuFocusRef.current) menu.context.restoreFocus();
            }}
          >
            {menu.kind === 'directory' ? (
              <>
                {actions.createFile && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void runMenuAction(
                        () => openCreate('file', menu.path),
                        true,
                      )
                    }
                  >
                    {t('files.newFile')}
                  </DropdownMenuItem>
                )}
                {actions.createDirectory && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void runMenuAction(
                        () => openCreate('directory', menu.path),
                        true,
                      )
                    }
                  >
                    {t('files.newFolder')}
                  </DropdownMenuItem>
                )}
                {actions.deleteDirectory && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      captureDialogFocus();
                      const path = menu.path.replace(/\/$/, '');
                      void runMenuAction(() => {
                        setDeleteError(undefined);
                        setDeleteKind('directory');
                        setDeletePath(path);
                      }, true);
                    }}
                  >
                    {t('files.deleteMenu')}
                  </DropdownMenuItem>
                )}
              </>
            ) : (
              <>
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
                    void runMenuAction(() =>
                      writeClipboardText(absoluteMenuPath),
                    )
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
                {menu.kind === 'file' && actions.deleteWorkspaceFile && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      captureDialogFocus();
                      const path = menu.path;
                      void runMenuAction(() => {
                        setDeleteError(undefined);
                        setDeleteKind('file');
                        setDeletePath(path);
                      }, true);
                    }}
                  >
                    {t('files.deleteMenu')}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog
        open={createTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !creating) setCreateTarget(undefined);
        }}
      >
        <DialogContent
          showCloseButton={!creating}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nameInputRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (creating) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (creating) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            dialogRestoreFocusRef.current?.();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                createTarget?.kind === 'directory'
                  ? 'files.newFolder'
                  : 'files.newFile',
              )}
            </DialogTitle>
            <DialogDescription className="break-all">
              {t('files.destination')}:{' '}
              {safeDisplayText(absolutePath(createTarget?.parent ?? ''))}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirmCreate();
            }}
          >
            <Label htmlFor={nameInputId}>{t('files.name')}</Label>
            <Input
              className="mt-2"
              id={nameInputId}
              ref={nameInputRef}
              value={createName}
              disabled={creating}
              onChange={(event) => {
                setCreateName(event.target.value);
                setCreateError(undefined);
              }}
              aria-invalid={Boolean(createError)}
            />
            {createError && (
              <div
                role="alert"
                className="mt-2 break-words text-sm text-destructive"
              >
                {createError}
              </div>
            )}
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={creating}
                onClick={() => setCreateTarget(undefined)}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={creating || !createName.trim()}>
                {t(creating ? 'files.creating' : 'files.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deletePath !== undefined}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeletePath(undefined);
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (deleting) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            dialogRestoreFocusRef.current?.();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                deleteKind === 'directory'
                  ? 'files.deleteFolderTitle'
                  : 'files.deleteTitle',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                deleteKind === 'directory'
                  ? 'files.deleteFolderWarning'
                  : 'files.deleteWarning',
              )}
              <span className="mt-2 block break-all font-medium text-foreground">
                {safeDisplayText(
                  deleteKind === 'file'
                    ? absolutePath(deletePath ?? '')
                    : deletePath,
                )}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div role="alert" className="break-words text-sm text-destructive">
              {deleteError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting || isBusy}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {t(
                deleting
                  ? 'files.deleting'
                  : deleteKind === 'file'
                    ? 'files.delete'
                    : 'files.deleteMenu',
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <header className={styles.toolbar}>
        <span
          className={styles.path}
          title={formatFileName(absolutePath(selectedPath ?? ''))}
        >
          {workspaceName}
          {selectedPath && <> / {formatFileName(selectedPath)}</>}
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
        {actions.createFile && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('files.newFile')}
            title={t('files.newFile')}
            onClick={() => openCreate('file', '')}
          >
            <StickyNotePlusIcon />
          </Button>
        )}
        {actions.createDirectory && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('files.newFolder')}
            title={t('files.newFolder')}
            onClick={() => openCreate('directory', '')}
          >
            <FolderPlusIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setVersion((value) => value + 1)}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
        >
          <RotateCwIcon />
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
        {hasPreview && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('files.closePreview')}
            title={t('files.closePreview')}
            onClick={() => {
              restoreFilterFocusRef.current = true;
              treeRef.current?.getItem(selectedPath)?.deselect();
              treePanelRef.current?.expand();
              setSelectedPath(undefined);
            }}
          >
            <XIcon />
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
                ref={filterRef}
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
                        ? formatFileName(directory.path)
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
