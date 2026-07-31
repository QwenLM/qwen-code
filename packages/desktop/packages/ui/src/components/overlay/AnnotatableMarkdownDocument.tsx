import * as React from 'react'
import { Markdown } from '../markdown'
import type { AnnotationV1 } from '@craft-agent/core'
import { type IslandTransitionConfig } from '../ui'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import {
  ANNOTATION_PREFIX_SUFFIX_WINDOW,
  SELECTION_POINTER_MAX_AGE_MS,
  clamp,
  hasExistingTextRangeAnnotation,
  createSelectionPreviewAnnotation,
  createTextSelectionAnnotation,
  getCanonicalText,
  resolveNodeOffset,
  type AnnotationOverlayRect,
} from '../annotations/annotation-core'
import {
  getAnnotationNoteText,
  formatAnnotationFollowUpTooltipText,
} from '../annotations/follow-up-state'
import {
  type PointerSnapshot,
  buildAnnotationChipEntryTransition,
  buildSelectionEntryTransition,
} from '../annotations/island-motion'
import {
  shouldIgnoreSelectionMouseUpTarget,
} from '../annotations/interaction-policy'
import { computeAnnotationOverlayGeometry, type AnnotationOverlayChip } from '../annotations/annotation-overlay-geometry'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import {
  getAnnotationInteractionAnchor,
  getAnnotationInteractionSourceKey,
  hasAnnotationInteraction,
} from '../annotations/interaction-selectors'
import {
  type AnnotationIslandMode,
} from '../annotations/interaction-state-machine'
import { useAnnotationInteractionController, type ExternalOpenAnnotationRequest } from '../annotations/use-annotation-interaction-controller'
import { useAnnotationIslandPresentation } from '../annotations/use-annotation-island-presentation'
import { useAnnotationIslandEvents } from '../annotations/use-annotation-island-events'
import { useAnnotationCancelRestore } from '../annotations/use-annotation-cancel-restore'
import { canAnnotateMessage, shouldRenderAnnotationIslandInPortal } from '../annotations/annotation-host-config'
import { clearDomSelection } from '../annotations/selection-restore'
import { applyBlockAnnotationMarker, clearBlockAnnotationMarkers } from '../annotations/block-markers'

export interface AnnotatableMarkdownDocumentProps {
  content: string
  messageId: string
  sessionId?: string
  annotations?: AnnotationV1[]
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  onOpenUrl?: (url: string) => void
  onOpenFile?: (path: string) => void
  sendMessageKey?: 'enter' | 'cmd-enter'
  islandZIndex?: React.CSSProperties['zIndex']
  openAnnotationRequest?: ExternalOpenAnnotationRequest | null
  isStreaming?: boolean
}

export function AnnotatableMarkdownDocument({
  content,
  messageId,
  sessionId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  onOpenUrl,
  onOpenFile,
  sendMessageKey = 'enter',
  islandZIndex = 'var(--z-island, 400)',
  openAnnotationRequest,
  isStreaming = false,
}: AnnotatableMarkdownDocumentProps) {
  const canAnnotate = canAnnotateMessage({
    hasAddAnnotationHandler: !!onAddAnnotation,
    hasMessageId: !!messageId,
    isStreaming,
  })
  const interaction = useAnnotationInteractionController()
  const {
    state: interactionState,
    setDraft: setFollowUpDraft,
    openFromSelection,
    openFollowUpFromSelection,
    openFromAnnotation,
    requestEdit,
    cancelFollowUp,
    closeAll,
    markSubmitSuccess,
    markDeleteSuccess,
    consumeExternalOpenRequest,
  } = interaction

  const pendingSelection = interactionState.pendingSelection
  const selectionMenuView = interactionState.selectionMenuView
  const followUpDraft = interactionState.followUpDraft
  const followUpMode = interactionState.followUpMode
  const activeAnnotationDetail = interactionState.activeAnnotationDetail
  const selectionMenuAnchor = getAnnotationInteractionAnchor(interactionState)
  const selectionMenuSourceKey = React.useMemo(() => {
    return getAnnotationInteractionSourceKey(interactionState, messageId)
  }, [interactionState, messageId])

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = React.useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = React.useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )
  const [annotationOverlay, setAnnotationOverlay] = React.useState<{ rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[] }>({ rects: [], chips: [] })

  const {
    renderAnchor: selectionMenuRenderAnchor,
    renderSourceKey: selectionMenuRenderSourceKey,
    isVisible: isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    handleExitComplete: handleSelectionMenuExitComplete,
  } = useAnnotationIslandPresentation({
    anchor: selectionMenuAnchor,
    sourceKey: selectionMenuSourceKey,
  })

  const contentLayerRef = React.useRef<HTMLDivElement>(null)
  const lastPointerRef = React.useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = React.useRef<PointerSnapshot | null>(null)
  const selectionStartedInContentRef = React.useRef(false)

  const closeSelectionMenu = React.useCallback(() => {
    closeAll()
  }, [closeAll])

  const isTargetInsideAnnotationIsland = React.useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

  const triggerSelectionMenuEntryReplay = React.useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

  const renderedAnnotations = React.useMemo(() => {
    const persisted = annotations ?? []

    if (!pendingSelection || selectionMenuView !== 'confirm-follow-up') {
      return persisted
    }

    if (hasExistingTextRangeAnnotation(persisted, pendingSelection.start, pendingSelection.end)) {
      return persisted
    }

    return [
      ...persisted,
      createSelectionPreviewAnnotation(messageId, pendingSelection, sessionId ?? ''),
    ]
  }, [annotations, pendingSelection, selectionMenuView, messageId, sessionId])

  const activeAnnotation = React.useMemo(() => {
    if (!activeAnnotationDetail) return null
    return (annotations ?? []).find(annotation => annotation.id === activeAnnotationDetail.annotationId) ?? null
  }, [annotations, activeAnnotationDetail])

  React.useEffect(() => {
    const root = contentLayerRef.current
    if (!root) {
      setAnnotationOverlay({ rects: [], chips: [] })
      return
    }

    const recomputeOverlay = () => {
      clearBlockAnnotationMarkers(root)

      if (!renderedAnnotations.length) {
        setAnnotationOverlay({ rects: [], chips: [] })
        return
      }

      const geometry = computeAnnotationOverlayGeometry({
        root,
        renderedAnnotations,
        persistedAnnotations: annotations,
      })

      for (const annotation of renderedAnnotations) {
        applyBlockAnnotationMarker(root, annotation)
      }

      setAnnotationOverlay({ rects: geometry.rects, chips: geometry.chips })
    }

    recomputeOverlay()
    window.addEventListener('resize', recomputeOverlay)

    return () => {
      window.removeEventListener('resize', recomputeOverlay)
    }
  }, [renderedAnnotations, annotations, content])

  React.useEffect(() => {
    if (!canAnnotate) {
      closeSelectionMenu()
    }
  }, [canAnnotate, closeSelectionMenu])

  const handleOpenFollowUpView = React.useCallback(() => {
    if (!pendingSelection) return
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])

  const handleRequestFollowUpEdit = React.useCallback(() => {
    requestEdit()
  }, [requestEdit])

  const handleSubmitFollowUp = React.useCallback((note: string) => {
    const normalizedNote = note.trim()

    if (activeAnnotationDetail) {
      if (!onUpdateAnnotation || !activeAnnotation) {
        closeSelectionMenu()
        return
      }

      const existingOtherBodies = activeAnnotation.body.filter(body => body.type !== 'highlight' && body.type !== 'note')
      const nextBody: AnnotationV1['body'] = [
        { type: 'highlight' },
        ...(normalizedNote.length > 0 ? [{ type: 'note', text: normalizedNote, format: 'plain' } as const] : []),
        ...existingOtherBodies,
      ]

      const nextMeta = { ...(activeAnnotation.meta ?? {}) }
      delete nextMeta.followUp

      onUpdateAnnotation(messageId, activeAnnotationDetail.annotationId, {
        body: nextBody,
        intent: normalizedNote.length > 0 ? 'comment' : 'highlight',
        updatedAt: Date.now(),
        meta: normalizedNote.length > 0
          ? {
              ...nextMeta,
              followUp: {
                text: normalizedNote,
                updatedAt: Date.now(),
              },
            }
          : (Object.keys(nextMeta).length > 0 ? nextMeta : undefined),
      })

      markSubmitSuccess()
      return
    }

    if (!pendingSelection || !canAnnotate || !onAddAnnotation) {
      closeSelectionMenu()
      return
    }

    const annotation = createTextSelectionAnnotation(messageId, pendingSelection, normalizedNote, sessionId ?? '')
    onAddAnnotation(messageId, annotation)
    markSubmitSuccess()
    clearDomSelection()
  }, [activeAnnotationDetail, onUpdateAnnotation, activeAnnotation, closeSelectionMenu, pendingSelection, canAnnotate, onAddAnnotation, messageId, sessionId, markSubmitSuccess])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: contentLayerRef,
    cancelFollowUp,
  })

  const handleDeleteActiveAnnotation = React.useCallback(() => {
    if (!onRemoveAnnotation || !activeAnnotationDetail) return
    onRemoveAnnotation(messageId, activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, activeAnnotationDetail, messageId, markDeleteSuccess])

  const handleOpenAnnotationDetail = React.useCallback((
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: AnnotationIslandMode = 'view'
  ) => {
    const annotation = (annotations ?? []).find(item => item.id === annotationId)
    const noteText = annotation ? getAnnotationNoteText(annotation) : ''

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
    openFromAnnotation({ annotationId, index, anchorX, anchorY }, noteText, mode)
    selectionMenuOpenedAtRef.current = Date.now()
  }, [annotations, triggerSelectionMenuEntryReplay, openFromAnnotation])

  React.useEffect(() => {
    const contentRect = contentLayerRef.current?.getBoundingClientRect()
    const fallbackAnchor = {
      x: contentRect ? contentRect.left + contentRect.width / 2 : window.innerWidth / 2,
      y: contentRect ? contentRect.top + 20 : Math.max(24, window.innerHeight * 0.2),
    }

    const consumed = consumeExternalOpenRequest(openAnnotationRequest, {
      messageId,
      annotations,
      getNoteText: getAnnotationNoteText,
      fallbackAnchor,
    })

    if (!consumed) return

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
  }, [
    openAnnotationRequest,
    messageId,
    annotations,
    consumeExternalOpenRequest,
    triggerSelectionMenuEntryReplay,
  ])

  const showSelectionMenuFromCurrentSelection = React.useCallback(() => {
    const root = contentLayerRef.current
    if (!root || !canAnnotate) return

    requestAnimationFrame(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        closeSelectionMenu()
        return
      }

      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        closeSelectionMenu()
        return
      }

      const start = resolveNodeOffset(root, range.startContainer, range.startOffset)
      const end = resolveNodeOffset(root, range.endContainer, range.endOffset)
      if (start == null || end == null || end <= start) {
        closeSelectionMenu()
        return
      }

      if (hasExistingTextRangeAnnotation(annotations, start, end)) {
        closeSelectionMenu()
        return
      }

      const selectedText = range.toString()
      if (!selectedText || !/\S/.test(selectedText)) {
        closeSelectionMenu()
        return
      }

      const fullText = getCanonicalText(root)
      const prefix = fullText.slice(Math.max(0, start - ANNOTATION_PREFIX_SUFFIX_WINDOW), start)
      const suffix = fullText.slice(end, end + ANNOTATION_PREFIX_SUFFIX_WINDOW)

      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.ts) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null
      const pointerY = hasRecentPointer && pointer ? pointer.y : null

      const fallbackRect = range.getBoundingClientRect()
      let anchorRect: DOMRect
      if (rects.length > 0) {
        if (pointerY != null) {
          const rowCandidates = rects.filter(rect => pointerY >= rect.top && pointerY <= rect.bottom)

          if (rowCandidates.length > 0) {
            if (pointerX != null) {
              const xContaining = rowCandidates.filter(rect => pointerX >= rect.left && pointerX <= rect.right)
              if (xContaining.length > 0) {
                anchorRect = xContaining.reduce((best, rect) => (rect.width > best.width ? rect : best))
              } else {
                anchorRect = rowCandidates.reduce((best, rect) => {
                  const bestDistance = Math.min(Math.abs(pointerX - best.left), Math.abs(pointerX - best.right))
                  const rectDistance = Math.min(Math.abs(pointerX - rect.left), Math.abs(pointerX - rect.right))
                  return rectDistance < bestDistance ? rect : best
                })
              }
            } else {
              anchorRect = rowCandidates.reduce((best, rect) => (rect.width > best.width ? rect : best))
            }
          } else {
            anchorRect = rects.reduce((best, rect) => {
              const bestDistance = Math.abs((best.top + best.bottom) / 2 - pointerY)
              const rectDistance = Math.abs((rect.top + rect.bottom) / 2 - pointerY)
              return rectDistance < bestDistance ? rect : best
            })
          }
        } else {
          anchorRect = rects.reduce((best, rect) => (rect.top < best.top ? rect : best))
        }
      } else {
        anchorRect = fallbackRect
      }

      const anchorRowRects = rects.length > 0
        ? rects.filter(rect => Math.abs(rect.top - anchorRect.top) <= 2)
        : []
      const clampRects = anchorRowRects.length > 0 ? anchorRowRects : (rects.length > 0 ? rects : [anchorRect])
      const selectionMinX = Math.min(...clampRects.map(rect => rect.left))
      const selectionMaxX = Math.max(...clampRects.map(rect => rect.right))

      const anchorX = pointerX != null
        ? clamp(pointerX, selectionMinX, selectionMaxX)
        : (anchorRect.left + (anchorRect.width / 2))
      const anchorY = anchorRect.top - 8

      const transition = buildSelectionEntryTransition(dragStartPointerRef.current, pointer)

      setSelectionMenuTransitionConfig(transition)
      triggerSelectionMenuEntryReplay()
      openFromSelection({
        start,
        end,
        selectedText,
        prefix,
        suffix,
        anchorX,
        anchorY,
      })
      selectionMenuOpenedAtRef.current = Date.now()
      dragStartPointerRef.current = null
    })
  }, [annotations, canAnnotate, closeSelectionMenu, triggerSelectionMenuEntryReplay])

  const handleSelectionPointerDown = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    selectionStartedInContentRef.current = true
    const snapshot: PointerSnapshot = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }
    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

  const handleTextSelection = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate) return

    if (shouldIgnoreSelectionMouseUpTarget(event.target)) {
      selectionStartedInContentRef.current = false
      return
    }

    lastPointerRef.current = { x: event.clientX, y: event.clientY, ts: Date.now() }

    if (event.shiftKey) {
      const targetElement = event.target instanceof Element ? event.target : null
      const blockElement = targetElement?.closest<HTMLElement>('[data-ca-block-path]')
      if (blockElement && onAddAnnotation) {
        const blockPath = blockElement.getAttribute('data-ca-block-path') || ''
        const blockType = blockElement.getAttribute('data-ca-block-type') || 'paragraph'
        const blockId = blockElement.getAttribute('data-ca-block-id') || undefined

        if (blockPath) {
          const alreadyExists = (annotations ?? []).some(annotation => {
            const blockSelector = annotation.target.selectors.find(s => s.type === 'block') as Extract<
              AnnotationV1['target']['selectors'][number],
              { type: 'block' }
            > | undefined
            if (!blockSelector) return false
            if (blockId && blockSelector.blockId) return blockSelector.blockId === blockId
            return blockSelector.path === blockPath
          })

          if (!alreadyExists) {
            const annotation: AnnotationV1 = {
              id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              schemaVersion: 1,
              createdAt: Date.now(),
              intent: 'highlight',
              body: [{ type: 'highlight' }],
              target: {
                source: {
                  sessionId: sessionId ?? '',
                  messageId,
                },
                selectors: [
                  {
                    type: 'block',
                    blockType: blockType as Extract<AnnotationV1['target']['selectors'][number], { type: 'block' }>['blockType'],
                    path: blockPath,
                    ...(blockId ? { blockId } : {}),
                  },
                ],
              },
              style: { color: 'yellow' },
            }
            onAddAnnotation(messageId, annotation)
          }
        }
      }
      selectionStartedInContentRef.current = false
      return
    }

    selectionStartedInContentRef.current = false
    showSelectionMenuFromCurrentSelection()
  }, [annotations, canAnnotate, messageId, onAddAnnotation, sessionId, showSelectionMenuFromCurrentSelection])

  React.useEffect(() => {
    if (!canAnnotate) return

    const handleDocumentMouseUp = (event: MouseEvent) => {
      if (!selectionStartedInContentRef.current) return
      selectionStartedInContentRef.current = false

      lastPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        ts: Date.now(),
      }

      const root = contentLayerRef.current
      if (!root) return

      const target = event.target as Node | null
      if (target && root.contains(target)) {
        return
      }

      showSelectionMenuFromCurrentSelection()
    }

    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [canAnnotate, showSelectionMenuFromCurrentSelection])

  React.useEffect(() => {
    if (!hasAnnotationInteraction(interactionState) || !isSelectionMenuVisible) return

    const handleSelectionChange = () => {
      if (Date.now() - selectionMenuOpenedAtRef.current < 180) {
        return
      }

      const root = contentLayerRef.current
      if (!root) {
        closeSelectionMenu()
        return
      }

      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }

      const range = selection.getRangeAt(0)
      const common = range.commonAncestorContainer
      const commonElement = common.nodeType === Node.ELEMENT_NODE
        ? common as Element
        : common.parentElement

      if (commonElement && isTargetInsideAnnotationIsland(commonElement)) {
        return
      }

      if (!root.contains(common)) {
        closeSelectionMenu()
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [interactionState, isSelectionMenuVisible, closeSelectionMenu, isTargetInsideAnnotationIsland, selectionMenuOpenedAtRef])

  const handleSelectionMenuRequestBack = React.useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }

    return false
  }, [selectionMenuView, handleCancelFollowUp])

  useAnnotationIslandEvents({
    enabled: hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

  const selectionMenu = (
    <AnnotationIslandMenu
      anchor={selectionMenuRenderAnchor}
      sourceKey={selectionMenuRenderSourceKey}
      replayNonce={selectionMenuShowNonce}
      isVisible={isSelectionMenuVisible}
      activeView={selectionMenuView}
      mode={followUpMode}
      draft={followUpDraft}
      onDraftChange={setFollowUpDraft}
      onOpenFollowUp={handleOpenFollowUpView}
      onCancel={handleCancelFollowUp}
      onRequestBack={handleSelectionMenuRequestBack}
      onRequestEdit={handleRequestFollowUpEdit}
      onSubmit={handleSubmitFollowUp}
      onDelete={activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined}
      sendMessageKey={sendMessageKey}
      transitionConfig={selectionMenuTransitionConfig}
      onExitComplete={handleSelectionMenuExitComplete}
      zIndex={islandZIndex}
      usePortal={shouldRenderAnnotationIslandInPortal('fullscreen')}
    />
  )

  return (
    <>
      <div
        ref={contentLayerRef}
        className="relative"
        onMouseDown={handleSelectionPointerDown}
        onMouseUp={handleTextSelection}
      >
        <Markdown mode="minimal" onUrlClick={onOpenUrl} onFileClick={onOpenFile} hideFirstMermaidExpand={false}>
          {content}
        </Markdown>

        <AnnotationOverlayLayer
          rects={annotationOverlay.rects}
          chips={annotationOverlay.chips}
          annotations={renderedAnnotations}
          getTooltipText={(annotation) => formatAnnotationFollowUpTooltipText(annotation)}
          onChipOpen={({ annotationId, index, anchorX, anchorY, mode }) => {
            handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
          }}
        />
      </div>
      {selectionMenu}
    </>
  )
}
