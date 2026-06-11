/**
 * LabelBadgeRow - Renders a flex-wrap row of metadata-style label chips.
 *
 * Positioned above the RichTextInput in FreeFormInput. Each badge shows
 * the label's color, name, and optional typed value. Clicking a badge
 * opens a LabelValuePopover for editing or removing.
 *
 * Data flow:
 * - sessionLabels: string[] (e.g., ["bug", "priority::3", "due::2026-01-30"])
 * - labels: LabelConfig[] (workspace label tree for resolving colors/valueTypes)
 * - Parses each entry via parseLabelEntry() to extract id + rawValue
 * - Resolves LabelConfig from flat tree for color and valueType
 */

import * as React from 'react'
import { LabelValuePopover } from './label-value-popover'
import { LabelIcon, LabelValueTypeIcon } from './label-icon'
import { MetadataBadge } from './metadata-badge'
import { parseLabelEntry, formatLabelEntry, formatDisplayValue } from '@craft-agent/shared/labels'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import { useTheme } from '@/context/ThemeContext'
import { cn } from '@/lib/utils'

export interface LabelBadgeRowProps {
  /** Applied session labels (encoded strings like "bug" or "priority::3") */
  sessionLabels: string[]
  /** Full label config tree (for resolving colors, names, valueTypes) */
  labels: LabelConfig[]
  /** Called when a label value is changed — receives the updated full sessionLabels array */
  onLabelsChange?: (updatedLabels: string[]) => void
  /** Additional className for the container */
  className?: string
}

/**
 * Flatten a recursive LabelConfig tree into a map of id → LabelConfig
 * for O(1) lookup when resolving session label entries.
 */
function flattenLabelTree(labels: LabelConfig[]): Map<string, LabelConfig> {
  const map = new Map<string, LabelConfig>()
  function walk(items: LabelConfig[]) {
    for (const item of items) {
      map.set(item.id, item)
      if (item.children?.length) {
        walk(item.children)
      }
    }
  }
  walk(labels)
  return map
}

export function LabelBadgeRow({
  sessionLabels,
  labels,
  onLabelsChange,
  className,
}: LabelBadgeRowProps) {
  const { isDark } = useTheme()

  // Track which badge's popover is open (by index)
  const [openIndex, setOpenIndex] = React.useState<number | null>(null)

  // Memoize flat lookup map (only recompute when labels config changes)
  const labelMap = React.useMemo(() => flattenLabelTree(labels), [labels])

  // Don't render if no labels applied
  if (sessionLabels.length === 0) return null

  /** Update a specific label entry's value */
  const handleValueChange = (index: number, labelId: string, newValue: string | undefined) => {
    const updated = [...sessionLabels]
    updated[index] = formatLabelEntry(labelId, newValue)
    onLabelsChange?.(updated)
  }

  /** Remove a label at a specific index */
  const handleRemove = (index: number) => {
    const updated = sessionLabels.filter((_, i) => i !== index)
    onLabelsChange?.(updated)
  }

  return (
    <div className={cn('flex flex-wrap gap-1 px-4 pt-3 pb-1', className)}>
      {sessionLabels.map((entry, index) => {
        const parsed = parseLabelEntry(entry)
        const config = labelMap.get(parsed.id)

        // If no config found, create a minimal fallback so the badge still renders
        const resolvedConfig: LabelConfig = config ?? { id: parsed.id, name: parsed.id }
        const displayValue = parsed.rawValue ? formatDisplayValue(parsed.rawValue, resolvedConfig.valueType) : undefined
        const resolvedColor = resolvedConfig.color
          ? resolveEntityColor(resolvedConfig.color, isDark)
          : 'var(--foreground)'

        return (
          <LabelValuePopover
            key={`${parsed.id}-${index}`}
            label={resolvedConfig}
            value={parsed.rawValue}
            open={openIndex === index}
            onOpenChange={(open) => setOpenIndex(open ? index : null)}
            onValueChange={(newValue) => handleValueChange(index, parsed.id, newValue)}
            onRemove={() => handleRemove(index)}
          >
            <MetadataBadge
              label={resolvedConfig.name}
              value={displayValue}
              icon={<LabelIcon label={resolvedConfig} size="lg" />}
              valueHintIcon={resolvedConfig.valueType ? <LabelValueTypeIcon valueType={resolvedConfig.valueType} /> : undefined}
              badgeColor={resolvedColor}
              interactive
              isActive={openIndex === index}
              showChevron
            />
          </LabelValuePopover>
        )
      })}
    </div>
  )
}
