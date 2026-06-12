import * as React from 'react'
import type { AnnotationV1 } from '@craft-agent/core'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip'
import { cn } from '../../lib/utils'
import { getAnnotationRectVisual, getAnnotationChipVisual } from './annotation-style-tokens'
import { getAnnotationChipInteraction } from './interaction-policy'
import type { AnnotationOverlayRect } from './annotation-core'
import type { AnnotationOverlayChip } from './annotation-overlay-geometry'

export interface AnnotationOverlayLayerProps {
  rects: AnnotationOverlayRect[]
  chips: AnnotationOverlayChip[]
  annotations?: AnnotationV1[]
  getTooltipText?: (annotation: AnnotationV1, index: number) => string
  /** Whether clicking a chip should open the annotation island/details view. */
  allowChipOpen?: boolean
  onChipOpen: (params: { annotationId: string; index: number; anchorX: number; anchorY: number; mode: 'view' }) => void
}

export function AnnotationOverlayLayer({
  rects,
  chips,
  annotations,
  getTooltipText,
  allowChipOpen = true,
  onChipOpen,
}: AnnotationOverlayLayerProps) {
  const annotationMap = React.useMemo(() => {
    return new Map((annotations ?? []).map((annotation) => [annotation.id, annotation]))
  }, [annotations])

  if (rects.length === 0 && chips.length === 0) {
    return null
  }

  return (
    <div data-ca-annotation-overlay className="pointer-events-none absolute inset-0 z-[2]">
      {rects.map((rect, idx) => {
        const rectVisual = getAnnotationRectVisual(rect)

        return (
          <div
            key={`rect-${rect.id}-${idx}`}
            className={rectVisual.className}
            style={{
              left: rect.left - 4,
              top: rect.top - 1,
              width: rect.width + 8,
              height: rect.height + 2,
              backgroundColor: rect.color,
              borderRadius: '4px',
              ...rectVisual.style,
            }}
          />
        )
      })}

      {chips.map((chip) => {
        const chipVisual = getAnnotationChipVisual(chip)
        const chipAnnotation = annotationMap.get(chip.id) ?? null
        const interaction = getAnnotationChipInteraction(chipAnnotation)
        const tooltipText = chipAnnotation && getTooltipText ? getTooltipText(chipAnnotation, chip.index) : ''

        const canOpenChip = allowChipOpen && interaction.clickable

        const chipButton = (
          <button
            type="button"
            data-ca-annotation-id={chip.id}
            data-ca-annotation-index={String(chip.index)}
            aria-disabled={!canOpenChip}
            onClick={canOpenChip ? (event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              onChipOpen({
                annotationId: chip.id,
                index: chip.index,
                anchorX: rect.left + rect.width / 2,
                anchorY: rect.top - 8,
                mode: interaction.openMode,
              })
            } : undefined}
            className={cn(chipVisual.className, !canOpenChip && 'cursor-default')}
            style={{
              left: chip.left,
              top: chip.top,
              transform: 'translate(-2px, -8px)',
              minWidth: '16px',
              height: '15px',
              padding: '0 3px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: '600',
              lineHeight: '15px',
              textAlign: 'center',
              userSelect: 'none',
              position: 'absolute',
              ...chipVisual.style,
            }}
          >
            {chip.sentFollowUp ? 'i' : chip.index}
          </button>
        )

        if (tooltipText) {
          return (
            <Tooltip key={`chip-${chip.id}`}>
              <TooltipTrigger asChild>{chipButton}</TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px] whitespace-pre-wrap text-xs">
                {tooltipText}
              </TooltipContent>
            </Tooltip>
          )
        }

        return (
          <React.Fragment key={`chip-${chip.id}`}>
            {chipButton}
          </React.Fragment>
        )
      })}
    </div>
  )
}
