import type { SessionFilter } from '../../shared/types'

export interface CollapsedGroupScopeOptions {
  workspaceId?: string
  currentFilter?: SessionFilter
  groupingMode: 'none' | 'date' | 'status'
}

export function serializeSessionFilterForScope(filter?: SessionFilter): string {
  if (!filter) return 'allSessions'

  switch (filter.kind) {
    case 'state':
      return `state:${encodeURIComponent(filter.stateId)}`
    case 'label':
      return `label:${encodeURIComponent(filter.labelId)}`
    case 'view':
      return `view:${encodeURIComponent(filter.viewId)}`
    default:
      return filter.kind
  }
}

/**
 * Build a deterministic scope suffix for collapsed group persistence.
 * This prevents collapse state from bleeding across workspaces, filters, and grouping modes.
 */
export function buildCollapsedGroupsScopeSuffix({
  workspaceId,
  currentFilter,
  groupingMode,
}: CollapsedGroupScopeOptions): string {
  const workspaceSegment = workspaceId ? encodeURIComponent(workspaceId) : 'global'
  const filterSegment = serializeSessionFilterForScope(currentFilter)
  return `ws=${workspaceSegment}|filter=${filterSegment}|group=${groupingMode}`
}
