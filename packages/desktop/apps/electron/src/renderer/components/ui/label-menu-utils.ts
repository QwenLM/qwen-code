import type { LabelConfig } from '@craft-agent/shared/labels'
import { flattenLabelsWithParentPath } from '@craft-agent/shared/labels'

export interface LabelMenuItem {
  id: string
  label: string
  config: LabelConfig
  /** Breadcrumb path for nested labels (e.g. "Priority / ") */
  parentPath?: string
}

const labelMenuCollator = new Intl.Collator(undefined, { sensitivity: 'base' })

export function compareLabelMenuItems(a: LabelMenuItem, b: LabelMenuItem): number {
  return labelMenuCollator.compare(a.label, b.label)
    || labelMenuCollator.compare(a.parentPath ?? '', b.parentPath ?? '')
    || a.id.localeCompare(b.id)
}

/**
 * Build flat label menu items with parent breadcrumbs for searchable label menus.
 * Exclusion is handled here so both the inline # menu and AppShell filter search
 * can share the same flattening/path-building logic.
 */
export function createLabelMenuItems(labels: LabelConfig[], excludedLabelIds: Iterable<string> = []): LabelMenuItem[] {
  const excluded = new Set(excludedLabelIds)

  return flattenLabelsWithParentPath(labels)
    .filter(({ label }) => !excluded.has(label.id))
    .map(({ label, parentPath }) => ({
      id: label.id,
      label: label.name,
      config: label,
      parentPath,
    }))
    .sort(compareLabelMenuItems)
}

/**
 * Score how well a segment matches a path part.
 * 3 = starts with segment (best: "pri" → "Priority")
 * 2 = word boundary match (after space/hyphen/underscore: "high" → "super-high")
 * 1 = contains anywhere (mid-word: "ior" → "Priority")
 * 0 = no match
 */
export function segmentScore(part: string, segment: string): number {
  const lower = part.toLowerCase()
  if (lower.startsWith(segment)) return 3
  if (new RegExp(`[\\s\\-_]${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lower)) return 2
  if (lower.includes(segment)) return 1
  return 0
}

/**
 * Unified hierarchical filter with scoring.
 * Splits the filter by "/" into segments (single segment if no "/").
 * Each segment is matched in order against the item's full path (parentPath parts + label).
 * Results are sorted by total match score (starts-with > word-boundary > contains).
 */
export function filterItems(items: LabelMenuItem[], filter: string): LabelMenuItem[] {
  if (!filter) return [...items].sort(compareLabelMenuItems)

  const segments = filter.toLowerCase().split('/').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return [...items].sort(compareLabelMenuItems)

  const scored: { item: LabelMenuItem; score: number }[] = []

  for (const item of items) {
    const parentParts = item.parentPath
      ? item.parentPath.split(' / ').filter(Boolean)
      : []
    const fullParts = [...parentParts, item.label]

    let totalScore = 0
    let partIndex = 0
    let matched = true

    for (const seg of segments) {
      let bestScore = 0
      let found = false
      while (partIndex < fullParts.length) {
        const score = segmentScore(fullParts[partIndex], seg)
        if (score > 0) {
          bestScore = score
          found = true
          partIndex++
          break
        }
        partIndex++
      }
      if (!found) {
        matched = false
        break
      }
      totalScore += bestScore
    }

    if (matched) {
      scored.push({ item, score: totalScore })
    }
  }

  scored.sort((a, b) => b.score - a.score || compareLabelMenuItems(a.item, b.item))
  return scored.map(s => s.item)
}
