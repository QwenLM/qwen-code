import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { RICH_BLOCK_DEFAULTS, type RichBlockInteractionOptions } from './rich-block-interaction-spec'

export function clampScale(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function zoomStepScale(current: number, direction: 'in' | 'out', factor: number, min: number, max: number): number {
  const nextFactor = direction === 'in' ? factor : 1 / factor
  return clampScale(current * nextFactor, min, max)
}

export function cursorAnchoredTranslate(
  translate: { x: number; y: number },
  cursor: { x: number; y: number },
  scaleRatio: number,
): { x: number; y: number } {
  return {
    x: cursor.x - scaleRatio * (cursor.x - translate.x),
    y: cursor.y - scaleRatio * (cursor.y - translate.y),
  }
}

export function computeFitScale(
  container: { width: number; height: number },
  content: { width: number; height: number },
  min: number,
  max: number,
): number {
  const scaleX = (container.width * 0.9) / content.width
  const scaleY = (container.height * 0.9) / content.height
  return clampScale(Math.min(scaleX, scaleY), min, max)
}

interface UseRichBlockInteractionsOptions extends RichBlockInteractionOptions {
  containerRef: RefObject<HTMLDivElement | null>
}

export function useRichBlockInteractions({
  isOpen,
  containerRef,
  minScale = RICH_BLOCK_DEFAULTS.minScale,
  maxScale = RICH_BLOCK_DEFAULTS.maxScale,
  zoomStepFactor = RICH_BLOCK_DEFAULTS.zoomStepFactor,
  wheelSensitivity = RICH_BLOCK_DEFAULTS.wheelSensitivity,
  keyboardShortcuts = true,
}: UseRichBlockInteractionsOptions) {
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  const isDraggingRef = useRef(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const translateAtDragStartRef = useRef({ x: 0, y: 0 })

  const reset = useCallback(() => {
    setIsAnimating(true)
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const zoomByStep = useCallback((direction: 'in' | 'out') => {
    setIsAnimating(true)
    setScale(prev => {
      const next = zoomStepScale(prev, direction, zoomStepFactor, minScale, maxScale)
      const ratio = next / prev
      setTranslate(t => ({ x: t.x * ratio, y: t.y * ratio }))
      return next
    })
  }, [zoomStepFactor, minScale, maxScale])

  const zoomToPreset = useCallback((percent: number) => {
    setIsAnimating(true)
    setScale(clampScale(percent / 100, minScale, maxScale))
    setTranslate({ x: 0, y: 0 })
  }, [minScale, maxScale])

  const zoomToFit = useCallback((content: { width: number; height: number } | null) => {
    const container = containerRef.current
    if (!container || !content) {
      reset()
      return
    }

    const rect = container.getBoundingClientRect()
    const fit = computeFitScale({ width: rect.width, height: rect.height }, content, minScale, maxScale)
    setIsAnimating(true)
    setScale(fit)
    setTranslate({ x: 0, y: 0 })
  }, [containerRef, minScale, maxScale, reset])

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    isDraggingRef.current = true
    setIsDragging(true)
    setIsAnimating(false)
    dragStartRef.current = { x: e.clientX, y: e.clientY }
    setTranslate(t => {
      translateAtDragStartRef.current = { x: t.x, y: t.y }
      return t
    })
  }, [])

  const onDoubleClick = useCallback(() => {
    reset()
  }, [reset])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      setIsAnimating(false)
      setTranslate({
        x: translateAtDragStartRef.current.x + (e.clientX - dragStartRef.current.x),
        y: translateAtDragStartRef.current.y + (e.clientY - dragStartRef.current.y),
      })
    }

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsAnimating(false)

      const rect = container.getBoundingClientRect()
      const cursor = {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      }

      const sensitivity = e.ctrlKey ? wheelSensitivity.trackpadPinch : wheelSensitivity.mouse
      const factor = Math.pow(2, -e.deltaY * sensitivity)

      setScale(prev => {
        const next = clampScale(prev * factor, minScale, maxScale)
        const ratio = next / prev
        setTranslate(t => cursorAnchoredTranslate(t, cursor, ratio))
        return next
      })
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [containerRef, minScale, maxScale, wheelSensitivity])

  useEffect(() => {
    if (!isOpen || !keyboardShortcuts) return

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        zoomByStep('in')
      } else if (e.key === '-') {
        e.preventDefault()
        zoomByStep('out')
      } else if (e.key === '0') {
        e.preventDefault()
        reset()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, keyboardShortcuts, reset, zoomByStep])

  useEffect(() => {
    if (!isOpen) return
    setScale(1)
    setTranslate({ x: 0, y: 0 })
    setIsDragging(false)
    isDraggingRef.current = false
  }, [isOpen])

  return {
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
  }
}
