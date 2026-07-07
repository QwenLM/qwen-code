import { describe, expect, it } from 'bun:test'
import type { ActivityItem } from '@craft-agent/ui'
import { collectFileChangesFromActivities, getFirstFileChangeIdForActivity } from '../file-changes'

function activity(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: overrides.id ?? 'activity-1',
    type: overrides.type ?? 'tool',
    toolName: overrides.toolName ?? 'Edit',
    toolInput: overrides.toolInput ?? {},
    status: overrides.status ?? 'completed',
    timestamp: overrides.timestamp ?? Date.now(),
    error: overrides.error,
  }
}

describe('collectFileChangesFromActivities', () => {
  it('expands Pi edits[] into one FileChange per replacement', () => {
    const changes = collectFileChangesFromActivities([
      activity({
        id: 'edit-1',
        toolName: 'Edit',
        toolInput: {
          file_path: '/src/app.ts',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      }),
    ])

    expect(changes).toHaveLength(2)
    expect(changes.map((change) => change.id)).toEqual(['edit-1:0', 'edit-1:1'])
    expect(changes.map((change) => change.filePath)).toEqual(['/src/app.ts', '/src/app.ts'])
    expect(changes.map((change) => change.original)).toEqual(['const a = 1', 'const b = 1'])
    expect(changes.map((change) => change.modified)).toEqual(['const a = 2', 'const b = 2'])
  })

  it('keeps single-edit activities on the original activity id', () => {
    const changes = collectFileChangesFromActivities([
      activity({
        id: 'edit-2',
        toolName: 'Edit',
        toolInput: {
          path: '/src/app.ts',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
          ],
        },
      }),
    ])

    expect(changes).toHaveLength(1)
    expect(changes[0]?.id).toBe('edit-2')
  })

  it('finds the first expanded change id for a multi-edit activity', () => {
    const changes = collectFileChangesFromActivities([
      activity({
        id: 'edit-3',
        toolName: 'Edit',
        toolInput: {
          file_path: '/src/app.ts',
          edits: [
            { oldText: 'alpha', newText: 'beta' },
            { oldText: 'gamma', newText: 'delta' },
          ],
        },
      }),
    ])

    expect(getFirstFileChangeIdForActivity('edit-3', changes)).toBe('edit-3:0')
  })

  it('finds the first per-file change id for Codex-style edit activities', () => {
    const changes = collectFileChangesFromActivities([
      activity({
        id: 'edit-4',
        toolName: 'Edit',
        toolInput: {
          changes: [
            { path: '/src/a.ts', diff: '@@ -1 +1 @@' },
            { path: '/src/b.ts', diff: '@@ -1 +1 @@' },
          ],
        },
      }),
    ])

    expect(getFirstFileChangeIdForActivity('edit-4', changes)).toBe('edit-4-/src/a.ts')
  })
})
