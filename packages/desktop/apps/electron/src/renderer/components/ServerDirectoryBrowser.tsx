import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'
import type { DirectoryListingResult } from '../../shared/types'
import { FolderIcon, FolderSymlinkIcon, ChevronRightIcon } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'

/**
 * Detect paths that are clearly from the wrong platform.
 * The server directory browser runs against the server's filesystem,
 * so Windows-style paths are invalid when the server is macOS/Linux and vice versa.
 * We infer the server platform from the home directory path.
 */
function isWrongPlatformPath(path: string, serverHomePath: string | null): boolean {
  if (!serverHomePath) return false
  const serverIsUnix = serverHomePath.startsWith('/')
  if (serverIsUnix) {
    return /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  }
  // Server is Windows — reject Unix absolute paths
  return path.startsWith('/')
}

interface ServerDirectoryBrowserProps {
  open: boolean
  mode: 'browse' | 'manual'
  onSelect: (path: string) => void
  onCancel: () => void
  initialPath?: string
}

export function ServerDirectoryBrowser({
  open,
  mode,
  onSelect,
  onCancel,
  initialPath,
}: ServerDirectoryBrowserProps) {
  useRegisterModal(open, onCancel)
  const { t } = useTranslation()

  const [listing, setListing] = useState<DirectoryListingResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null)
  const [serverHomePath, setServerHomePath] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Navigate to a directory (for browse mode)
  const navigateTo = useCallback(async (dirPath: string) => {
    setLoading(true)
    setError(null)
    setSelectedEntry(null)
    try {
      const result = await window.electronAPI.listServerDirectory(dirPath)
      setListing(result)
      setPathInput(result.currentPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list directory'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load initial directory when opened
  useEffect(() => {
    if (!open) {
      // Reset state when closed
      setListing(null)
      setError(null)
      setSelectedEntry(null)
      setPathInput('')
      setServerHomePath(null)
      return
    }

    const init = async () => {
      if (mode === 'browse') {
        setLoading(true)

        // Resolve the start path with cascading fallback for backward compat:
        // 1. initialPath (if provided and valid)
        // 2. getServerHomeDir() — REMOTE_ELIGIBLE, returns server's home (new servers)
        // 3. listServerDirectory('~') — server-side ~ resolution (medium-age servers)
        // 4. listServerDirectory('/') — root directory (old servers)
        const tryNavigate = async (path: string) => {
          const result = await window.electronAPI.listServerDirectory(path)
          setListing(result)
          setPathInput(result.currentPath)
          setServerHomePath(result.currentPath)
        }

        try {
          if (initialPath) {
            await tryNavigate(initialPath)
          } else {
            // Try server home dir API first (REMOTE_ELIGIBLE — correct for remote workspaces)
            try {
              const serverHome = await window.electronAPI.getServerHomeDir()
              await tryNavigate(serverHome)
            } catch {
              // Fallback: ~ resolution (server-side)
              try {
                await tryNavigate('~')
              } catch {
                // Final fallback: root directory
                await tryNavigate('/')
              }
            }
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to list directory')
        } finally {
          setLoading(false)
        }
      } else {
        // Manual mode — fetch home dir for platform detection
        const homeDir = await window.electronAPI.getHomeDir()
        setServerHomePath(homeDir)
      }
    }
    void init()
  }, [open, mode, initialPath, navigateTo])

  // Handle path input submission (Enter key or navigate button)
  const handlePathSubmit = useCallback(() => {
    const trimmed = pathInput.trim()
    if (!trimmed) return

    // Client-side rejection of wrong-platform paths (avoids round-trip)
    if (isWrongPlatformPath(trimmed, serverHomePath)) {
      setError('This looks like a path from a different OS. Enter a path that exists on the server.')
      return
    }

    if (mode === 'browse') {
      void navigateTo(trimmed)
    } else {
      // Manual mode — just select the path
      onSelect(trimmed)
    }
  }, [pathInput, mode, navigateTo, onSelect, serverHomePath])

  // Handle selecting the current directory (or highlighted entry)
  const handleSelect = useCallback(() => {
    if (mode === 'manual') {
      handlePathSubmit()
      return
    }

    if (selectedEntry) {
      onSelect(selectedEntry)
    } else if (listing) {
      onSelect(listing.currentPath)
    } else if (pathInput.trim()) {
      onSelect(pathInput.trim())
    }
  }, [mode, selectedEntry, listing, pathInput, onSelect, handlePathSubmit])

  // Handle double-click on an entry to navigate into it
  const handleEntryDoubleClick = useCallback((entryPath: string) => {
    void navigateTo(entryPath)
  }, [navigateTo])

  // Handle single-click to select an entry
  const handleEntryClick = useCallback((entryPath: string) => {
    setSelectedEntry(prev => prev === entryPath ? null : entryPath)
  }, [])

  // Browse mode content
  const renderBrowseMode = () => (
    <>
      {/* Path input */}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handlePathSubmit()
          }}
          placeholder={t("common.enterPath")}
          className="flex-1 font-mono text-xs"
        />
        <Button variant="outline" size="sm" onClick={handlePathSubmit} disabled={loading}>
          Go
        </Button>
      </div>

      {/* Breadcrumbs */}
      {listing && (
        <div className="flex items-center gap-0.5 text-xs text-muted-foreground overflow-x-auto py-1 min-h-[24px]">
          {listing.breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-0.5 shrink-0">
              {i > 0 && <ChevronRightIcon className="size-3 text-muted-foreground/50" />}
              <button
                type="button"
                onClick={() => navigateTo(crumb.path)}
                className="hover:text-foreground hover:underline transition-colors px-0.5"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Directory listing */}
      <div className="border border-foreground/10 rounded-md overflow-hidden flex-1 min-h-0">
        <div className="overflow-y-auto max-h-[300px]">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Spinner className="text-sm" />
              Loading...
            </div>
          )}

          {error && (
            <div className="px-3 py-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && listing?.truncated && (
            <div className="border-b border-foreground/10 px-3 py-2 text-xs text-muted-foreground">
              Showing the first {listing.entries.length} folders out of {listing.totalEntries}. Narrow the path if the folder you want is missing.
            </div>
          )}

          {!loading && !error && listing && listing.entries.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No subdirectories. Use the path input above to navigate.
            </div>
          )}

          {!loading && !error && listing && listing.entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              onClick={() => handleEntryClick(entry.path)}
              onDoubleClick={() => handleEntryDoubleClick(entry.path)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors hover:bg-foreground/5 ${
                selectedEntry === entry.path ? 'bg-foreground/5' : ''
              }`}
            >
              {entry.isSymlink
                ? <FolderSymlinkIcon className="size-4 shrink-0 text-muted-foreground" />
                : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              }
              <span className="truncate">{entry.name}</span>
              {entry.isSymlink && (
                <span className="text-xs text-muted-foreground/60 shrink-0">symlink</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  )

  // Manual mode content
  const renderManualMode = () => (
    <>
      <p className="text-sm text-muted-foreground">
        Enter the full path on the server:
      </p>
      <Input
        ref={inputRef}
        value={pathInput}
        onChange={e => setPathInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleSelect()
        }}
        placeholder="/Users/username/projects/my-project"
        className="font-mono text-xs"
        autoFocus
      />
    </>
  )

  return (
    <Dialog open={open} onOpenChange={isOpen => { if (!isOpen) onCancel() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.server.selectDirectory")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {mode === 'browse' ? renderBrowseMode() : renderManualMode()}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleSelect}
            disabled={mode === 'manual' ? !pathInput.trim() : (!listing && !pathInput.trim())}
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
