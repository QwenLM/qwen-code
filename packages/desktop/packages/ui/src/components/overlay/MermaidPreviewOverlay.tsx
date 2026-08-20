/**
 * MermaidPreviewOverlay — fullscreen diagram preview with zoom and pan.
 */

import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GitGraph } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ZoomControls } from './ZoomControls'
import { RICH_BLOCK_DEFAULTS } from './rich-block-interaction-spec'
import { useRichBlockInteractions } from './useRichBlockInteractions'

/** Parse width/height from an SVG string's root element attributes. */
function parseSvgDimensions(svgString: string): { width: number; height: number } | null {
  const widthMatch = svgString.match(/width="(\d+(?:\.\d+)?)"/)
  const heightMatch = svgString.match(/height="(\d+(?:\.\d+)?)"/)
  if (!widthMatch?.[1] || !heightMatch?.[1]) return null
  return { width: parseFloat(widthMatch[1]), height: parseFloat(heightMatch[1]) }
}

export interface MermaidPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  svg: string
  code: string
}

export function MermaidPreviewOverlay({
  isOpen,
  onClose,
  svg,
  code,
}: MermaidPreviewOverlayProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)

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

  const isDefaultView = scale === 1 && translate.x === 0 && translate.y === 0

  const headerActions = (
    <div className="flex items-center gap-1.5">
      <ZoomControls
        scale={scale}
        minScale={RICH_BLOCK_DEFAULTS.minScale}
        maxScale={RICH_BLOCK_DEFAULTS.maxScale}
        zoomPresets={RICH_BLOCK_DEFAULTS.zoomPresets}
        onZoomIn={() => zoomByStep('in')}
        onZoomOut={() => zoomByStep('out')}
        onZoomToPreset={zoomToPreset}
        onZoomToFit={() => zoomToFit(parseSvgDimensions(svg))}
        onReset={reset}
        resetDisabled={isDefaultView}
      />

      <CopyButton content={code} title={t('common.copyCode')} className="bg-background shadow-minimal opacity-70 hover:opacity-100" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      typeBadge={{
        icon: GitGraph,
        label: 'Diagram',
        variant: 'purple',
      }}
      title={t('overlay.mermaidDiagram')}
      headerActions={headerActions}
    >
      <div
        ref={containerRef}
        className="flex items-center justify-center select-none"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        style={{
          marginTop: -72,
          marginBottom: -24,
          height: '100vh',
          cursor: isDragging ? 'grabbing' : 'grab',
          overflow: 'hidden',
        }}
      >
        <div
          dangerouslySetInnerHTML={{ __html: svg }}
          onTransitionEnd={() => setIsAnimating(false)}
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: isAnimating ? 'transform 150ms ease-out' : 'none',
          }}
        />
      </div>
    </PreviewOverlay>
  )
}
