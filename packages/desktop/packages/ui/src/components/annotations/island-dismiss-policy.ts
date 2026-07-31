export type IslandOutsideDismissBehavior = 'back-or-close' | 'close-only'
export type IslandOutsideDismissAction = 'back' | 'close'

export interface ResolveIslandOutsideDismissActionOptions {
  isCompactView: boolean
  behavior: IslandOutsideDismissBehavior
}

export function resolveIslandOutsideDismissAction({
  isCompactView,
  behavior,
}: ResolveIslandOutsideDismissActionOptions): IslandOutsideDismissAction {
  if (behavior === 'close-only') {
    return 'close'
  }

  return isCompactView ? 'close' : 'back'
}
