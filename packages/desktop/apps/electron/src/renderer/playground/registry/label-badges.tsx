/**
 * Playground registry entry for LabelBadgeRow.
 *
 * Demonstrates label value badges with interactive editing:
 * - Boolean labels (no value)
 * - Number-valued labels
 * - Date-valued labels
 * - String-valued labels
 * - Popover editing (click badge → edit value / remove)
 */

import * as React from 'react'
import type { ComponentEntry } from './types'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { LabelBadgeRow } from '@/components/ui/label-badge-row'

// ============================================================================
// Mock label configurations matching the workspace format
// ============================================================================

const MOCK_LABELS: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  { id: 'due-date', name: 'Due Date', color: { light: '#3B82F6', dark: '#60A5FA' }, valueType: 'date' },
  { id: 'sprint', name: 'Sprint', color: { light: '#8B5CF6', dark: '#A78BFA' }, valueType: 'string' },
  { id: 'feature', name: 'Feature', color: { light: '#10B981', dark: '#34D399' } },
  { id: 'estimate', name: 'Estimate', color: { light: '#EC4899', dark: '#F472B6' }, valueType: 'number' },
]

// ============================================================================
// Playground Wrapper Component
// ============================================================================

interface LabelBadgeRowPlaygroundProps {
  showValues: boolean
  labelCount: number
}

function LabelBadgeRowPlayground({ showValues, labelCount }: LabelBadgeRowPlaygroundProps) {
  // Build initial session labels based on props
  const initialLabels = React.useMemo(() => {
    const base: string[] = []
    const configs = MOCK_LABELS.slice(0, Math.max(1, labelCount))

    for (const config of configs) {
      if (!showValues || !config.valueType) {
        // Boolean label — just the ID
        base.push(config.id)
      } else {
        // Valued label — add a sample value
        switch (config.valueType) {
          case 'number':
            base.push(`${config.id}::${config.id === 'priority' ? '3' : '5'}`)
            break
          case 'date':
            base.push(`${config.id}::2026-02-01`)
            break
          case 'string':
            base.push(`${config.id}::Q1-Sprint-3`)
            break
        }
      }
    }
    return base
  }, [showValues, labelCount])

  const [sessionLabels, setSessionLabels] = React.useState<string[]>(initialLabels)

  // Reset when props change
  React.useEffect(() => {
    setSessionLabels(initialLabels)
  }, [initialLabels])

  return (
    <div className="w-[500px] rounded-[12px] border border-border bg-sidebar overflow-hidden">
      {/* Simulated input area header */}
      <LabelBadgeRow
        sessionLabels={sessionLabels}
        labels={MOCK_LABELS}
        onLabelsChange={setSessionLabels}
      />
      {/* Simulated input area */}
      <div className="px-5 py-4 min-h-[80px] text-foreground/30 text-[14px]">
        Message...
      </div>
      {/* Simulated bottom bar */}
      <div className="border-t border-border/50 px-3 py-2 flex items-center">
        <span className="text-[12px] text-foreground/40">
          {sessionLabels.length} label{sessionLabels.length !== 1 ? 's' : ''} applied
        </span>
      </div>
    </div>
  )
}

// ============================================================================
// Registry Entry
// ============================================================================

export const labelBadgeComponents: ComponentEntry[] = [
  {
    id: 'label-badge-row-standalone',
    name: 'LabelBadgeRow (Standalone)',
    category: 'Chat Inputs',
    description: 'Standalone label badge row primitive. Note: this is not the stacked ActiveOptionBadges label rendering used by ChatInputZone.',
    component: LabelBadgeRowPlayground,
    props: [
      {
        name: 'showValues',
        description: 'Whether valued labels show their typed values',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'labelCount',
        description: 'Number of labels to display (1-6)',
        control: { type: 'number', min: 1, max: 6, step: 1 },
        defaultValue: 4,
      },
    ],
    variants: [
      {
        name: 'Single boolean label',
        description: 'One label without a value',
        props: { showValues: false, labelCount: 1 },
      },
      {
        name: 'Mixed labels with values',
        description: 'Multiple labels — some boolean, some with number/date/string values',
        props: { showValues: true, labelCount: 4 },
      },
      {
        name: 'Many labels (wrap)',
        description: 'Six labels to demonstrate flex-wrap behavior',
        props: { showValues: true, labelCount: 6 },
      },
      {
        name: 'All boolean',
        description: 'Multiple labels without values',
        props: { showValues: false, labelCount: 4 },
      },
    ],
  },
]
