import * as React from 'react'
import { motion, AnimatePresence, useMotionValue, useMotionValueEvent, animate } from 'motion/react'
import { cn } from '@/lib/utils'
import { FreeFormInput, type FreeFormInputProps } from './FreeFormInput'
import { StructuredInput } from './StructuredInput'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import type { StructuredInputState, StructuredResponse, InputMode } from './structured/types'

interface InputContainerProps extends Omit<FreeFormInputProps, 'inputRef'> {
  /** Structured input state - when present, shows structured UI instead of freeform */
  structuredInput?: StructuredInputState
  /** Callback when user responds to structured input */
  onStructuredResponse?: (response: StructuredResponse) => void
  /** External ref for the input (for focus control) */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** Per-frame callback during height animation (for scroll sync) */
  onAnimatedHeightChange?: (delta: number) => void
}

// Animation timing - synced across height and opacity
const TRANSITION_DURATION = 0.25
const TRANSITION_EASE = [0.4, 0, 0.2, 1] as const

// Fallback heights (used on first render before measurement)
const FALLBACK_HEIGHTS: Record<InputMode | string, number> = {
  freeform: 114,
  'freeform-compact': 70,  // Smaller for compact mode
  permission: 200,
  credential: 240,  // Taller for form fields + hint
  admin_approval: 220,
}

/**
 * InputContainer - Main orchestrator for FreeFormInput and StructuredInput
 *
 * Animation approach:
 * - Uses a hidden measuring div to get the natural height of content
 * - Container animates to measured height
 * - Content crossfades inside using AnimatePresence mode="sync"
 * - All visible children use absolute positioning to stack during transition
 */
export function InputContainer({
  structuredInput,
  onStructuredResponse,
  textareaRef,
  compactMode,
  isProcessing,
  onAnimatedHeightChange,
  ...freeFormProps
}: InputContainerProps) {
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true
  const mode: InputMode = structuredInput ? 'structured' : 'freeform'
  const measureRef = React.useRef<HTMLDivElement>(null)
  // Separate height states: freeform uses callback, structured uses measuring div
  // Use smaller fallback height for compact mode
  const [freeformHeight, setFreeformHeight] = React.useState<number>(
    compactMode ? FALLBACK_HEIGHTS['freeform-compact'] : FALLBACK_HEIGHTS.freeform
  )
  const [structuredHeight, setStructuredHeight] = React.useState<number | null>(null)
  const [isFocused, setIsFocused] = React.useState(false)
  const hasInitializedRef = React.useRef(false)

  // Create a stable key for the current content
  const contentKey = mode === 'freeform' ? 'freeform' : `structured-${structuredInput?.type}`

  // Track mode transitions - animate height for a short period after mode change
  const [isAnimating, setIsAnimating] = React.useState(false)
  const prevContentKeyRef = React.useRef(contentKey)

  // Detect transition synchronously during render
  const isTransitioning = prevContentKeyRef.current !== contentKey

  // Should animate if we're in a transition OR still in the animation window
  const shouldAnimateHeight = isTransitioning || isAnimating

  React.useEffect(() => {
    if (isTransitioning) {
      prevContentKeyRef.current = contentKey
      setIsAnimating(true)
      // Keep animating for the transition duration + a bit extra for measurement settle
      const timer = setTimeout(() => {
        setIsAnimating(false)
      }, TRANSITION_DURATION * 1000 + 100)
      return () => clearTimeout(timer)
    }
  }, [contentKey, isTransitioning])

  // Track isProcessing changes in compact mode - animate height collapse/expand
  const prevIsProcessingRef = React.useRef(isProcessing)
  React.useEffect(() => {
    if (compactMode && prevIsProcessingRef.current !== isProcessing) {
      prevIsProcessingRef.current = isProcessing
      setIsAnimating(true)
      const timer = setTimeout(() => {
        setIsAnimating(false)
      }, TRANSITION_DURATION * 1000 + 100)
      return () => clearTimeout(timer)
    }
  }, [compactMode, isProcessing])

  // Handle height changes from FreeFormInput (synchronous, no measuring div needed)
  const handleFreeformHeightChange = React.useCallback((height: number) => {
    setFreeformHeight(height)
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
    }
  }, [])

  // Handle focus changes from FreeFormInput
  const handleFocusChange = React.useCallback((focused: boolean) => {
    setIsFocused(focused)
  }, [])

  // Use ResizeObserver only for structured inputs (freeform uses onHeightChange callback)
  React.useEffect(() => {
    // Skip for freeform - it uses the onHeightChange callback
    if (mode === 'freeform') return

    const measureEl = measureRef.current
    if (!measureEl) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.contentRect.height
        if (height > 0) {
          setStructuredHeight(height)
          // Mark as initialized after first measurement
          if (!hasInitializedRef.current) {
            requestAnimationFrame(() => {
              hasInitializedRef.current = true
            })
          }
        }
      }
    })

    observer.observe(measureEl)
    return () => observer.disconnect()
  }, [contentKey, mode])

  // Use appropriate height source based on mode
  const targetHeight = mode === 'freeform'
    ? freeformHeight
    : (structuredHeight ?? FALLBACK_HEIGHTS[structuredInput?.type ?? 'freeform'] ?? FALLBACK_HEIGHTS.freeform)

  // Motion value for frame-synchronized height animation
  const heightMotionValue = useMotionValue(targetHeight)
  const prevAnimatedHeightRef = React.useRef(targetHeight)

  // Emit delta on every animation frame for scroll sync
  useMotionValueEvent(heightMotionValue, "change", (latest) => {
    const delta = latest - prevAnimatedHeightRef.current
    prevAnimatedHeightRef.current = latest
    if (delta !== 0) {
      onAnimatedHeightChange?.(delta)
    }
  })

  // Animate height changes using motion value
  React.useEffect(() => {
    if (shouldAnimateHeight) {
      animate(heightMotionValue, targetHeight, {
        duration: TRANSITION_DURATION,
        ease: TRANSITION_EASE
      })
    } else {
      // Instant update - no animation
      heightMotionValue.set(targetHeight)
      prevAnimatedHeightRef.current = targetHeight
    }
  }, [targetHeight, shouldAnimateHeight, heightMotionValue])

  const handleStructuredResponse = (response: StructuredResponse) => {
    onStructuredResponse?.(response)
  }

  // Render the current content (measuring div only for structured, freeform uses callback)
  const renderContent = (forMeasuring: boolean) => {
    if (mode === 'freeform') {
      return (
        <FreeFormInput
          {...freeFormProps}
          compactMode={compactMode}
          isProcessing={isProcessing}
          inputRef={forMeasuring ? undefined : textareaRef}
          onHeightChange={forMeasuring ? undefined : handleFreeformHeightChange}
          onFocusChange={forMeasuring ? undefined : handleFocusChange}
          unstyled
        />
      )
    }
    return (
      <StructuredInput
        state={structuredInput!}
        onResponse={forMeasuring ? () => {} : handleStructuredResponse}
        unstyled
      />
    )
  }

  return (
    <div className="relative">
      {/* Hidden measuring div - only needed for structured inputs (freeform uses onHeightChange) */}
      {mode !== 'freeform' && (
        <div
          ref={measureRef}
          className="absolute top-0 left-0 right-0 invisible pointer-events-none"
          aria-hidden="true"
        >
          <div className="rounded-[8px] bg-background overflow-hidden">
            {renderContent(true)}
          </div>
        </div>
      )}

      {/* Visible animated container */}
      <motion.div
        className={cn(
          "input-container relative rounded-[12px] overflow-hidden transition-colors",
          isFocusedPanel ? "shadow-middle" : "shadow-minimal",
          "bg-background"
        )}
        style={{ height: heightMotionValue }}
      >
        {/* Crossfading content - freeform anchored to bottom (for auto-grow), others fill */}
        <AnimatePresence mode="sync" initial={false}>
          <motion.div
            key={contentKey}
            className={mode === 'freeform' ? "absolute bottom-0 left-0 right-0" : "absolute inset-0"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: TRANSITION_DURATION, ease: TRANSITION_EASE }}
          >
            {renderContent(false)}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
