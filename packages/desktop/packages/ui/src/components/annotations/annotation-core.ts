import type { AnnotationV1 } from '@craft-agent/core'

export const ANNOTATION_PREFIX_SUFFIX_WINDOW = 24
export const SELECTION_POINTER_MAX_AGE_MS = 1500

export type TextAnnotationSelection = {
  start: number
  end: number
  selectedText: string
  prefix: string
  suffix: string
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function hasExistingTextRangeAnnotation(
  annotations: AnnotationV1[] | undefined,
  start: number,
  end: number,
): boolean {
  return (annotations ?? []).some(annotation => {
    const pos = annotation.target.selectors.find(s => s.type === 'text-position') as Extract<
      AnnotationV1['target']['selectors'][number],
      { type: 'text-position' }
    > | undefined
    return pos?.start === start && pos?.end === end
  })
}

export function createSelectionPreviewAnnotation(
  messageId: string,
  selection: TextAnnotationSelection,
  sessionId = '',
): AnnotationV1 {
  return {
    id: '__pending-selection-preview__',
    schemaVersion: 1,
    createdAt: Date.now(),
    intent: 'highlight',
    body: [{ type: 'highlight' }],
    target: {
      source: {
        sessionId,
        messageId,
      },
      selectors: [
        { type: 'text-position', start: selection.start, end: selection.end },
        {
          type: 'text-quote',
          exact: selection.selectedText,
          prefix: selection.prefix,
          suffix: selection.suffix,
        },
      ],
    },
    style: { color: 'yellow' },
    meta: {
      ephemeral: true,
      source: 'follow-up-selection-preview',
    },
  }
}

export function createTextSelectionAnnotation(
  messageId: string,
  selection: TextAnnotationSelection,
  followUpNote?: string,
  sessionId = '',
): AnnotationV1 {
  const note = followUpNote?.trim() ?? ''
  const hasNote = note.length > 0
  const now = Date.now()

  return {
    id: `ann-${now}-${Math.random().toString(36).slice(2, 8)}`,
    schemaVersion: 1,
    createdAt: now,
    intent: hasNote ? 'comment' : 'highlight',
    body: hasNote
      ? [{ type: 'highlight' }, { type: 'note', text: note, format: 'plain' }]
      : [{ type: 'highlight' }],
    target: {
      source: {
        sessionId,
        messageId,
      },
      selectors: [
        { type: 'text-position', start: selection.start, end: selection.end },
        {
          type: 'text-quote',
          exact: selection.selectedText,
          prefix: selection.prefix,
          suffix: selection.suffix,
        },
      ],
    },
    style: { color: 'yellow' },
    ...(hasNote
      ? {
          meta: {
            followUp: {
              text: note,
              createdAt: now,
            },
          },
        }
      : {}),
  }
}

export function collectTextSegments(root: HTMLElement): Array<{ node: Text; start: number; end: number }> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const segments: Array<{ node: Text; start: number; end: number }> = []
  let cursor = 0
  let current = walker.nextNode()

  while (current) {
    const node = current as Text
    const parent = node.parentElement

    // Ignore synthetic annotation overlay/index content in text/offset math.
    if (parent?.closest('[data-ca-annotation-overlay]') || parent?.closest('[data-ca-annotation-index]')) {
      current = walker.nextNode()
      continue
    }

    const len = node.nodeValue?.length ?? 0
    segments.push({ node, start: cursor, end: cursor + len })
    cursor += len
    current = walker.nextNode()
  }

  return segments
}

export function getCanonicalText(root: HTMLElement): string {
  return collectTextSegments(root)
    .map(segment => segment.node.nodeValue || '')
    .join('')
}

export function resolveNodeOffset(root: HTMLElement, targetNode: Node, nodeOffset: number): number | null {
  const segments = collectTextSegments(root)
  for (const segment of segments) {
    if (segment.node === targetNode) {
      return segment.start + nodeOffset
    }
  }

  // Fallback: range boundaries may land on element nodes (common with reverse drags).
  // In that case, derive character offset by measuring canonical text length
  // from root start to the boundary, excluding synthetic annotation index badges.
  try {
    const probe = document.createRange()
    probe.selectNodeContents(root)
    probe.setEnd(targetNode, nodeOffset)

    const fragment = probe.cloneContents()
    fragment.querySelectorAll('[data-ca-annotation-index]').forEach(node => node.remove())
    return (fragment.textContent || '').length
  } catch {
    return null
  }
}

export function resolveRangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  if (end <= start) return null

  const segments = collectTextSegments(root)
  if (segments.length === 0) return null

  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  for (const segment of segments) {
    const segmentLength = segment.end - segment.start

    if (!startNode && start >= segment.start && start <= segment.end) {
      startNode = segment.node
      startOffset = Math.min(Math.max(0, start - segment.start), segmentLength)
    }

    if (!endNode && end >= segment.start && end <= segment.end) {
      endNode = segment.node
      endOffset = Math.min(Math.max(0, end - segment.start), segmentLength)
    }

    if (startNode && endNode) break
  }

  if (!startNode || !endNode) return null

  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

export function getClientRectsForOffsets(root: HTMLElement, start: number, end: number): DOMRect[] {
  if (end <= start) return []

  const segments = collectTextSegments(root)
  const rects: DOMRect[] = []

  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end) continue

    const localStart = Math.max(start, segment.start) - segment.start
    const localEnd = Math.min(end, segment.end) - segment.start
    if (localEnd <= localStart) continue

    const segmentRange = document.createRange()
    segmentRange.setStart(segment.node, localStart)
    segmentRange.setEnd(segment.node, localEnd)

    rects.push(...Array.from(segmentRange.getClientRects()))
  }

  return rects.filter((rect) => rect.width > 0 && rect.height > 0)
}

export type AnnotationOverlayRect = {
  id: string
  left: number
  top: number
  width: number
  height: number
  color: string
  pendingFollowUp?: boolean
  sentFollowUp?: boolean
}

export function consolidateRectsByLine(rects: AnnotationOverlayRect[]): AnnotationOverlayRect[] {
  if (rects.length <= 1) return rects

  const sorted = rects.slice().sort((a, b) => (Math.abs(a.top - b.top) <= 2 ? a.left - b.left : a.top - b.top))
  const rows: Array<{ top: number; rects: AnnotationOverlayRect[] }> = []

  for (const rect of sorted) {
    const row = rows.find(candidate => Math.abs(candidate.top - rect.top) <= 2)
    if (row) {
      row.rects.push(rect)
    } else {
      rows.push({ top: rect.top, rects: [rect] })
    }
  }

  const consolidated: AnnotationOverlayRect[] = []
  for (const row of rows) {
    const rowRects = row.rects.slice().sort((a, b) => a.left - b.left)
    const first = rowRects[0]
    const last = rowRects[rowRects.length - 1]
    if (!first || !last) continue

    const top = Math.min(...rowRects.map(rect => rect.top))
    const height = Math.max(...rowRects.map(rect => rect.height))
    consolidated.push({
      id: first.id,
      color: first.color,
      left: first.left,
      top,
      width: (last.left + last.width) - first.left,
      height,
      pendingFollowUp: first.pendingFollowUp,
      sentFollowUp: first.sentFollowUp,
    })
  }

  return consolidated
}
