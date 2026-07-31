/**
 * DiffViewerControls - Header controls for diff viewer
 *
 * Displays:
 * - Change statistics (-X +Y with colored text)
 * - Diff style toggle (unified/split)
 * - Background toggle (enable/disable highlighting)
 *
 * Styled to match diffs.com controls
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { DiffSplitIcon, DiffUnifiedIcon, DiffBackgroundIcon } from './DiffIcons'

export interface DiffViewerControlsProps {
  /** Number of added lines */
  additions: number
  /** Number of deleted lines */
  deletions: number

  /** Current diff style */
  diffStyle: 'unified' | 'split'
  /** Callback when diff style changes */
  onDiffStyleChange: (style: 'unified' | 'split') => void

  /** Whether background highlighting is disabled */
  disableBackground: boolean
  /** Callback when background toggle changes */
  onBackgroundChange: (disabled: boolean) => void

  /** Additional className */
  className?: string
}

/**
 * DiffViewerControls - Compact control bar for diff viewer settings
 *
 * Button styling matches diffs.com: opacity-60 hover:opacity-100
 */
export function DiffViewerControls({
  additions,
  deletions,
  diffStyle,
  onDiffStyleChange,
  disableBackground,
  onBackgroundChange,
  className,
}: DiffViewerControlsProps) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {/* Stats display: -X +Y */}
      <div className="flex items-center gap-2 mr-0.5 text-[13px] font-medium font-mono">
        <span className="text-destructive">-{deletions}</span>
        <span className="text-success">+{additions}</span>
      </div>

      {/* Diff style toggle - show icon for the OTHER mode (what you'll switch to) */}
      <button
        type="button"
        onClick={() => onDiffStyleChange(diffStyle === 'unified' ? 'split' : 'unified')}
        className="cursor-pointer p-1.5 rounded-[6px] bg-background shadow-minimal opacity-70 hover:opacity-100 transition-opacity"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={diffStyle === 'unified' ? t('diff.switchToSplit') : t('diff.switchToUnified')}
        aria-label={diffStyle === 'unified' ? t('diff.switchToSplit') : t('diff.switchToUnified')}
      >
        {/* Show split icon when in unified (to switch TO split), and vice versa */}
        {diffStyle === 'unified' ? <DiffSplitIcon /> : <DiffUnifiedIcon />}
      </button>

      {/* Background toggle */}
      <button
        type="button"
        onClick={() => onBackgroundChange(!disableBackground)}
        className={cn(
          'cursor-pointer p-1.5 rounded-[6px] bg-background shadow-minimal transition-opacity',
          disableBackground ? 'opacity-40 hover:opacity-70' : 'opacity-70 hover:opacity-100'
        )}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={disableBackground ? t('diff.enableBackground') : t('diff.disableBackground')}
        aria-label={disableBackground ? t('diff.enableBackground') : t('diff.disableBackground')}
      >
        <DiffBackgroundIcon />
      </button>
    </div>
  )
}
