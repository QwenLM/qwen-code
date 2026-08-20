/**
 * CronBuilder
 *
 * Visual cron expression builder with three synchronized layers:
 * 1. Preset buttons — common schedules
 * 2. Visual fields — 5 interactive fields with dropdowns
 * 3. Raw expression — editable text input
 *
 * Plus human-readable summary and next-run preview.
 */

import * as React from 'react'
import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { describeCron as describeCronExpression, computeNextRuns } from './utils'

// ============================================================================
// Presets
// ============================================================================

interface CronPreset {
  label: string
  cron: string
  description: string
}

const PRESETS: CronPreset[] = [
  { label: 'Every minute',       cron: '* * * * *',     description: 'Runs every minute' },
  { label: 'Every 15 min',       cron: '*/15 * * * *',  description: 'Runs every 15 minutes' },
  { label: 'Every hour',         cron: '0 * * * *',     description: 'At the top of every hour' },
  { label: 'Daily at midnight',  cron: '0 0 * * *',     description: 'Once a day at 00:00' },
  { label: 'Daily at 9am',       cron: '0 9 * * *',     description: 'Once a day at 09:00' },
  { label: 'Weekdays at 9am',    cron: '0 9 * * 1-5',   description: 'Monday–Friday at 09:00' },
  { label: 'Monthly on 1st',     cron: '0 0 1 * *',     description: 'First day of each month at 00:00' },
]

// ============================================================================
// Cron Field Definitions
// ============================================================================

interface FieldDef {
  label: string
  min: number
  max: number
  options?: { value: string; label: string }[]
}

const FIELDS: FieldDef[] = [
  { label: 'Minute', min: 0, max: 59 },
  { label: 'Hour', min: 0, max: 23 },
  { label: 'Day', min: 1, max: 31 },
  { label: 'Month', min: 1, max: 12, options: [
    { value: '1', label: 'Jan' }, { value: '2', label: 'Feb' }, { value: '3', label: 'Mar' },
    { value: '4', label: 'Apr' }, { value: '5', label: 'May' }, { value: '6', label: 'Jun' },
    { value: '7', label: 'Jul' }, { value: '8', label: 'Aug' }, { value: '9', label: 'Sep' },
    { value: '10', label: 'Oct' }, { value: '11', label: 'Nov' }, { value: '12', label: 'Dec' },
  ]},
  { label: 'Weekday', min: 0, max: 6, options: [
    { value: '0', label: 'Sun' }, { value: '1', label: 'Mon' }, { value: '2', label: 'Tue' },
    { value: '3', label: 'Wed' }, { value: '4', label: 'Thu' }, { value: '5', label: 'Fri' },
    { value: '6', label: 'Sat' },
  ]},
]

// ============================================================================
// Helpers
// ============================================================================

function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return 'Schedule needs 5 parts: minute, hour, day, month, and weekday'
  // Basic validation per field
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  for (let i = 0; i < 5; i++) {
    const part = parts[i]
    if (part === '*') continue
    if (/^\*\/\d+$/.test(part)) continue
    if (/^[\d,\-\/]+$/.test(part)) continue
    return `Invalid value in ${FIELDS[i]?.label ?? `field ${i + 1}`}: "${part}"`
  }
  return null
}

// ============================================================================
// Field Editor
// ============================================================================

interface CronFieldProps {
  field: FieldDef
  value: string
  onChange: (value: string) => void
}

function CronField({ field, value, onChange }: CronFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        {field.label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full px-2 py-1.5 text-xs font-mono text-center rounded-md border border-border/50',
          'bg-background focus:outline-none focus:ring-1 focus:ring-accent/50',
        )}
        placeholder="*"
      />
    </div>
  )
}

// ============================================================================
// Component
// ============================================================================

export interface CronBuilderProps {
  value?: string
  onChange?: (cron: string) => void
  timezone?: string
  onTimezoneChange?: (tz: string) => void
  className?: string
}

export function CronBuilder({
  value = '0 9 * * 1-5',
  onChange,
  timezone,
  onTimezoneChange,
  className,
}: CronBuilderProps) {
  const { t } = useTranslation()
  const [rawInput, setRawInput] = useState(value)
  const [fields, setFields] = useState<string[]>(value.split(/\s+/))

  // Sync raw input and fields
  useEffect(() => {
    setRawInput(value)
    setFields(value.split(/\s+/))
  }, [value])

  // Update from raw input
  const handleRawChange = useCallback((raw: string) => {
    setRawInput(raw)
    const parts = raw.trim().split(/\s+/)
    if (parts.length === 5) {
      setFields(parts)
      onChange?.(raw.trim())
    }
  }, [onChange])

  // Update from field editor
  const handleFieldChange = useCallback((index: number, val: string) => {
    const newFields = [...fields]
    newFields[index] = val || '*'
    setFields(newFields)
    const cron = newFields.join(' ')
    setRawInput(cron)
    onChange?.(cron)
  }, [fields, onChange])

  // Apply preset
  const handlePreset = useCallback((cron: string) => {
    setRawInput(cron)
    setFields(cron.split(/\s+/))
    onChange?.(cron)
  }, [onChange])

  const validationError = useMemo(() => validateCron(rawInput), [rawInput])
  const description = useMemo(() => describeCronExpression(rawInput), [rawInput])
  const nextRuns = useMemo(() => computeNextRuns(rawInput), [rawInput])

  return (
    <div className={cn('space-y-5', className)}>
      {/* Layer 1: Common Schedules */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider pl-1">
          Common Schedules
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.cron}
              onClick={() => handlePreset(preset.cron)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                rawInput === preset.cron
                  ? 'bg-foreground/10 text-foreground ring-1 ring-border/50'
                  : 'bg-foreground/[0.03] text-foreground/70 hover:bg-foreground/[0.06] shadow-minimal'
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Layer 2: Custom Schedule */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider pl-1">
          Custom Schedule
        </h4>
        <div className="grid grid-cols-5 gap-2">
          {FIELDS.map((field, i) => (
            <CronField
              key={field.label}
              field={field}
              value={fields[i] || '*'}
              onChange={(val) => handleFieldChange(i, val)}
            />
          ))}
        </div>
      </div>

      {/* Layer 3: Advanced */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider pl-1">
          Advanced
        </h4>
        <input
          type="text"
          value={rawInput}
          onChange={(e) => handleRawChange(e.target.value)}
          className={cn(
            'w-full px-3 py-2 text-sm font-mono rounded-md border',
            'bg-background focus:outline-none focus:ring-1',
            validationError
              ? 'border-destructive/50 focus:ring-destructive/30'
              : 'border-border/50 focus:ring-accent/50'
          )}
          placeholder="* * * * *"
        />
        {validationError && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            {validationError}
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="bg-background shadow-minimal rounded-[8px] p-4 space-y-3">
        {/* Human-readable description */}
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{description}</span>
        </div>

        {/* Next runs */}
        {nextRuns.length > 0 && !validationError && (
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Next runs:</span>
            <div className="flex flex-col gap-0.5">
              {(() => {
                const spansYears = nextRuns.length > 1 && nextRuns[0].getFullYear() !== nextRuns[nextRuns.length - 1].getFullYear()
                return nextRuns.map((date, i) => (
                  <span key={i} className="text-xs text-foreground/70 tabular-nums">
                    {date.toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      ...(spansYears && { year: 'numeric' }),
                    })} {date.toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </span>
                ))
              })()}
            </div>
          </div>
        )}

        {/* Timezone */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('automations.labelTimezone')}:</span>
          <span className="font-medium text-foreground/70">{timezone || t('automations.systemDefault')}</span>
        </div>
      </div>
    </div>
  )
}
