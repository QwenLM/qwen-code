/**
 * BrowserToolbar
 *
 * Electron-specific wrapper around the shared BrowserControls component.
 * Derives control state from BrowserInstanceInfo.
 */

import { BrowserControls } from '@craft-agent/ui'
import type { BrowserInstanceInfo } from '../../../shared/types'

interface BrowserToolbarProps {
  instanceInfo: BrowserInstanceInfo | null
  onNavigate: (url: string) => void
  onGoBack: () => void
  onGoForward: () => void
  onReload: () => void
  onStop: () => void
  compact?: boolean
}

export function BrowserToolbar({
  instanceInfo,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onStop,
  compact = false,
}: BrowserToolbarProps) {
  return (
    <BrowserControls
      url={instanceInfo?.url ?? ''}
      loading={instanceInfo?.isLoading ?? false}
      canGoBack={instanceInfo?.canGoBack ?? false}
      canGoForward={instanceInfo?.canGoForward ?? false}
      onNavigate={onNavigate}
      onGoBack={onGoBack}
      onGoForward={onGoForward}
      onReload={onReload}
      onStop={onStop}
      compact={compact}
      showProgressBar={!compact}
      className={
        compact
          ? 'h-auto px-1.5 py-0.5 rounded-[8px] border border-foreground/10 bg-background/70 min-w-0'
          : 'h-auto px-2 py-1.5 border-b border-border bg-background/80'
      }
    />
  )
}
