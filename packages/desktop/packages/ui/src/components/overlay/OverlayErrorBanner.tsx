/**
 * OverlayErrorBanner - Shared error banner for preview overlays
 *
 * Styled to match the TurnCard tinted-shadow pattern:
 * - 5% destructive color-mixed background
 * - shadow-tinted with --shadow-color: var(--destructive-rgb)
 * - Center-aligned, max-width matching ContentFrame card (850px)
 *
 * Rendered ABOVE the content container in each overlay.
 */

import type React from 'react'

export interface OverlayErrorBannerProps {
  /** Short label describing the error type (e.g. "Write Failed", "Read Failed") */
  label: string
  /** Full error message */
  message: string
}

export function OverlayErrorBanner({ label, message }: OverlayErrorBannerProps) {
  return (
    <div className="w-full max-w-[850px] mx-auto">
      <div
        className="px-4 py-3 rounded-[8px] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted"
        style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
      >
        <div className="text-xs font-semibold text-destructive/70 mb-0.5">{label}</div>
        <p className="text-sm text-destructive whitespace-pre-wrap break-words font-mono">{message}</p>
      </div>
    </div>
  )
}
