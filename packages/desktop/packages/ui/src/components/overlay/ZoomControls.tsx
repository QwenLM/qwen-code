import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Minus, Plus, RotateCcw } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface ZoomControlsProps {
  scale: number
  minScale: number
  maxScale: number
  zoomPresets: readonly number[]
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomToPreset: (preset: number) => void
  onZoomToFit: () => void
  onReset: () => void
  resetDisabled: boolean
  className?: string
}

function ZoomDropdown({
  zoomPercent,
  activePreset,
  zoomPresets,
  onZoomToFit,
  onZoomToPreset,
}: {
  zoomPercent: number
  activePreset: number | undefined
  zoomPresets: readonly number[]
  onZoomToFit: () => void
  onZoomToPreset: (preset: number) => void
}) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className="flex items-center gap-0.5 px-1 py-1 hover:bg-foreground/5 text-[13px] tabular-nums min-w-[4rem] justify-center transition-colors"
        title={t('overlay.zoomPresets')}
      >
        {zoomPercent}%
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute top-full right-0 mt-1 min-w-[140px] p-1',
            'bg-background rounded-[8px] shadow-strong border border-border/50',
            'animate-in fade-in-0 zoom-in-95 duration-100',
          )}
        >
          <button
            type="button"
            onClick={() => { onZoomToFit(); setIsOpen(false) }}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-[13px] rounded-[4px] hover:bg-foreground/[0.05] transition-colors"
          >
            {t('overlay.zoomToFit')}
          </button>
          <div className="h-px bg-foreground/5 my-1" />
          {zoomPresets.map(preset => (
            <button
              key={preset}
              type="button"
              onClick={() => { onZoomToPreset(preset); setIsOpen(false) }}
              className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-[13px] rounded-[4px] hover:bg-foreground/[0.05] transition-colors"
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                {activePreset === preset && <Check className="w-3.5 h-3.5" />}
              </span>
              <span className={activePreset === preset ? 'font-medium' : ''}>
                {preset}%
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ZoomControls({
  scale,
  minScale,
  maxScale,
  zoomPresets,
  onZoomIn,
  onZoomOut,
  onZoomToPreset,
  onZoomToFit,
  onReset,
  resetDisabled,
  className,
}: ZoomControlsProps) {
  const { t } = useTranslation()
  const zoomPercent = Math.round(scale * 100)
  const activePreset = zoomPresets.find(p => p === zoomPercent)

  const resetBtnClass = cn(
    'p-1.5 rounded-[6px] bg-background shadow-minimal cursor-pointer',
    'opacity-70 hover:opacity-100 transition-opacity',
    'disabled:opacity-30 disabled:cursor-not-allowed',
    'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  )

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <div className="flex items-center gap-px bg-background shadow-minimal rounded-[6px]">
        <button
          onClick={onZoomOut}
          disabled={scale <= minScale}
          className={cn(
            'p-1.5 rounded-l-[6px] cursor-pointer',
            'opacity-70 hover:opacity-100 transition-opacity',
            'disabled:opacity-30 disabled:cursor-not-allowed',
          )}
          title={t('overlay.zoomOut')}
        >
          <Minus className="w-3.5 h-3.5" />
        </button>

        <ZoomDropdown
          zoomPercent={zoomPercent}
          activePreset={activePreset}
          zoomPresets={zoomPresets}
          onZoomToFit={onZoomToFit}
          onZoomToPreset={onZoomToPreset}
        />

        <button
          onClick={onZoomIn}
          disabled={scale >= maxScale}
          className={cn(
            'p-1.5 rounded-r-[6px] cursor-pointer',
            'opacity-70 hover:opacity-100 transition-opacity',
            'disabled:opacity-30 disabled:cursor-not-allowed',
          )}
          title={t('overlay.zoomIn')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <button
        onClick={onReset}
        disabled={resetDisabled}
        className={resetBtnClass}
        title={t('overlay.zoomReset')}
      >
        <RotateCcw className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
