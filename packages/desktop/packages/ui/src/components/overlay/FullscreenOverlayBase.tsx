/**
 * FullscreenOverlayBase - Base component for all fullscreen overlays
 *
 * Uses Radix Dialog primitives for proper:
 * - Focus management (blur on open, restore on close)
 * - ESC key handling
 * - Coordination with other Radix components (popovers, dropdowns)
 * - Accessibility (role="dialog", aria-modal)
 *
 * Additionally handles:
 * - macOS traffic light hiding (via PlatformContext)
 * - Default scenic background (bg-foreground-3 + fullscreen-overlay-background blur)
 *   Callers can override via className (twMerge resolves conflicts)
 * - Optional structured header with badges (typeBadge, filePath, title, subtitle)
 * - Optional built-in copy button (copyContent prop)
 * - Full-viewport scroll container with edge-to-edge gradient fade mask (iOS-style contentInset).
 *   The scroll area covers the entire viewport — content scrolls behind the floating header.
 *   A CSS mask gradient fades content at both edges (top and bottom, starting from y=0).
 *   The header floats on top and covers content behind it.
 *   Content padding clears the header at rest so nothing is clipped initially.
 *
 * Layout:
 *   Dialog.Content (fixed inset-0, relative)
 *   ├── Masked area (absolute inset-0, CSS mask gradient)
 *   │   └── Scroll container (h-full, overflow-y-auto, paddingTop = header + fade)
 *   │       └── {error banner}
 *   │       └── {children}
 *   └── Header (absolute top-0, z-10, floating on top of scroll content)
 *
 * Used by: PreviewOverlay, DocumentFormattedMarkdownOverlay, WorkspaceCreationScreen
 */

import { useEffect, useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'
import { getDismissibleLayerBridge } from '../../lib/dismissible-layer-bridge'
import { FullscreenOverlayBaseHeader, type OverlayTypeBadge } from './FullscreenOverlayBaseHeader'
import { OverlayErrorBanner, type OverlayErrorBannerProps } from './OverlayErrorBanner'

// Z-index for fullscreen overlays - must be above app chrome (z-overlay: 300)
// Uses CSS variable when available, falls back to hardcoded value
const Z_FULLSCREEN = 'var(--z-fullscreen, 350)'

// HEADER_HEIGHT must match PreviewHeader's height prop (48px).
// FADE_SIZE is the transition zone where content fades in/out at edges.
const HEADER_HEIGHT = 48
const FADE_SIZE = 24

// Edge-to-edge gradient fade mask — starts at y=0, fades over FADE_SIZE at both edges.
// The floating header covers content behind it; the mask just provides the smooth fade.
const FADE_MASK = `linear-gradient(to bottom, transparent 0px, black ${FADE_SIZE}px, black calc(100% - ${FADE_SIZE}px), transparent 100%)`

export interface FullscreenOverlayBaseProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close (ESC key triggers this) */
  onClose: () => void
  /** Content to render inside the overlay */
  children: ReactNode
  /** Additional CSS classes for the container */
  className?: string
  /** Accessible title for the overlay (visually hidden) */
  accessibleTitle?: string

  // --- Structured header props (optional) ---
  // When any of these are provided, a FullscreenOverlayBaseHeader is rendered above children.

  /** Type badge — tool/format indicator (e.g. "Read", "Image", "Bash") */
  typeBadge?: OverlayTypeBadge
  /** File path — shows dual-trigger menu badge with "Open" + "Reveal in {file manager}" */
  filePath?: string
  /** Title — displayed as a badge when no filePath */
  title?: string
  /** Click handler for the title badge */
  onTitleClick?: () => void
  /** Subtitle — extra info badge (e.g. "Lines 1-50 of 200") */
  subtitle?: string
  /** Right-side header actions (e.g. diff controls) */
  headerActions?: ReactNode
  /** When provided, renders a built-in copy button in the header right actions area */
  copyContent?: string

  /** Optional error banner — rendered between header and children */
  error?: OverlayErrorBannerProps
}

export function handleFullscreenEscapeWithStack(): boolean {
  const bridge = getDismissibleLayerBridge()
  if (!bridge) return false
  return bridge.handleEscape()
}

export function FullscreenOverlayBase({
  isOpen,
  onClose,
  children,
  className,
  accessibleTitle = 'Overlay',
  typeBadge,
  filePath,
  title,
  onTitleClick,
  subtitle,
  headerActions,
  copyContent,
  error,
}: FullscreenOverlayBaseProps) {
  const { onSetTrafficLightsVisible } = usePlatform()

  // Determine if we should render the structured header.
  // Any header-related prop triggers header rendering.
  const hasHeader = !!(typeBadge || filePath || title || subtitle || headerActions || copyContent)
  const overlayIdRef = useRef(`fullscreen-overlay-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    if (!isOpen) return

    const bridge = getDismissibleLayerBridge()
    if (!bridge) return

    return bridge.registerLayer({
      id: overlayIdRef.current,
      type: 'radix-dialog',
      priority: 100,
      close: onClose,
    })
  }, [isOpen, onClose])

  // Hide macOS traffic lights when overlay opens, restore when it closes
  // This prevents accidental clicks on window controls behind the fullscreen overlay
  useEffect(() => {
    if (!isOpen) return

    onSetTrafficLightsVisible?.(false)
    return () => onSetTrafficLightsVisible?.(true)
  }, [isOpen, onSetTrafficLightsVisible])

  // Content padding clears the floating header at rest (when present).
  // Without a header, just the fade zone inset.
  const contentPaddingTop = hasHeader ? HEADER_HEIGHT + FADE_SIZE : FADE_SIZE

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Content
          className={cn(
            'fixed inset-0 overflow-hidden outline-none',
            'bg-foreground-3 fullscreen-overlay-background',
            className
          )}
          style={{ zIndex: Z_FULLSCREEN }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(event) => {
            const handled = handleFullscreenEscapeWithStack()
            if (!handled) return

            event.preventDefault()
            event.stopPropagation()
          }}
        >
          {/* Visually hidden title for accessibility - required by Radix Dialog */}
          <Dialog.Title className="sr-only">{accessibleTitle}</Dialog.Title>

          {/* Full-viewport masked scroll area — covers the entire dialog including behind the header.
              The CSS mask gradient fades content at both edges (starting from y=0).
              Content padding clears the header at rest. */}
          <div
            className="absolute inset-0"
            style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
          >
            <div
              className="h-full overflow-y-auto"
              style={{ paddingTop: contentPaddingTop, paddingBottom: FADE_SIZE, scrollPaddingTop: contentPaddingTop }}
            >
              {/* Centering wrapper — error + content move together as a unit.
                  min-h-full ensures centering when content is small; content can grow beyond. */}
              <div className="min-h-full flex flex-col justify-center">
                {/* Error banner — inside centering flow, above content */}
                {error && (
                  <div className="px-6 pb-4">
                    <OverlayErrorBanner label={error.label} message={error.message} />
                  </div>
                )}
                {children}
              </div>
            </div>
          </div>

          {/* Floating header — rendered after scroll area so it's visually on top (DOM order).
              Positioned absolutely at the top of the viewport, above the scroll content. */}
          {hasHeader && (
            <div className="absolute top-0 left-0 right-0 z-10">
              <FullscreenOverlayBaseHeader
                onClose={onClose}
                typeBadge={typeBadge}
                filePath={filePath}
                title={title}
                onTitleClick={onTitleClick}
                subtitle={subtitle}
                headerActions={headerActions}
                copyContent={copyContent}
              />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
