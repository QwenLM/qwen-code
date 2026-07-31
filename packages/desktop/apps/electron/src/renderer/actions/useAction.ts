import { useEffect, useRef } from 'react'
import { useActionRegistry } from './registry'
import type { ActionId } from './definitions'

/**
 * Register a handler for an action.
 *
 * @example
 * useAction('app.newChat', () => handleNewChat())
 *
 * @example
 * // With enabled condition
 * useAction('navigator.selectAll', selectAll, {
 *   enabled: () => zoneRef.current?.contains(document.activeElement) ?? false
 * })
 */
export function useAction(
  actionId: ActionId,
  handler: () => void,
  options?: { enabled?: () => boolean },
  deps: unknown[] = []
) {
  const { register } = useActionRegistry()
  const handlerRef = useRef(handler)
  const optionsRef = useRef(options)

  // Keep refs current
  useEffect(() => {
    handlerRef.current = handler
    optionsRef.current = options
  }, [handler, options, ...deps])

  // Register handler
  useEffect(() => {
    return register({
      actionId,
      handler: () => handlerRef.current(),
      enabled: optionsRef.current?.enabled ? () => optionsRef.current?.enabled?.() ?? false : undefined,
    })
  }, [actionId, register])
}
