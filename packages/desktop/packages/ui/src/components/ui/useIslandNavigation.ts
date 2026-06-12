import * as React from 'react'

export interface IslandNavigation<TView extends string> {
  current: TView
  canPop: boolean
  stack: TView[]
  push: (next: TView) => void
  replace: (next: TView) => void
  pop: () => void
  reset: (root?: TView) => void
  handleEscapeBackOrClose: (onClose: () => void) => boolean
}

/**
 * Shared backstack helper for Island multi-view flows.
 */
export function useIslandNavigation<TView extends string>(initial: TView): IslandNavigation<TView> {
  const [stack, setStack] = React.useState<TView[]>([initial])

  const push = React.useCallback((next: TView) => {
    setStack((prev) => [...prev, next])
  }, [])

  const replace = React.useCallback((next: TView) => {
    setStack((prev) => {
      const base = prev.length > 0 ? prev.slice(0, -1) : []
      return [...base, next]
    })
  }, [])

  const pop = React.useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }, [])

  const reset = React.useCallback((root?: TView) => {
    setStack([root ?? initial])
  }, [initial])

  const current = stack[stack.length - 1] ?? initial
  const canPop = stack.length > 1

  const handleEscapeBackOrClose = React.useCallback((onClose: () => void): boolean => {
    if (canPop) {
      pop()
      return true
    }

    onClose()
    return true
  }, [canPop, pop])

  return {
    current,
    canPop,
    stack,
    push,
    replace,
    pop,
    reset,
    handleEscapeBackOrClose,
  }
}
