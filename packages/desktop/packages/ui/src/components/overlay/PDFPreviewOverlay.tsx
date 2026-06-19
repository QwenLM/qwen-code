/**
 * PDFPreviewOverlay - In-app PDF preview using Mozilla's pdf.js via react-pdf.
 *
 * Renders PDFs using the react-pdf library, which wraps pdfjs-dist.
 * Supports multiple items with arrow navigation in the header.
 *
 * The PDF is loaded from a Uint8Array (via IPC) and rendered to canvas.
 * The pdf.js worker handles decoding and rendering in a background thread.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Document, Page, pdfjs } from 'react-pdf'
import { FileText } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configure pdf.js worker using Vite's ?url import for cross-platform dev/prod compatibility
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

interface PreviewItem {
  src: string
  label?: string
}

export interface PDFPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  /** Absolute file path for the PDF (single item / backward compat) */
  filePath: string
  /** Multiple items for arrow navigation */
  items?: PreviewItem[]
  /** Initial active item index (defaults to 0) */
  initialIndex?: number
  /** Async loader that returns PDF data as Uint8Array */
  loadPdfData: (path: string) => Promise<Uint8Array>
  theme?: 'light' | 'dark'
}

export function PDFPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  items,
  initialIndex = 0,
  loadPdfData,
  theme = 'light',
}: PDFPreviewOverlayProps) {
  const { t } = useTranslation()

  // Normalize: items array or single filePath
  const resolvedItems = useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    return [{ src: filePath }]
  }, [items, filePath])

  const [activeIdx, setActiveIdx] = useState(initialIndex)
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const activeItem = resolvedItems[activeIdx]

  // Reset index when overlay opens
  useEffect(() => {
    if (isOpen) {
      setActiveIdx(initialIndex)
    }
  }, [isOpen, initialIndex])

  // Load PDF data when overlay opens or active item changes
  useEffect(() => {
    if (!isOpen || !activeItem?.src) return

    let cancelled = false
    setIsLoading(true)
    setError(null)
    setPdfData(null)
    setNumPages(0)

    loadPdfData(activeItem.src)
      .then((data) => {
        if (!cancelled) {
          setPdfData(data)
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
          setIsLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [isOpen, activeItem?.src, loadPdfData])

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
  }, [])

  const onDocumentLoadError = useCallback((error: Error) => {
    setError(`Failed to load PDF: ${error.message}`)
  }, [])

  // Memoize file object to prevent unnecessary re-renders (react-pdf uses === equality)
  const fileObj = useMemo(() =>
    pdfData ? { data: pdfData } : null,
    [pdfData]
  )

  // Header actions: item navigation + copy button
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeItem?.src || filePath} title={t('common.copyPath')} className="bg-background shadow-minimal" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: FileText,
        label: 'PDF',
        variant: 'orange',
      }}
      filePath={activeItem?.src || filePath}
      error={error ? { label: 'Load Failed', message: error } : undefined}
      headerActions={headerActions}
    >
      <div className="h-full flex flex-col items-center overflow-auto">
        {isLoading && (
          <div className="text-muted-foreground text-sm">{t('preview.loadingPdf')}</div>
        )}
        {fileObj && (
          <Document
            file={fileObj}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<div className="text-muted-foreground text-sm">{t('common.rendering')}</div>}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i + 1}
                pageNumber={i + 1}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="pdf-page"
              />
            ))}
          </Document>
        )}
      </div>
    </PreviewOverlay>
  )
}
