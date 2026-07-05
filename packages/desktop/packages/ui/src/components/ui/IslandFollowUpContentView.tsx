import * as React from 'react'
import { ChevronDown, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IslandContentView, type IslandMorphTarget } from './Island'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from './StyledDropdown'

export type IslandFollowUpMode = 'edit' | 'view'

export interface IslandFollowUpContentViewProps {
  id: string
  value: string
  onValueChange: (next: string) => void
  onCancel: () => void
  onSubmit: (value: string) => void
  onSubmitAndSend?: (value: string) => void
  onDelete?: () => void
  title?: string
  placeholder?: string
  submitLabel?: string
  submitAndSendLabel?: string
  editLabel?: string
  deleteLabel?: string
  maxInputHeight?: number
  sendMessageKey?: 'enter' | 'cmd-enter'
  morphFrom?: IslandMorphTarget | null
  lockScroll?: boolean
  blockOutsideInteraction?: boolean
  mode?: IslandFollowUpMode
  onRequestEdit?: () => void
}

/**
 * Reusable Follow-up confirmation view for Island flows.
 *
 * - Uses multiline textarea input
 * - Esc cancels
 * - Cmd/Ctrl+Enter submits
 */
export function IslandFollowUpContentView({
  id,
  value,
  onValueChange,
  onCancel,
  onSubmit,
  onSubmitAndSend,
  onDelete,
  title: titleProp,
  placeholder: placeholderProp,
  submitLabel: submitLabelProp,
  submitAndSendLabel: submitAndSendLabelProp,
  editLabel: editLabelProp,
  deleteLabel: deleteLabelProp,
  maxInputHeight = 400,
  sendMessageKey = 'enter',
  morphFrom = null,
  lockScroll = false,
  blockOutsideInteraction = false,
  mode = 'edit',
  onRequestEdit,
}: IslandFollowUpContentViewProps) {
  const { t } = useTranslation()
  const title = titleProp ?? t('chat.followUp')
  const placeholder = placeholderProp ?? t('chat.annotationPlaceholder')
  const submitLabel = submitLabelProp ?? t('common.continue')
  const submitAndSendLabel = submitAndSendLabelProp ?? t('chat.followUpSaveAndSend')
  const editLabel = editLabelProp ?? t('common.edit')
  const deleteLabel = deleteLabelProp ?? t('common.delete')
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const measureTextareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const isViewMode = mode === 'view'
  const isEmpty = !isViewMode && value.trim().length === 0
  const canSubmitAndSend = !isViewMode && !!onSubmitAndSend
  const minInputHeight = isViewMode ? 20 : 44
  const [inputHeight, setInputHeight] = React.useState(minInputHeight)
  const [inputOverflow, setInputOverflow] = React.useState(false)
  const [submitMenuOpen, setSubmitMenuOpen] = React.useState(false)

  const handleSubmitMenuInteractOutside = React.useCallback((event: unknown) => {
    const dismissEvent = event as {
      preventDefault?: () => void
      detail?: {
        originalEvent?: {
          preventDefault?: () => void
          stopPropagation?: () => void
        }
      }
    }

    // Dismiss only the Save & Send popup. Do not let this outside tap
    // cascade into the parent island's outside-dismiss behavior.
    dismissEvent.preventDefault?.()
    dismissEvent.detail?.originalEvent?.preventDefault?.()
    dismissEvent.detail?.originalEvent?.stopPropagation?.()
    setSubmitMenuOpen(false)
  }, [])

  React.useLayoutEffect(() => {
    const measure = measureTextareaRef.current
    if (!measure) return

    measure.value = value
    const measured = measure.scrollHeight
    const nextHeight = Math.min(Math.max(measured, minInputHeight), maxInputHeight)
    const nextOverflow = measured > maxInputHeight

    setInputHeight((prev) => (prev === nextHeight ? prev : nextHeight))
    setInputOverflow((prev) => (prev === nextOverflow ? prev : nextOverflow))
  }, [value, maxInputHeight, minInputHeight])

  React.useEffect(() => {
    if (isViewMode || typeof window === 'undefined') return

    const raf = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      textarea.focus()
      const cursor = textarea.value.length
      textarea.setSelectionRange(cursor, cursor)
    })

    return () => window.cancelAnimationFrame(raf)
  }, [isViewMode])

  React.useEffect(() => {
    if (!canSubmitAndSend && submitMenuOpen) {
      setSubmitMenuOpen(false)
    }
  }, [canSubmitAndSend, submitMenuOpen])

  return (
    <IslandContentView id={id} anchorX="center" anchorY="top" morphFrom={morphFrom} lockScroll={lockScroll} blockOutsideInteraction={blockOutsideInteraction}>
      <div className="w-[330px] px-3 pb-3 pt-3 space-y-2.5 select-none">
        <div className="flex items-center">
          <div className="pl-[4px] text-sm font-medium">{title}</div>
        </div>

        <div className="relative rounded-[8px] px-0 py-1">
          <textarea
            ref={measureTextareaRef}
            aria-hidden="true"
            tabIndex={-1}
            readOnly
            rows={isViewMode ? 1 : 2}
            value={value}
            className="pointer-events-none absolute left-0 right-0 top-1 resize-none overflow-hidden bg-transparent text-sm leading-5 opacity-0 pl-[4px]"
          />

          <textarea
            ref={textareaRef}
            value={value}
            readOnly={isViewMode}
            tabIndex={isViewMode ? -1 : 0}
            onChange={(event) => {
              if (isViewMode) return
              onValueChange(event.target.value)
            }}
            onKeyDown={(event) => {
              if (isViewMode) return

              if (event.key === 'Escape') {
                event.preventDefault()
                onCancel()
                return
              }

              if (event.nativeEvent.isComposing) return

              const trimmedEmpty = value.trim().length === 0

              if (sendMessageKey === 'enter') {
                if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault()
                  if (!trimmedEmpty) onSubmit(value)
                  return
                }

                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  if (!trimmedEmpty) onSubmit(value)
                }

                return
              }

              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                if (!trimmedEmpty) onSubmit(value)
              }
            }}
            placeholder={placeholder}
            rows={isViewMode ? 1 : 2}
            style={{ height: inputHeight, overflowY: inputOverflow ? 'auto' : 'hidden' }}
            className="relative w-full resize-none bg-transparent outline-none text-sm leading-5 select-text pl-[4px]"
          />
        </div>

        <div className="flex justify-between items-center pt-1 shrink-0">
          <div>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="h-8 px-3 rounded-[8px] text-sm bg-background shadow-minimal text-red-500 inline-flex items-center cursor-pointer hover:bg-foreground/2"
              >
                {deleteLabel}
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 rounded-[8px] text-sm text-foreground/75 hover:bg-foreground/5"
            >
              {t('common.cancel')}
            </button>

            {canSubmitAndSend ? (
              <div className="inline-flex rounded-[8px] bg-background shadow-minimal overflow-hidden">
                <button
                  type="button"
                  disabled={isEmpty}
                  onClick={() => onSubmit(value)}
                  className="h-8 px-3 text-sm text-foreground inline-flex items-center cursor-pointer hover:bg-foreground/2 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  {submitLabel}
                </button>

                <DropdownMenu open={submitMenuOpen} onOpenChange={(open) => { if (!isEmpty) setSubmitMenuOpen(open) }}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={isEmpty}
                      aria-label={t('chat.moreSubmitActions')}
                      title={t('chat.moreSubmitActions')}
                      className="h-8 w-6 border-l border-border/40 inline-flex items-center justify-center text-foreground/70 hover:text-foreground hover:bg-foreground/2 data-[state=open]:bg-foreground/2 data-[state=open]:text-foreground disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-foreground/70"
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>

                  <StyledDropdownMenuContent
                    side="bottom"
                    align="end"
                    sideOffset={6}
                    minWidth=""
                    style={{ zIndex: 'var(--z-island-popover, 410)' }}
                    onInteractOutside={handleSubmitMenuInteractOutside}
                    data-ca-annotation-island="true"
                  >
                    <StyledDropdownMenuItem
                      onSelect={() => {
                        setSubmitMenuOpen(false)
                        onSubmitAndSend?.(value)
                      }}
                    >
                      <Send className="h-3.5 w-3.5" />
                      {submitAndSendLabel}
                    </StyledDropdownMenuItem>
                  </StyledDropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <button
                type="button"
                disabled={isEmpty}
                onClick={() => {
                  if (isViewMode) {
                    onRequestEdit?.()
                    return
                  }

                  onSubmit(value)
                }}
                className="h-8 px-3 rounded-[8px] text-sm bg-background shadow-minimal text-foreground inline-flex items-center cursor-pointer hover:bg-foreground/2 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
              >
                {isViewMode ? editLabel : submitLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </IslandContentView>
  )
}
