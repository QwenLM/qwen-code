import { useState, useCallback } from 'react'
import * as storage from '@/lib/local-storage'

export function useResizablePanels(key: string, defaultSizes: number[]) {
  const [layout, setLayout] = useState<number[]>(() => {
    const saved = storage.get<number[]>(storage.KEYS.panelLayout, [], key)
    if (saved.length === defaultSizes.length) {
      return saved
    }
    return defaultSizes
  })

  const onLayoutChange = useCallback((sizes: number[]) => {
    setLayout(sizes)
    storage.set(storage.KEYS.panelLayout, sizes, key)
  }, [key])

  return { layout, onLayoutChange }
}
