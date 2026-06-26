/**
 * MultiDiffPreviewOverlay - Overlay for multiple file changes (Edit/Write tools)
 *
 * Layout: Stacked diffs using pierre's native file headers — GitHub PR-like view.
 * Each diff renders its own file header (filename + addition/deletion counts) via @pierre/diffs.
 * No card chrome or collapse — all diffs are visible in a single scrollable area.
 *
 * Features:
 * - Stacked diffs with native pierre file headers (no custom card wrappers)
 * - Consolidated view (group by file) or individual changes
 * - Unified/split diff viewer for each change
 * - Focused change support (scroll to specific change on open)
 * - Header shows file path for single file, "N edits" summary for multiple files
 */

import * as React from 'react'
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { PencilLine, FilePlus, X } from 'lucide-react'
import { parseDiffFromFile, parsePatchFiles, type FileContents } from '@pierre/diffs'
import { ShikiDiffViewer, getDiffStats } from '../code-viewer/ShikiDiffViewer'
import { UnifiedDiffViewer, getUnifiedDiffStats } from '../code-viewer/UnifiedDiffViewer'
import { DiffViewerControls } from '../code-viewer/DiffViewerControls'
import { LANGUAGE_MAP } from '../code-viewer/language-map'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

/**
 * A single file change (Edit or Write)
 *
 * Supports two formats:
 * - Tool edit events: original/modified strings (computed diff)
 * - Codex: unifiedDiff string (pre-computed unified diff patch)
 */
export interface FileChange {
  /** Unique ID for this change */
  id: string
  /** Absolute file path */
  filePath: string
  /** Tool type: Edit or Write */
  toolType: 'Edit' | 'Write'
  /** For Edit: the old_string; For Write: empty or previous content if available */
  original: string
  /** For Edit: the new_string; For Write: the written content */
  modified: string
  /** Codex format: raw unified diff string (alternative to original/modified) */
  unifiedDiff?: string
  /** Error message if the tool failed */
  error?: string
}

/**
 * Diff viewer display preferences
 * Passed from parent to avoid localStorage usage - all settings stored in preferences.json
 */
export interface DiffViewerSettings {
  diffStyle: 'unified' | 'split'
  disableBackground: boolean
}

export interface MultiDiffPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** List of file changes to display */
  changes: FileChange[]
  /** Whether to consolidate changes by file path (default: true) */
  consolidated?: boolean
  /** ID of change to focus on initially */
  focusedChangeId?: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Render inline without dialog (for playground) */
  embedded?: boolean
  /** Initial diff viewer settings (from user preferences) */
  diffViewerSettings?: Partial<DiffViewerSettings>
  /** Callback when diff viewer settings change (to persist to preferences) */
  onDiffViewerSettingsChange?: (settings: DiffViewerSettings) => void
}

// ============================================
// Helpers
// ============================================

/** A group of changes for a single file (or a single ungrouped change) */
interface FileSection {
  key: string
  filePath: string
  changes: FileChange[]
}

/**
 * Groups changes into file sections.
 * In consolidated mode, changes to the same file are grouped together.
 * In non-consolidated mode, each change is its own section.
 */
function createFileSections(changes: FileChange[], consolidated: boolean): FileSection[] {
  if (!consolidated) {
    return changes.map(change => ({
      key: change.id,
      filePath: change.filePath,
      changes: [change],
    }))
  }

  // Group by file path, preserving order of first occurrence
  const byPath = new Map<string, FileChange[]>()
  for (const change of changes) {
    const existing = byPath.get(change.filePath) || []
    existing.push(change)
    byPath.set(change.filePath, existing)
  }

  return Array.from(byPath.entries()).map(([filePath, fileChanges]) => ({
    key: filePath,
    filePath,
    changes: fileChanges,
  }))
}

/** Compute diff stats for a single change */
function computeChangeStats(change: FileChange): { additions: number; deletions: number } {
  // Handle Codex format: unified diff string
  if (change.unifiedDiff) {
    const stats = getUnifiedDiffStats(change.unifiedDiff, change.filePath)
    return stats || { additions: 0, deletions: 0 }
  }

  // Handle original/modified string format
  const ext = change.filePath.split('.').pop()?.toLowerCase() || ''
  const lang = LANGUAGE_MAP[ext] || 'text'
  const oldFile: FileContents = { name: change.filePath, contents: change.original, lang: lang as any }
  const newFile: FileContents = { name: change.filePath, contents: change.modified, lang: lang as any }
  const fileDiff = parseDiffFromFile(oldFile, newFile)
  return getDiffStats(fileDiff)
}

// ============================================
// Main Component
// ============================================

export function MultiDiffPreviewOverlay({
  isOpen,
  onClose,
  changes,
  consolidated = true,
  focusedChangeId,
  theme = 'light',
  embedded,
  diffViewerSettings,
  onDiffViewerSettingsChange,
}: MultiDiffPreviewOverlayProps) {
  const { onOpenFileExternal } = usePlatform()

  // Ref map for scroll-to-focused-change support
  const changeRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Build file sections (grouped or ungrouped)
  const fileSections = useMemo(() => {
    return createFileSections(changes, consolidated)
  }, [changes, consolidated])

  // ── Fade-in reveal ──────────────────────────────────────────────────
  // Content starts invisible (opacity 0) while ShikiDiffViewers load and
  // scroll position is achieved. Once all diffs fire onReady AND scroll is
  // done, we reveal with a CSS transition. If everything is ready within
  // the first frame (~50ms), we skip the transition for an instant show.
  // Only count visible (non-error) diffs for reveal gating
  const diffCount = useMemo(() => changes.filter(c => !c.error).length, [changes])
  const readyCountRef = useRef(0)
  const scrollDoneRef = useRef(!focusedChangeId) // no scroll needed → already done
  const revealedRef = useRef(false)
  const mountedAtRef = useRef(performance.now())
  const [contentVisible, setContentVisible] = useState(false)
  const [animateReveal, setAnimateReveal] = useState(true)

  const checkReveal = useCallback(() => {
    if (revealedRef.current) return
    if (readyCountRef.current >= diffCount && scrollDoneRef.current) {
      revealedRef.current = true
      // If all conditions met within first frame, show instantly (no transition)
      const elapsed = performance.now() - mountedAtRef.current
      if (elapsed < 50) setAnimateReveal(false)
      setContentVisible(true)
    }
  }, [diffCount])

  const handleDiffReady = useCallback(() => {
    readyCountRef.current++
    checkReveal()
  }, [checkReveal])

  // Check reveal on mount — handles edge cases like diffCount=0 (all errors)
  useEffect(() => {
    checkReveal()
  }, [checkReveal])

  // Diff viewer controls state — initialized from props (user preferences)
  // Settings are persisted via onDiffViewerSettingsChange callback to preferences.json
  const [diffStyle, setDiffStyleInternal] = useState<'unified' | 'split'>(
    diffViewerSettings?.diffStyle ?? 'unified'
  )
  const [disableBackground, setDisableBackgroundInternal] = useState(
    diffViewerSettings?.disableBackground ?? false
  )

  // Wrap setters to also call the persistence callback
  const setDiffStyle = useCallback((style: 'unified' | 'split') => {
    setDiffStyleInternal(style)
    onDiffViewerSettingsChange?.({ diffStyle: style, disableBackground })
  }, [disableBackground, onDiffViewerSettingsChange])

  const setDisableBackground = useCallback((disabled: boolean) => {
    setDisableBackgroundInternal(disabled)
    onDiffViewerSettingsChange?.({ diffStyle, disableBackground: disabled })
  }, [diffStyle, onDiffViewerSettingsChange])

  // Compute total diff stats for the overlay header
  const totalStats = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const change of changes) {
      if (change.error) continue
      const stats = computeChangeStats(change)
      additions += stats.additions
      deletions += stats.deletions
    }
    return { additions, deletions }
  }, [changes])

  // Scroll to focused change after mount, then signal scroll completion for reveal
  useEffect(() => {
    if (!focusedChangeId) {
      scrollDoneRef.current = true
      checkReveal()
      return
    }

    // Small delay to allow ShikiDiffViewer to render (async syntax highlighting)
    const timer = setTimeout(() => {
      const el = changeRefs.current.get(focusedChangeId)
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'start' })
      }
      scrollDoneRef.current = true
      checkReveal()
    }, 150)

    return () => clearTimeout(timer)
  }, [focusedChangeId, checkReveal])

  // Determine header content based on single vs. multiple files
  const isMultiFile = fileSections.length > 1
  const totalChangeCount = fileSections.reduce((acc, s) => acc + s.changes.length, 0)

  // Type badge: for single file, show Edit/Write; for multi-file, show edit count
  const typeBadge = useMemo((): { icon: typeof PencilLine; label: string; variant: BadgeVariant } => {
    const hasWrite = changes.some(c => c.toolType === 'Write' && !c.error)
    if (isMultiFile) {
      return {
        icon: hasWrite ? FilePlus : PencilLine,
        label: `${totalChangeCount} edit${totalChangeCount !== 1 ? 's' : ''}`,
        variant: hasWrite ? 'green' : 'orange',
      }
    }
    // Single file — show tool type and count if multiple changes
    const firstSection = fileSections[0]
    if (!firstSection) return { icon: PencilLine, label: 'Edit', variant: 'orange' }
    const sectionHasWrite = firstSection.changes.some(c => c.toolType === 'Write')
    const count = firstSection.changes.length
    return {
      icon: sectionHasWrite ? FilePlus : PencilLine,
      label: count > 1
        ? `${count} ${sectionHasWrite ? 'Write' : 'Edit'}s`
        : (sectionHasWrite ? 'Write' : 'Edit'),
      variant: sectionHasWrite ? 'green' : 'orange',
    }
  }, [changes, isMultiFile, totalChangeCount, fileSections])

  // Header file path (single file) or summary title (multi-file)
  const headerFilePath = !isMultiFile ? fileSections[0]?.filePath : undefined
  const headerTitle = isMultiFile
    ? `${totalChangeCount} edit${totalChangeCount !== 1 ? 's' : ''} across ${fileSections.length} file${fileSections.length !== 1 ? 's' : ''}`
    : undefined

  // Header actions: total diff stats + viewer controls
  const headerActions = (
    <DiffViewerControls
      additions={totalStats.additions}
      deletions={totalStats.deletions}
      diffStyle={diffStyle}
      onDiffStyleChange={setDiffStyle}
      disableBackground={disableBackground}
      onBackgroundChange={setDisableBackground}
    />
  )

  // Ref callback to register each change element for scroll-to support
  const setChangeRef = useCallback((changeId: string, el: HTMLDivElement | null) => {
    if (el) {
      changeRefs.current.set(changeId, el)
    } else {
      changeRefs.current.delete(changeId)
    }
  }, [])

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={typeBadge}
      filePath={headerFilePath}
      title={headerTitle}
      headerActions={headerActions}
      embedded={embedded}
      className="bg-foreground-3"
    >
      {/* Stacked diffs — flow layout inside parent scroll container.
          Hidden until all diffs are loaded + scroll position achieved (fade-in reveal). */}
      <div
        className={cn(
          "flex px-6 min-h-full",
          animateReveal && "transition-opacity duration-150"
        )}
        style={{ opacity: contentVisible ? 1 : 0 }}
      >
        <div className="m-auto" style={{ width: 'max-content', maxWidth: '100%', minWidth: 'min(850px, 100%)' }}>
          {/* Stacked diffs: each ShikiDiffViewer renders with pierre's native file header.
              No card chrome or collapse — continuous stacked layout like a GitHub PR diff. */}
          <div className="flex flex-col gap-4">
            {fileSections.map((section) => (
              <div key={section.key} className="flex flex-col gap-4">
                {section.changes.map((change) => (
                  <div
                    key={change.id}
                    ref={(el) => setChangeRef(change.id, el)}
                    className="rounded-xl overflow-hidden bg-background shadow-minimal"
                    style={{ minHeight: change.error ? undefined : 200, borderRadius: 12 }}
                  >
                    {change.error ? (
                      // Errored change — tinted error banner
                      <div className="px-4 py-4">
                        <div
                          className="flex items-start gap-3 px-4 py-3 rounded-[8px] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted"
                          style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
                        >
                          <X className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-destructive/70 mb-0.5">
                              {change.toolType} Failed
                            </div>
                            <p className="text-sm text-destructive whitespace-pre-wrap break-words">
                              {change.error}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : change.unifiedDiff ? (
                      // Codex format: pre-computed unified diff
                      <UnifiedDiffViewer
                        unifiedDiff={change.unifiedDiff}
                        filePath={change.filePath}
                        diffStyle={diffStyle}
                        disableBackground={disableBackground}
                        disableFileHeader={false}
                        onFileHeaderClick={onOpenFileExternal}
                        theme={theme}
                        onReady={handleDiffReady}
                      />
                    ) : (
                      // original/modified string format
                      <ShikiDiffViewer
                        original={change.original}
                        modified={change.modified}
                        filePath={change.filePath}
                        diffStyle={diffStyle}
                        disableBackground={disableBackground}
                        disableFileHeader={false}
                        onFileHeaderClick={onOpenFileExternal}
                        theme={theme}
                        onReady={handleDiffReady}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </PreviewOverlay>
  )
}
