/**
 * MarkdownPdfBlock - Renders ```pdf-preview code blocks as inline PDF previews.
 *
 * Loads PDF(s) from file(s) (via `src` or `items` field) and renders the first page
 * using react-pdf. Supports multiple items with a tab bar for switching between them.
 *
 * Expected JSON shapes:
 * Single item:
 * {
 *   "src": "/absolute/path/to/file.pdf",
 *   "title": "Optional title"
 * }
 *
 * Multiple items:
 * {
 *   "title": "Quarterly Reports",
 *   "items": [
 *     { "src": "/path/to/q1.pdf", "label": "Q1 Report" },
 *     { "src": "/path/to/q2.pdf", "label": "Q2 Report" }
 *   ]
 * }
 *
 * Only one Document is mounted at a time. The content area uses a fixed height
 * container to prevent layout shift when switching between items.
 *
 * Inline: Shows first page in a fixed 400px container with bottom fade + expand button.
 * Fullscreen: Opens PDFPreviewOverlay with full page-by-page navigation.
 */

import * as React from 'react'
import { FileText, Maximize2 } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { PDFPreviewOverlay } from '../overlay/PDFPreviewOverlay'
import { ItemNavigator } from '../overlay/ItemNavigator'
import { usePlatform } from '../../context/PlatformContext'
import { useTranslation } from 'react-i18next'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configure pdf.js worker using Vite's ?url import for cross-platform dev/prod compatibility
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

// ── Types ────────────────────────────────────────────────────────────────────

interface PreviewItem {
  src: string
  label?: string
}

interface PdfPreviewSpec {
  src?: string
  title?: string
  items?: PreviewItem[]
}

// ── Error boundary ───────────────────────────────────────────────────────────

class PdfBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownPdfBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownPdfBlockProps {
  code: string
  className?: string
  onCreateRegionAnnotation?: (region: { page?: number; x: number; y: number; w: number; h: number; unit: 'pixel' | 'percent' }) => void
}

export function MarkdownPdfBlock({ code, className, onCreateRegionAnnotation: _onCreateRegionAnnotation }: MarkdownPdfBlockProps) {
  const { t } = useTranslation()
  const { onReadFileBinary } = usePlatform()

  // Parse the JSON spec — supports single src or items array
  const spec = React.useMemo<PdfPreviewSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.items && Array.isArray(raw.items) && raw.items.length > 0) {
        return raw as PdfPreviewSpec
      }
      if (raw.src && typeof raw.src === 'string') {
        return raw as PdfPreviewSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  // Normalize to items array (backward compat)
  const items = React.useMemo<PreviewItem[]>(() => {
    if (!spec) return []
    if (spec.items && spec.items.length > 0) return spec.items
    if (spec.src) return [{ src: spec.src }]
    return []
  }, [spec])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  // Content cache: src path → loaded Uint8Array (master copy, never passed to react-pdf directly)
  const [contentCache, setContentCache] = React.useState<Record<string, Uint8Array>>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const activeItem = items[activeIndex]
  const activePdfData = activeItem ? contentCache[activeItem.src] : undefined

  // Load active item's content when it changes
  React.useEffect(() => {
    if (!activeItem?.src || !onReadFileBinary) return
    if (contentCache[activeItem.src]) {
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    onReadFileBinary(activeItem.src)
      .then((data) => {
        // Store a copy — react-pdf transfers ArrayBuffers to workers, detaching the original
        setContentCache((prev) => ({ ...prev, [activeItem.src]: new Uint8Array(data) }))
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to read PDF file')
      })
      .finally(() => setLoading(false))
  }, [activeItem?.src, onReadFileBinary, contentCache])

  // Stable file objects per item (ref ensures Documents don't remount on re-render).
  // Each Document gets its own Uint8Array copy since react-pdf transfers the ArrayBuffer.
  const fileObjsRef = React.useRef<Record<string, { data: Uint8Array }>>({})
  for (const [src, data] of Object.entries(contentCache)) {
    if (!fileObjsRef.current[src]) {
      fileObjsRef.current[src] = { data: new Uint8Array(data) }
    }
  }

  const activeFileObj = activeItem ? fileObjsRef.current[activeItem.src] : undefined

  // Fullscreen overlay: always provide a fresh copy (the overlay's Document will also transfer it)
  const loadPdfData = React.useCallback(async (path: string) => {
    if (contentCache[path]) return new Uint8Array(contentCache[path])
    if (!onReadFileBinary) throw new Error('Cannot load PDF')
    return onReadFileBinary(path)
  }, [contentCache, onReadFileBinary])

  const hasMultiple = items.length > 1

  // Invalid spec → fall back to code block
  if (!spec || items.length === 0) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  return (
    <PdfBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1">
            {spec.title || t('preview.pdfPreview')}
          </span>
          <div className="flex items-center gap-1">
            <ItemNavigator items={items} activeIndex={activeIndex} onSelect={setActiveIndex} />
            <button
              onClick={() => setIsFullscreen(true)}
              className={cn(
                "p-1 rounded-[6px] transition-all select-none",
                "bg-background shadow-minimal",
                "text-muted-foreground/50 hover:text-foreground",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
                hasMultiple ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              title={t('common.viewFullscreen')}
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Content area: fixed height prevents layout shift on item switch */}
        <div className="relative h-[400px] overflow-hidden">
          {/* Active Document (only one mounted at a time) */}
          {activeFileObj && (
            <div className="flex items-start justify-center bg-white p-4">
              <Document
                file={activeFileObj}
                loading={<div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.rendering')}</div>}
                error={<div className="py-6 text-center text-destructive/70 text-[13px]">{t('preview.failedToRenderPdf')}</div>}
              >
                <Page
                  pageNumber={1}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  width={500}
                />
              </Document>
            </div>
          )}

          {/* Loading state for uncached active item */}
          {!activePdfData && loading && (
            <div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.loading')}</div>
          )}

          {/* Error state for uncached active item */}
          {!activePdfData && !loading && error && (
            <div className="py-6 text-center text-destructive/70 text-[13px]">{error}</div>
          )}

          {/* Bottom fade gradient */}
          {activePdfData && (
            <div
              className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
              style={{
                background: 'linear-gradient(to bottom, transparent, var(--muted))',
                zIndex: 'var(--z-local, 10)',
              }}
            />
          )}
        </div>
      </div>

      {/* Fullscreen overlay — passes items for multi-item navigation */}
      <PDFPreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        filePath={activeItem!.src}
        items={items}
        initialIndex={activeIndex}
        loadPdfData={loadPdfData}
      />
    </PdfBlockErrorBoundary>
  )
}

