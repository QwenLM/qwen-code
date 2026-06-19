import type { AnnotationV1 } from '@craft-agent/core'
import { resolveTextAnnotations } from '../markdown/annotation-resolver'
import {
  annotationColorToCss,
} from './annotation-style-tokens'
import {
  getCanonicalText,
  getClientRectsForOffsets,
  consolidateRectsByLine,
  type AnnotationOverlayRect,
} from './annotation-core'
import { getAnnotationFollowUpState } from './follow-up-state'

export type AnnotationOverlayChip = {
  id: string
  index: number
  left: number
  top: number
  pendingFollowUp?: boolean
  sentFollowUp?: boolean
}

export interface ComputeAnnotationOverlayGeometryOptions {
  root: HTMLElement
  renderedAnnotations: AnnotationV1[]
  persistedAnnotations?: AnnotationV1[]
  /** Override per-message indices with session-level indices (e.g. for pending follow-ups) */
  annotationIndexOverrides?: Map<string, number>
}

export function computeAnnotationOverlayGeometry({
  root,
  renderedAnnotations,
  persistedAnnotations,
  annotationIndexOverrides,
}: ComputeAnnotationOverlayGeometryOptions): {
  rects: AnnotationOverlayRect[]
  chips: AnnotationOverlayChip[]
  unresolved: ReturnType<typeof resolveTextAnnotations>['unresolved']
} {
  if (renderedAnnotations.length === 0) {
    return { rects: [], chips: [], unresolved: [] }
  }

  const fullText = getCanonicalText(root)
  const resolution = resolveTextAnnotations(fullText, renderedAnnotations)
  const annotationIndexById = new Map((persistedAnnotations ?? []).map((annotation, idx) => [annotation.id, idx + 1]))
  const rootRect = root.getBoundingClientRect()

  const rects: AnnotationOverlayRect[] = []
  const chips: AnnotationOverlayChip[] = []

  for (const item of resolution.resolved) {
    const followUpState = getAnnotationFollowUpState(item.annotation)
    const pendingFollowUp = followUpState === 'pending'
    const sentFollowUp = followUpState === 'sent'

    const rawRects = getClientRectsForOffsets(root, item.range.start, item.range.end)
      .map(rect => ({
        id: item.annotation.id,
        left: rect.left - rootRect.left,
        top: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
        color: annotationColorToCss(item.annotation.style?.color),
        pendingFollowUp,
        sentFollowUp,
      }))

    const lineRects = consolidateRectsByLine(rawRects)
    rects.push(...lineRects)

    const annotationIndex = annotationIndexOverrides?.get(item.annotation.id) ?? annotationIndexById.get(item.annotation.id)
    if (annotationIndex == null || lineRects.length === 0) {
      continue
    }

    const minTop = Math.min(...lineRects.map(rect => rect.top))
    const topRowRects = lineRects.filter(rect => Math.abs(rect.top - minTop) <= 2)
    const anchorRect = topRowRects.reduce((best, rect) => {
      const bestRight = best.left + best.width
      const rectRight = rect.left + rect.width
      return rectRight > bestRight ? rect : best
    })

    chips.push({
      id: item.annotation.id,
      index: annotationIndex,
      left: anchorRect.left + anchorRect.width,
      top: anchorRect.top,
      pendingFollowUp,
      sentFollowUp,
    })
  }

  return {
    rects,
    chips,
    unresolved: resolution.unresolved,
  }
}
