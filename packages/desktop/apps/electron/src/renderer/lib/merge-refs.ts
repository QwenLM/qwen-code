import { type MutableRefObject, type RefCallback } from 'react'

type Ref<T> = RefCallback<T> | MutableRefObject<T> | null | undefined

/**
 * Merges multiple refs into a single ref callback.
 * Useful when an element needs to satisfy multiple ref requirements
 * (e.g., focus zone ref + hotkey scope ref).
 */
export function mergeRefs<T>(...refs: Ref<T>[]): RefCallback<T> {
  return (value: T) => {
    refs.forEach(ref => {
      if (typeof ref === 'function') {
        ref(value)
      } else if (ref != null) {
        ref.current = value
      }
    })
  }
}
