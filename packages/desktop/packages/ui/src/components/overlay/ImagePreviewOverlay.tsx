/**
 * ImagePreviewOverlay - In-app image preview for the link interceptor and markdown blocks.
 */

import * as React from 'react'
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Image } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import { ZoomControls } from './ZoomControls'
import { RICH_BLOCK_DEFAULTS } from './rich-block-interaction-spec'
import { useRichBlockInteractions } from './useRichBlockInteractions'

interface PreviewItem {
  src: string
  label?: string
}

export interface ImagePreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  items?: PreviewItem[]
  initialIndex?: number
  title?: string
  loadDataUrl: (path: string) => Promise<string>
  theme?: 'light' | 'dark'
}

export function ImagePreviewOverlay({
  isOpen,
  onClose,
  filePath,
  items,
  initialIndex = 0,
  title,
  loadDataUrl,
  theme = 'light',
}: ImagePreviewOverlayProps) {
  const { t } = useTranslation()
  const resolvedItems = useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    return [{ src: filePath }]
  }, [items, filePath])

  const [activeIdx, setActiveIdx] = useState(initialIndex)
  const [contentCache, setContentCache] = useState<Record<string, string>>({})
  const [dimensionsCache, setDimensionsCache] = useState<Record<string, { width: number; height: number }>>({})
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const containerRef = React.useRef<HTMLDivElement>(null)

  const {
    scale,
    translate,
    isDragging,
    isAnimating,
    setIsAnimating,
    zoomByStep,
    zoomToPreset,
    zoomToFit,
    reset,
    onMouseDown,
    onDoubleClick,
  } = useRichBlockInteractions({
    isOpen,
    containerRef,
  })

  const activeItem = resolvedItems[activeIdx]
  const activeDataUrl = activeItem ? contentCache[activeItem.src] : null
  const activeDimensions = activeItem ? dimensionsCache[activeItem.src] : null

  useEffect(() => {
    if (isOpen) {
      const bounded = Math.max(0, Math.min(initialIndex, resolvedItems.length - 1))
      setActiveIdx(bounded)
      reset()
    }
  }, [isOpen, initialIndex, resolvedItems.length, reset])

  useEffect(() => {
    if (!isOpen) return
    reset()
  }, [activeIdx, isOpen, reset])

  useEffect(() => {
    if (!isOpen || !activeItem?.src) return
    if (contentCache[activeItem.src]) {
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    loadDataUrl(activeItem.src)
      .then((url) => {
        if (!cancelled) {
          setContentCache((prev) => ({ ...prev, [activeItem.src]: url }))
          const img = new window.Image()
          img.onload = () => {
            if (cancelled) return
            if (!img.naturalWidth || !img.naturalHeight) return
            setDimensionsCache(prev => ({
              ...prev,
              [activeItem.src]: { width: img.naturalWidth, height: img.naturalHeight },
            }))
          }
          img.src = url
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load image')
          setIsLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [isOpen, activeItem?.src, loadDataUrl, contentCache])

  const isDefaultView = scale === 1 && translate.x === 0 && translate.y === 0

  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />

      <ZoomControls
        scale={scale}
        minScale={RICH_BLOCK_DEFAULTS.minScale}
        maxScale={RICH_BLOCK_DEFAULTS.maxScale}
        zoomPresets={RICH_BLOCK_DEFAULTS.zoomPresets}
        onZoomIn={() => zoomByStep('in')}
        onZoomOut={() => zoomByStep('out')}
        onZoomToPreset={zoomToPreset}
        onZoomToFit={() => zoomToFit(activeDimensions ?? null)}
        onReset={reset}
        resetDisabled={isDefaultView}
      />

      <CopyButton content={activeItem?.src || filePath} title={t('common.copyPath')} className="bg-background shadow-minimal" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Image,
        label: 'Image',
        variant: 'purple',
      }}
      filePath={activeItem?.src || filePath}
      title={title}
      error={error ? { label: 'Load Failed', message: error } : undefined}
      headerActions={headerActions}
    >
      <div
        ref={containerRef}
        className="min-h-full flex items-center justify-center p-4 select-none"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        style={{
          cursor: isDragging ? 'grabbing' : 'grab',
          overflow: 'hidden',
        }}
      >
        {!activeDataUrl && isLoading && (
          <div className="text-muted-foreground text-sm">{t('preview.loadingImage')}</div>
        )}
        {activeDataUrl && (
          <img
            src={activeDataUrl}
            alt={activeItem?.label || activeItem?.src.split('/').pop() || 'Image preview'}
            className="max-w-full max-h-full object-contain rounded-sm"
            draggable={false}
            onTransitionEnd={() => setIsAnimating(false)}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: isAnimating ? 'transform 150ms ease-out' : 'none',
            }}
          />
        )}
      </div>
    </PreviewOverlay>
  )
}
