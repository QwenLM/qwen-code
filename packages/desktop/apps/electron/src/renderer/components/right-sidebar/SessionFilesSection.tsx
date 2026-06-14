/**
 * SessionFilesSection - Displays files in the session directory as a tree view
 *
 * Features:
 * - Recursive tree view with expandable folders (matches sidebar styling)
 * - File watcher for auto-refresh when files change
 * - Click to preview in-app, double-click to open
 * - Right-click context menu with "Open" / "Show in {file manager}" actions
 * - Persisted expanded folder state per session
 *
 * Styling matches LeftSidebar patterns:
 * - Chevron hidden by default, shown on hover
 * - Vertical connector lines for nested items
 * - 14x14px icons, 8px gaps, 6px radius
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { File, Folder, FolderOpen, FileText, Image, FileCode, ChevronRight, ExternalLink } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import type { SessionFile } from '../../../shared/types'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'
import { useAppShellContext } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import { restoreSessionFileWatch } from './session-files-watch'

/**
 * Stagger animation variants for child items - matches LeftSidebar pattern
 * Creates a pleasing "cascade" effect when expanding folders
 */
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.01,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.015,
      staggerDirection: -1,
    },
  },
}

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: 'easeOut' },
  },
  exit: {
    opacity: 0,
    x: -8,
    transition: { duration: 0.1, ease: 'easeIn' },
  },
}

export interface SessionFilesSectionProps {
  sessionId?: string
  className?: string
  /** Absolute session folder path for header actions (e.g. View in Finder) */
  sessionFolderPath?: string
  /** Hide section header when embedded inside compact containers (e.g. popovers) */
  hideHeader?: boolean
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Collect all directory paths recursively so the tree can start fully expanded. */
function collectDirectoryPaths(entries: SessionFile[]): string[] {
  const directories: string[] = []
  const visit = (items: SessionFile[]) => {
    for (const item of items) {
      if (item.type === 'directory') {
        directories.push(item.path)
        if (item.children && item.children.length > 0) {
          visit(item.children)
        }
      }
    }
  }
  visit(entries)
  return directories
}

/**
 * Get icon for file based on name/type (14x14px matching sidebar)
 */
function getFileIcon(file: SessionFile, isExpanded?: boolean) {
  const iconClass = "h-3.5 w-3.5 text-muted-foreground"

  if (file.type === 'directory') {
    return isExpanded
      ? <FolderOpen className={iconClass} />
      : <Folder className={iconClass} />
  }

  const ext = file.name.split('.').pop()?.toLowerCase()

  if (ext === 'md' || ext === 'markdown') {
    return <FileText className={iconClass} />
  }

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext || '')) {
    return <Image className={iconClass} />
  }

  if (['ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'py', 'rb', 'go', 'rs'].includes(ext || '')) {
    return <FileCode className={iconClass} />
  }

  return <File className={iconClass} />
}

/**
 * Extensions that have thumbnail previews via the thumbnail:// protocol.
 * Matches the ALL_PREVIEWABLE set in thumbnail-protocol.ts.
 */
const PREVIEWABLE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif',
  'pdf', 'svg', 'psd', 'ai',
])

/**
 * Extensions that get lightweight image previews in web mode.
 * Excludes pdf/psd/ai/svg — not rendered as <img> thumbnails here.
 */
const WEB_PREVIEWABLE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
])

/** True when running in web UI (browser) rather than Electron. */
const isWebMode = window.electronAPI.getRuntimeEnvironment() === 'web'

/**
 * Constructs a thumbnail:// protocol URL for a given file path.
 * The path is URI-encoded so it can be embedded safely in a URL.
 * Works cross-platform (macOS paths start with /, Windows with C:\).
 */
function getThumbnailUrl(filePath: string): string {
  return `thumbnail://thumb/${encodeURIComponent(filePath)}`
}

/**
 * FileThumbnail — Renders an image thumbnail with cross-fade from icon fallback.
 *
 * In Electron: loads via the custom thumbnail:// protocol (efficient 64x64 resize).
 * In Web mode: loads via readFilePreviewDataUrl RPC (server-side resized preview).
 *
 * Shows the Lucide icon immediately, then cross-fades to the thumbnail on load.
 * If loading fails, the icon stays visible — no layout shift, no error state.
 */
const FileThumbnail = memo(function FileThumbnail({ file }: { file: SessionFile }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  // Reset state when file changes (e.g. watcher triggered re-render)
  useEffect(() => {
    setLoaded(false)
    setFailed(false)
    setDataUrl(null)
  }, [file.path])

  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  const previewableSet = isWebMode ? WEB_PREVIEWABLE_EXTENSIONS : PREVIEWABLE_EXTENSIONS
  const canPreview = previewableSet.has(ext)

  // Web mode: load a small preview via RPC as a base64 data URL
  useEffect(() => {
    if (!isWebMode || !canPreview || failed) return
    let cancelled = false
    window.electronAPI.readFilePreviewDataUrl(file.path, 64).then((url) => {
      if (!cancelled) setDataUrl(url)
    }).catch(() => {
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [file.path, canPreview, failed])

  // Fall back to regular icon if not previewable or thumbnail failed
  if (!canPreview || failed) {
    return getFileIcon(file)
  }

  const imgSrc = isWebMode ? dataUrl : getThumbnailUrl(file.path)

  return (
    <>
      {/* Fallback icon — visible initially, fades out when thumbnail loads */}
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center transition-opacity duration-200',
          loaded ? 'opacity-0' : 'opacity-100'
        )}
      >
        {getFileIcon(file)}
      </span>
      {/* Thumbnail — fades in on successful load */}
      {imgSrc && (
        <img
          src={imgSrc}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            'absolute inset-0 h-full w-full rounded-[2px] object-cover transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0'
          )}
        />
      )}
    </>
  )
})

interface FileTreeItemProps {
  file: SessionFile
  depth: number
  expandedPaths: Set<string>
  onToggleExpand: (path: string) => void
  onFileClick: (file: SessionFile) => void
  onFileDoubleClick: (file: SessionFile) => void
  onRevealInFileManager: (path: string) => void
  /** Whether this item is inside an expanded folder (for stagger animation) */
  isNested?: boolean
}

/**
 * Recursive file tree item component
 * Matches LeftSidebar styling patterns exactly:
 * - Vertical line on container level (not per-item)
 * - Framer-motion staggered animation for expand/collapse
 * - Chevron shown on hover, icon hidden
 */
function FileTreeItem({
  file,
  depth,
  expandedPaths,
  onToggleExpand,
  onFileClick,
  onFileDoubleClick,
  onRevealInFileManager,
  isNested,
}: FileTreeItemProps) {
  const { t } = useTranslation()
  const isDirectory = file.type === 'directory'
  const isExpanded = expandedPaths.has(file.path)
  const hasChildren = isDirectory && file.children && file.children.length > 0

  const handleClick = () => {
    if (isDirectory && hasChildren) {
      onToggleExpand(file.path)
    } else {
      onFileClick(file)
    }
  }

  const handleDoubleClick = () => {
    onFileDoubleClick(file)
  }

  // Handle chevron click separately to toggle expand
  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (hasChildren) {
      onToggleExpand(file.path)
    }
  }

  // The button element for the file/folder item
  const buttonElement = (
    <button
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        // Base styles matching LeftSidebar exactly
        // min-w-0 and overflow-hidden required for truncation to work in grid context
        "group flex w-full min-w-0 overflow-hidden items-center gap-2 rounded-[6px] py-[5px] text-[13px] select-none outline-none text-left",
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        "hover:bg-sidebar-hover transition-colors",
        // Same padding for all items - nested indentation handled by container
        "px-2"
      )}
      title={`${file.path}\n${file.type === 'file' ? formatFileSize(file.size) : 'Directory'}\n\nClick to ${hasChildren ? 'expand' : 'reveal'}, double-click to open`}
    >
      {/* Icon container with hover-revealed chevron for expandable items */}
      <span className="relative h-3.5 w-3.5 shrink-0 flex items-center justify-center">
        {hasChildren ? (
          <>
            {/* Main icon - hidden on hover */}
            <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0 transition-opacity duration-150">
              {getFileIcon(file, isExpanded)}
            </span>
            {/* Toggle chevron - shown on hover */}
            <span
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer"
              onClick={handleChevronClick}
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                  isExpanded && "rotate-90"
                )}
              />
            </span>
          </>
        ) : (
          /* Non-directory files: show thumbnail preview for previewable types,
             with cross-fade from icon. Falls back to icon for unsupported types. */
          <FileThumbnail file={file} />
        )}
      </span>

      {/* File/folder name - min-w-0 required for truncate to work in flex container */}
      <span className="flex-1 min-w-0 truncate">{file.name}</span>
    </button>
  )

  const fileManagerName = getFileManagerName()

  // Inner content: button and expandable children (wrapped in group/section like LeftSidebar)
  const innerContent = (
    <div className="group/section min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {buttonElement}
        </ContextMenuTrigger>
        <StyledContextMenuContent>
          {/* Open — files only (folders just show "Show in file manager") */}
          {file.type !== 'directory' && (
            <StyledContextMenuItem onSelect={() => onFileClick(file)}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t("chat.openFile")}
            </StyledContextMenuItem>
          )}
          {/* Show in file manager */}
          <StyledContextMenuItem
            onSelect={() => onRevealInFileManager(file.path)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("chat.showInFileManager", { fileManager: fileManagerName })}
          </StyledContextMenuItem>
        </StyledContextMenuContent>
      </ContextMenu>
      {/* Expandable children with framer-motion animation - matches LeftSidebar exactly */}
      {hasChildren && (
        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
              animate={{ height: 'auto', opacity: 1, marginTop: 2, marginBottom: 8 }}
              exit={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              {/* Wrapper div matches LeftSidebar recursive structure - min-w-0 allows shrinking */}
              <div className="flex flex-col select-none min-w-0">
                <motion.nav
                  className="grid gap-0.5 pl-5 pr-0 relative"
                  variants={containerVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  {/* Vertical line at container level - matches LeftSidebar pattern */}
                  <div
                    className="absolute left-[13px] top-1 bottom-1 w-px bg-foreground/10"
                    aria-hidden="true"
                  />
                  {file.children!.map((child) => (
                    <motion.div key={child.path} variants={itemVariants} className="min-w-0">
                      <FileTreeItem
                        file={child}
                        depth={depth + 1}
                        expandedPaths={expandedPaths}
                        onToggleExpand={onToggleExpand}
                        onFileClick={onFileClick}
                        onFileDoubleClick={onFileDoubleClick}
                        onRevealInFileManager={onRevealInFileManager}
                        isNested={true}
                      />
                    </motion.div>
                  ))}
                </motion.nav>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )

  // For nested items, the parent already wraps in motion.div for stagger
  // Root items use Fragment to avoid extra wrapper (matches LeftSidebar exactly)
  return <>{innerContent}</>
}

/**
 * Section displaying session files as a tree
 */
export function SessionFilesSection({ sessionId, className, sessionFolderPath, hideHeader = false }: SessionFilesSectionProps) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<SessionFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [hasSavedExpandedState, setHasSavedExpandedState] = useState(false)
  const mountedRef = useRef(true)

  // Load expanded paths from storage when session changes.
  // If no value exists yet, we default to "expand all" after files load.
  useEffect(() => {
    if (sessionId) {
      const raw = storage.getRaw(storage.KEYS.sessionFilesExpandedFolders, sessionId)
      if (raw !== null) {
        const saved = storage.get<string[]>(storage.KEYS.sessionFilesExpandedFolders, [], sessionId)
        setExpandedPaths(new Set(saved))
        setHasSavedExpandedState(true)
      } else {
        setExpandedPaths(new Set())
        setHasSavedExpandedState(false)
      }
    } else {
      setExpandedPaths(new Set())
      setHasSavedExpandedState(false)
    }
  }, [sessionId])

  // Save expanded paths to storage when they change
  const saveExpandedPaths = useCallback((paths: Set<string>) => {
    if (sessionId) {
      storage.set(storage.KEYS.sessionFilesExpandedFolders, Array.from(paths), sessionId)
    }
  }, [sessionId])

  // Load files
  const loadFiles = useCallback(async () => {
    if (!sessionId) {
      setFiles([])
      return
    }

    setIsLoading(true)
    try {
      const sessionFiles = await window.electronAPI.getSessionFiles(sessionId)
      if (mountedRef.current) {
        setFiles(sessionFiles)

        // Default behavior: expand the entire folder tree when there's no saved state yet.
        if (!hasSavedExpandedState) {
          const allDirectoryPaths = new Set(collectDirectoryPaths(sessionFiles))
          if (allDirectoryPaths.size > 0) {
            setExpandedPaths(allDirectoryPaths)
            saveExpandedPaths(allDirectoryPaths)
            setHasSavedExpandedState(true)
          }
        }
      }
    } catch (error) {
      console.error('Failed to load session files:', error)
      if (mountedRef.current) {
        setFiles([])
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [sessionId, hasSavedExpandedState, saveExpandedPaths])

  // Initial load and file watcher setup
  useEffect(() => {
    mountedRef.current = true
    loadFiles()

    if (sessionId) {
      // Start watching for file changes
      void window.electronAPI.watchSessionFiles(sessionId)

      // Listen for file change events
      const unsubscribe = window.electronAPI.onSessionFilesChanged((changedSessionId) => {
        if (changedSessionId === sessionId && mountedRef.current) {
          void loadFiles()
        }
      })

      const unsubscribeReconnect = window.electronAPI.onReconnected(() => {
        if (!mountedRef.current) return
        void restoreSessionFileWatch(sessionId, loadFiles)
      })

      return () => {
        mountedRef.current = false
        unsubscribe()
        unsubscribeReconnect()
        void window.electronAPI.unwatchSessionFiles()
      }
    }

    return () => {
      mountedRef.current = false
    }
  }, [sessionId, loadFiles])

  // Use the link interceptor (via context) so file clicks show in-app previews
  // instead of always opening in the file manager / default app.
  const { onOpenFile } = useAppShellContext()
  const fileManagerName = getFileManagerName()

  // Reveal a file/folder in the system file manager
  const handleRevealInFileManager = useCallback((path: string) => {
    window.electronAPI.showInFolder(path)
  }, [])

  // Handle file click — preview in-app if possible, open directory in file manager
  const handleFileClick = useCallback((file: SessionFile) => {
    if (file.type === 'directory') {
      // eslint-disable-next-line craft-links/no-direct-file-open -- directories can't be previewed in-app
      window.electronAPI.openFile(file.path)
    } else {
      onOpenFile(file.path)
    }
  }, [onOpenFile])

  // Handle double-click — same as single click (interceptor decides preview vs external)
  const handleFileDoubleClick = useCallback((file: SessionFile) => {
    if (file.type === 'directory') {
      // eslint-disable-next-line craft-links/no-direct-file-open -- directories can't be previewed in-app
      window.electronAPI.openFile(file.path)
    } else {
      onOpenFile(file.path)
    }
  }, [onOpenFile])

  // Toggle folder expanded state
  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      saveExpandedPaths(next)
      return next
    })
  }, [saveExpandedPaths])

  if (!sessionId) {
    return null
  }

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {/* Header - matches sidebar styling with select-none, extra top padding for visual balance */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0 select-none">
          <span className="text-xs font-medium text-muted-foreground">{t("chat.sessionFiles")}</span>
          {sessionFolderPath && (
            <button
              type="button"
              onClick={() => window.electronAPI.showInFolder(sessionFolderPath)}
              className="text-xs text-foreground/50 hover:text-foreground/80 hover:underline underline-offset-2 transition-colors"
            >
              {t("chat.viewInFileManager", { fileManager: fileManagerName })}
            </button>
          )}
        </div>
      )}

      {/* File tree - px-2 is on nav to match LeftSidebar exactly (constrains grid width) */}
      {/* overflow-x-hidden prevents horizontal scroll, forcing truncation */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-2 min-h-0">
        {files.length === 0 ? (
          <div className="px-4 text-muted-foreground select-none">
            <p className="text-xs">
              {isLoading ? t('chat.sessionFilesLoading') : t('chat.sessionFilesEmpty')}
            </p>
          </div>
        ) : (
          /* Root nav has px-2 to match LeftSidebar exactly - this constrains grid width */
          <nav className="grid gap-0.5 px-2">
            {files.map((file) => (
              <FileTreeItem
                key={file.path}
                file={file}
                depth={0}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onFileClick={handleFileClick}
                onFileDoubleClick={handleFileDoubleClick}
                onRevealInFileManager={handleRevealInFileManager}
              />
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
