/**
 * FullscreenOverlayBaseHeader - Header component for fullscreen overlays
 *
 * Builds a badge row from structured props (typeBadge, filePath, title, subtitle).
 * The file path badge has a dual-trigger menu:
 * - Left-click → Radix DropdownMenu with "Open" / "Reveal in {file manager}"
 * - Right-click → Radix ContextMenu with the same items
 *
 * Both menus share one internal items array, just wrapped differently.
 * onOpenFileExternal and onRevealInFinder come from PlatformContext — no per-overlay callbacks.
 */

import { useState, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Check, Copy, ExternalLink, FolderOpen, type LucideIcon } from 'lucide-react'
import { PreviewHeader, PreviewHeaderBadge, type PreviewBadgeVariant } from '../ui/PreviewHeader'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

/** Structured type badge — tool/format indicator (e.g. "Read", "Image", "Bash") */
export interface OverlayTypeBadge {
  icon: LucideIcon
  label: string
  variant?: PreviewBadgeVariant
}

export interface FullscreenOverlayBaseHeaderProps {
  /** Close handler — shows X button in header */
  onClose: () => void
  /** Type badge — tool/format indicator */
  typeBadge?: OverlayTypeBadge
  /** File path — shows dual-trigger menu badge with "Open" + "Reveal in {file manager}" */
  filePath?: string
  /** Title — displayed as a badge. Fallback when no file path. */
  title?: string
  /** Click handler for the title badge */
  onTitleClick?: () => void
  /** Subtitle — extra info badge (e.g. "Lines 1-50 of 200") */
  subtitle?: string
  /** Right-side actions (e.g. diff controls) */
  headerActions?: ReactNode
  /** When provided, renders a built-in copy button (matching close button style) */
  copyContent?: string
}

/**
 * Truncates a file path to show just the filename for display in the badge.
 * Full path is available via tooltip.
 */
function displayPath(filePath: string): string {
  const parts = filePath.split('/')
  const name = parts.pop() || filePath
  // Show parent dir + filename if available (e.g. "src/App.tsx")
  if (parts.length > 0) {
    const parent = parts.pop()
    return `${parent}/${name}`
  }
  return name
}

// ============================================================================
// Shared context menu styling — matches StyledDropdown's popover-styled look
// ============================================================================

const contextMenuContentClasses = cn(
  'popover-styled z-dropdown min-w-40 overflow-hidden p-1',
  'w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5',
  'animate-in fade-in-0 zoom-in-95'
)

const contextMenuItemClasses = cn(
  'relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none',
  '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  'pr-4 rounded-[4px] hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]',
  '[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0'
)

// ============================================================================
// FilePathBadge — badge with dual-trigger menu (dropdown + context menu)
// ============================================================================

interface FilePathBadgeProps {
  filePath: string
}

/**
 * FilePathBadge - Badge that opens a menu on both left-click and right-click.
 *
 * Implementation: Wraps a Radix DropdownMenu (left-click trigger) inside a
 * Radix ContextMenu (right-click trigger). Both render the same menu items.
 * Uses onOpenFileExternal (not onOpenFile) from PlatformContext — when already
 * viewing a file in an overlay, "Open" should launch the system editor directly,
 * not re-trigger the in-app preview interceptor.
 */
function FilePathBadge({ filePath }: FilePathBadgeProps) {
  const { onOpenFileExternal, onRevealInFinder, fileManagerName } = usePlatform()
  const revealLabel = `Reveal in ${fileManagerName || 'Finder'}`

  const handleOpen = useCallback(() => {
    onOpenFileExternal?.(filePath)
  }, [onOpenFileExternal, filePath])

  const handleReveal = useCallback(() => {
    onRevealInFinder?.(filePath)
  }, [onRevealInFinder, filePath])

  // Shared menu items — same content rendered by both dropdown and context menu
  const hasMenuItems = !!onOpenFileExternal || !!onRevealInFinder

  const dropdownItems = (
    <>
      {onOpenFileExternal && (
        <StyledDropdownMenuItem onSelect={handleOpen}>
          <ExternalLink />
          Open
        </StyledDropdownMenuItem>
      )}
      {onRevealInFinder && (
        <StyledDropdownMenuItem onSelect={handleReveal}>
          <FolderOpen />
          {revealLabel}
        </StyledDropdownMenuItem>
      )}
    </>
  )

  const contextItems = (
    <>
      {onOpenFileExternal && (
        <ContextMenu.Item className={contextMenuItemClasses} onSelect={handleOpen}>
          <ExternalLink />
          Open
        </ContextMenu.Item>
      )}
      {onRevealInFinder && (
        <ContextMenu.Item className={contextMenuItemClasses} onSelect={handleReveal}>
          <FolderOpen />
          {revealLabel}
        </ContextMenu.Item>
      )}
    </>
  )

  const display = displayPath(filePath)

  // If no menu items available (e.g. web viewer), just show a static badge
  if (!hasMenuItems) {
    return <PreviewHeaderBadge label={display} title={filePath} shrinkable />
  }

  // Wrap: ContextMenu (right-click) wraps DropdownMenu (left-click) wraps the badge
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Badge that responds to left-click (dropdown) and right-click (context menu) */}
            <button
              className={cn(
                'flex items-center gap-1.5 h-[26px] px-2.5 rounded-[6px]',
                'font-sans text-[13px] font-medium text-foreground/70',
                'bg-background shadow-minimal',
                'min-w-0 cursor-pointer group'
              )}
              title={filePath}
            >
              <span className="truncate group-hover:underline">{display}</span>
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent sideOffset={6} align="center" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
            {dropdownItems}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={contextMenuContentClasses}>
          {contextItems}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

// ============================================================================
// FullscreenOverlayBaseHeader
// ============================================================================

export function FullscreenOverlayBaseHeader({
  onClose,
  typeBadge,
  filePath,
  title,
  onTitleClick,
  subtitle,
  headerActions,
  copyContent,
}: FullscreenOverlayBaseHeaderProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!copyContent) return
    try {
      await navigator.clipboard.writeText(copyContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [copyContent])

  // Built-in copy button + any custom header actions, rendered in PreviewHeader's right actions area
  const rightActions = (
    <>
      {copyContent != null && (
        <button
          onClick={handleCopy}
          className={cn(
            'p-1.5 rounded-[6px] bg-background shadow-minimal cursor-pointer',
            'opacity-70 hover:opacity-100 transition-opacity',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
          title={copied ? t('common.copied') : t('common.copyAll')}
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      )}
      {headerActions}
    </>
  )

  return (
    <PreviewHeader onClose={onClose} height={48} rightActions={rightActions}>
      {typeBadge && (
        <PreviewHeaderBadge
          icon={typeBadge.icon}
          label={typeBadge.label}
          variant={typeBadge.variant}
        />
      )}
      {filePath ? (
        <FilePathBadge filePath={filePath} />
      ) : title ? (
        <PreviewHeaderBadge label={title} onClick={onTitleClick} shrinkable />
      ) : null}
      {subtitle && <PreviewHeaderBadge label={subtitle} />}
    </PreviewHeader>
  )
}
