/**
 * MarkdownImageBlock - Renders ```image-preview code blocks as inline image previews.
 *
 * Loads image(s) from file(s) (via `src` or `items` field) using data URLs.
 * Supports multiple items with a swipeable card stack preview.
 *
 * Expected JSON shapes:
 * Single item:
 * {
 *   "src": "/absolute/path/to/image.png",
 *   "title": "Optional title"
 * }
 *
 * Multiple items:
 * {
 *   "title": "Before/After",
 *   "items": [
 *     { "src": "/path/to/before.png", "label": "Before" },
 *     { "src": "/path/to/after.png", "label": "After" }
 *   ]
 * }
 */

import * as React from 'react'
import { Maximize2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { ImagePreviewOverlay } from '../overlay/ImagePreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { ImageCardStack } from './ImageCardStack'
import { useTranslation } from 'react-i18next'

interface PreviewItem {
  src: string
  label?: string
  ratio?: number
}

interface ImagePreviewSpec {
  src?: string
  title?: string
  items?: PreviewItem[]
}

class ImageBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownImageBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

export interface MarkdownImageBlockProps {
  code: string
  className?: string
  onCreateRegionAnnotation?: (region: { x: number; y: number; w: number; h: number; unit: 'pixel' | 'percent' }) => void
}

function detectImageRatio(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        resolve(null)
        return
      }
      resolve(img.naturalWidth / img.naturalHeight)
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

export function MarkdownImageBlock({ code, className, onCreateRegionAnnotation: _onCreateRegionAnnotation }: MarkdownImageBlockProps) {
  const { t } = useTranslation()
  const { onReadFileDataUrl } = usePlatform()

  const spec = React.useMemo<ImagePreviewSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.items && Array.isArray(raw.items) && raw.items.length > 0) {
        return raw as ImagePreviewSpec
      }
      if (raw.src && typeof raw.src === 'string') {
        return raw as ImagePreviewSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  const items = React.useMemo<PreviewItem[]>(() => {
    if (!spec) return []
    if (spec.items && spec.items.length > 0) return spec.items
    if (spec.src) return [{ src: spec.src }]
    return []
  }, [spec])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  // Content cache: src path → data URL string
  const [contentCache, setContentCache] = React.useState<Record<string, string>>({})
  // Ratio cache: src path → intrinsic width/height ratio
  const [ratioCache, setRatioCache] = React.useState<Record<string, number>>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const activeItem = items[activeIndex]
  const safeActiveItem = activeItem ?? items[0]
  const activeDataUrl = safeActiveItem ? contentCache[safeActiveItem.src] : undefined
  const hasMultiple = items.length > 1

  React.useEffect(() => {
    if (!activeItem) {
      setActiveIndex(0)
      return
    }
    if (activeIndex > items.length - 1) {
      setActiveIndex(0)
    }
  }, [activeIndex, activeItem, items.length])

  React.useEffect(() => {
    if (!onReadFileDataUrl || items.length === 0) return

    const pendingItems = items.filter((item) => !contentCache[item.src])
    if (pendingItems.length === 0) {
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.allSettled(
      pendingItems.map(async (item) => {
        const dataUrl = await onReadFileDataUrl(item.src)
        const ratio = await detectImageRatio(dataUrl)
        return { src: item.src, dataUrl, ratio }
      })
    )
      .then((results) => {
        if (cancelled) return

        const nextCache: Record<string, string> = {}
        const nextRatios: Record<string, number> = {}
        let failedCount = 0

        for (const result of results) {
          if (result.status === 'fulfilled') {
            nextCache[result.value.src] = result.value.dataUrl
            if (result.value.ratio && Number.isFinite(result.value.ratio)) {
              nextRatios[result.value.src] = result.value.ratio
            }
          } else {
            failedCount += 1
          }
        }

        if (Object.keys(nextCache).length > 0) {
          setContentCache((prev) => ({ ...prev, ...nextCache }))
        }
        if (Object.keys(nextRatios).length > 0) {
          setRatioCache((prev) => ({ ...prev, ...nextRatios }))
        }

        if (failedCount > 0) {
          setError(
            failedCount === pendingItems.length
              ? 'Failed to load image files'
              : `Failed to load ${failedCount} image${failedCount > 1 ? 's' : ''}`
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [items, onReadFileDataUrl, contentCache])

  const handleLoadDataUrl = React.useCallback(async (path: string) => {
    if (contentCache[path]) return contentCache[path]
    if (!onReadFileDataUrl) throw new Error('Cannot load image')
    const dataUrl = await onReadFileDataUrl(path)
    setContentCache((prev) => ({ ...prev, [path]: dataUrl }))
    return dataUrl
  }, [contentCache, onReadFileDataUrl])

  if (!spec || items.length === 0 || !onReadFileDataUrl) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const stackItems = items.reduce<Array<{ src: string; label?: string; ratio?: number; alt: string }>>((acc, item, index) => {
    const dataUrl = contentCache[item.src]
    if (!dataUrl) return acc
    acc.push({
      src: dataUrl,
      label: item.label,
      ratio: item.ratio ?? ratioCache[item.src],
      alt: item.label || `Image ${index + 1}`,
    })
    return acc
  }, [])

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  if (!safeActiveItem) {
    return fallback
  }

  return (
    <ImageBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-visible', className)}>
        <div className="relative h-[320px] overflow-visible flex items-center justify-center p-3">
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              'absolute right-2 top-2 z-10 p-1 rounded-[6px] transition-all select-none',
              'bg-background/90 shadow-minimal',
              'text-muted-foreground/60 hover:text-foreground',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
              hasMultiple ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            title={t('common.viewFullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          {hasMultiple && stackItems.length > 0 && (
            <ImageCardStack
              items={stackItems}
              currentIndex={activeIndex}
              onIndexChange={setActiveIndex}
              onTopCardTap={() => setIsFullscreen(true)}
              className="max-w-full max-h-full"
            />
          )}

          {!hasMultiple && activeDataUrl && (
            <img
              src={activeDataUrl}
              alt={safeActiveItem?.label || safeActiveItem?.src.split('/').pop() || 'Image preview'}
              className="max-w-full max-h-full object-contain"
              draggable={false}
              onClick={() => setIsFullscreen(true)}
            />
          )}

          {loading && (!activeDataUrl || (hasMultiple && stackItems.length === 0)) && (
            <div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.loading')}</div>
          )}

          {!loading && error && (!activeDataUrl || (hasMultiple && stackItems.length === 0)) && (
            <div className="py-6 text-center text-destructive/70 text-[13px]">{error}</div>
          )}

        </div>
      </div>

      <ImagePreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        filePath={safeActiveItem.src}
        items={items}
        initialIndex={activeIndex}
        loadDataUrl={handleLoadDataUrl}
        title={spec.title}
      />
    </ImageBlockErrorBoundary>
  )
}
