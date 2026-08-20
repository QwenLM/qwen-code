/**
 * ContentFrame - Shared terminal-style card frame for all preview overlays
 *
 * Provides the "app window" look: rounded card with a centered title bar,
 * centered on a bg-foreground-3 background. Supports optional left and right sidebars
 * rendered outside the card (e.g., file navigation in MultiDiffPreviewOverlay).
 *
 * The card is always centered in the viewport. Sidebars are positioned absolutely
 * so they hang off the card edges without shifting its center position.
 *
 * The card grows to fit its content — no internal scrolling. When the card is taller
 * than the viewport, the parent scroll container (provided by FullscreenOverlayBase or
 * PreviewOverlay's contentArea) scrolls the entire card ("paper scrolling").
 * Uses margin:auto for centering which gracefully handles overflow (unlike items-center
 * which can clip the top of overflowing content).
 *
 * Width modes:
 *   - Default: card fills available width up to maxWidth (numeric, default 850px).
 *   - fitContent: card uses CSS `width: max-content` to grow to its content width.
 *     Useful for overlays with variable-width content (e.g., diff tables). Capped at
 *     100% of the outer container, floored at minWidth. More reliable than JS measurement
 *     because it works with async-rendered content (Shiki syntax highlighting).
 *
 * Layout (flow-based — lives inside the parent's scroll container):
 *   flex, px-6, min-h-full
 *     └── relative wrapper (max-w constrained, m-auto centered, grows to content)
 *          ├── leftSidebar?  (absolute, right-full — hangs left of card)
 *          ├── Card (rounded-2xl, bg-background, shadow-strong, grows to content)
 *          │    ├── Title bar (centered title label)
 *          │    └── children (grows naturally)
 *          └── rightSidebar? (absolute, left-full — hangs right of card)
 *
 * Used by: TerminalPreviewOverlay, CodePreviewOverlay, GenericOverlay,
 *          JSONPreviewOverlay, MultiDiffPreviewOverlay
 */

import type { ReactNode } from 'react'

export interface ContentFrameProps {
  /** Title bar label displayed centered in the title bar */
  title: string
  /** Max width of the card (default: 850). Sidebars are outside this constraint.
   *  Ignored when fitContent is true (card uses max-content width instead). */
  maxWidth?: number
  /** Minimum width of the card. Only used when fitContent is true. */
  minWidth?: number
  /** When true, the card uses CSS `width: max-content` to naturally grow to fit
   *  its content width (e.g., wide diff tables). The card is capped at 100% of
   *  the viewport (minus padding) and floored at minWidth. This is more reliable
   *  than JS-based measurement because it works with async-rendered content (Shiki). */
  fitContent?: boolean
  /** Optional content rendered to the left of the card (e.g., sidebar navigation) */
  leftSidebar?: ReactNode
  /** Optional content rendered to the right of the card */
  rightSidebar?: ReactNode
  /** Content rendered inside the card, below the title bar */
  children: ReactNode
}

export function ContentFrame({
  title,
  maxWidth = 850,
  minWidth,
  fitContent,
  leftSidebar,
  rightSidebar,
  children,
}: ContentFrameProps) {
  // fitContent mode: card uses CSS max-content width to grow to its content (e.g., wide diffs).
  // Capped at 100% of the outer container so it never exceeds the viewport.
  // Fallback mode: card fills available width up to maxWidth (fixed/numeric).
  const wrapperStyle = fitContent
    ? { width: 'max-content' as const, maxWidth: '100%', minWidth }
    : { maxWidth }

  return (
    <div className="flex px-6">
      {/* Relative wrapper — horizontally centered via mx-auto. Vertical centering is handled
          by parent (FullscreenOverlayBase's centering wrapper). Card grows to fit content. */}
      <div
        className={`relative mx-auto ${fitContent ? '' : 'w-full'}`}
        style={wrapperStyle}
      >
        {/* Left sidebar — absolutely positioned to the left of the card */}
        {leftSidebar && (
          <div className="absolute right-full top-0 h-full mr-4 overflow-y-auto">
            {leftSidebar}
          </div>
        )}

        {/* Main card — grows to fit content, no internal scrolling */}
        <div className="flex flex-col rounded-2xl overflow-hidden backdrop-blur-sm shadow-strong bg-background min-h-[320px]">
          {/* Title bar */}
          <div className="flex justify-center items-center px-4 py-3 border-b border-foreground/7 select-none shrink-0">
            <div className="text-xs font-semibold tracking-wider text-foreground/30">
              {title}
            </div>
          </div>

          {/* Content area — grows naturally with content, no scroll constraint */}
          <div>
            {children}
          </div>
        </div>

        {/* Right sidebar — absolutely positioned to the right of the card */}
        {rightSidebar && (
          <div className="absolute left-full top-0 h-full ml-4 overflow-y-auto">
            {rightSidebar}
          </div>
        )}
      </div>
    </div>
  )
}
