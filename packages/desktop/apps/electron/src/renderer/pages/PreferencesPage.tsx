/**
 * PreferencesPage
 *
 * Form-based editor for stored user preferences (~/.craft-agent/preferences.json).
 * Features:
 * - Fixed input fields for known preferences (name, timezone, location, language)
 * - Free-form textarea for notes
 * - Parses JSON on load, serializes back on save
 * - Save/Revert buttons
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@craft-agent/ui'
import { Save, RotateCcw, Check, ExternalLink } from 'lucide-react'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { getFileManagerName } from '@/lib/platform'

interface PreferencesFormState {
  name: string
  timezone: string
  language: string
  city: string
  country: string
  notes: string
}

const emptyFormState: PreferencesFormState = {
  name: '',
  timezone: '',
  language: '',
  city: '',
  country: '',
  notes: '',
}

// Parse JSON to form state
function parsePreferences(json: string): PreferencesFormState {
  try {
    const prefs = JSON.parse(json)
    return {
      name: prefs.name || '',
      timezone: prefs.timezone || '',
      language: prefs.language || '',
      city: prefs.location?.city || '',
      country: prefs.location?.country || '',
      notes: prefs.notes || '',
    }
  } catch {
    return emptyFormState
  }
}

// Serialize form state to JSON
function serializePreferences(state: PreferencesFormState): string {
  const prefs: Record<string, unknown> = {}

  if (state.name) prefs.name = state.name
  if (state.timezone) prefs.timezone = state.timezone
  if (state.language) prefs.language = state.language

  if (state.city || state.country) {
    const location: Record<string, string> = {}
    if (state.city) location.city = state.city
    if (state.country) location.country = state.country
    prefs.location = location
  }

  if (state.notes) prefs.notes = state.notes
  prefs.updatedAt = Date.now()

  return JSON.stringify(prefs, null, 2)
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
      {children}
    </h3>
  )
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex items-center gap-4 py-1.5">
      <Label className="w-20 text-sm text-muted-foreground shrink-0">
        {label}
      </Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 h-8 text-sm"
      />
    </div>
  )
}

export default function PreferencesPage() {
  const { t } = useTranslation()
  const [formState, setFormState] = useState<PreferencesFormState>(emptyFormState)
  const [originalState, setOriginalState] = useState<PreferencesFormState>(emptyFormState)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Deep compare for dirty state
  const isDirty = JSON.stringify(formState) !== JSON.stringify(originalState)

  // Load stored user preferences on mount
  useEffect(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI.readPreferences()
        const parsed = parsePreferences(result.content)
        setFormState(parsed)
        setOriginalState(parsed)
      } catch (err) {
        console.error('Failed to load stored user preferences:', err)
        setFormState(emptyFormState)
        setOriginalState(emptyFormState)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  const updateField = useCallback(<K extends keyof PreferencesFormState>(
    field: K,
    value: PreferencesFormState[K]
  ) => {
    setFormState(prev => ({ ...prev, [field]: value }))
  }, [])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      const json = serializePreferences(formState)
      const result = await window.electronAPI.writePreferences(json)
      if (result.success) {
        setOriginalState(formState)
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 2000)
      } else {
        console.error('Failed to save stored user preferences:', result.error)
      }
    } catch (err) {
      console.error('Failed to save stored user preferences:', err)
    } finally {
      setIsSaving(false)
    }
  }, [formState])

  const handleRevert = useCallback(() => {
    setFormState(originalState)
  }, [originalState])

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="text-lg text-muted-foreground" />
      </div>
    )
  }

  // Header actions
  const headerActions = (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => window.electronAPI.showInFolder('~/.craft-agent/preferences.json')}
        className="flex items-center gap-1 text-xs h-7 px-2 rounded-md bg-foreground/5 hover:bg-foreground/10 text-muted-foreground"
        title={`Show in ${getFileManagerName()}`}
      >
        <ExternalLink className="h-3 w-3" />
      </button>
      <div className={`flex items-center gap-1.5 transition-opacity ${isDirty ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button
          onClick={handleRevert}
          className="flex items-center gap-1 text-xs h-7 px-2 rounded-md bg-foreground/5 hover:bg-foreground/10 text-muted-foreground"
        >
          <RotateCcw className="h-3 w-3" />
          {t("common.revert")}
        </button>
        <Button
          variant="default"
          size="sm"
          onClick={handleSave}
          disabled={isSaving}
          className="text-xs h-7 px-2"
        >
          {isSaving ? (
            <Spinner className="h-3.5 w-3.5 mr-1" />
          ) : saveSuccess ? (
            <Check className="h-3.5 w-3.5 mr-1 text-success" />
          ) : (
            <Save className="h-3.5 w-3.5 mr-1" />
          )}
          {t("common.save")}
        </Button>
      </div>
      <HeaderMenu route={routes.view.settings('preferences')} />
    </div>
  )

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.preferences.title")} actions={headerActions} />
      <Separator />
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          {/* Basic Info */}
          <section>
            <SectionHeader>{t("settings.preferences.basicInfo")}</SectionHeader>
            <div className="space-y-1">
              <FormField
                label={t("settings.preferences.name")}
                value={formState.name}
                onChange={(v) => updateField('name', v)}
                placeholder={t("settings.preferences.namePlaceholder")}
              />
              <FormField
                label={t("settings.preferences.timezone")}
                value={formState.timezone}
                onChange={(v) => updateField('timezone', v)}
                placeholder={t("settings.preferences.timezonePlaceholder")}
              />
              <FormField
                label={t("settings.preferences.language")}
                value={formState.language}
                onChange={(v) => updateField('language', v)}
                placeholder={t("settings.preferences.languagePlaceholder")}
              />
            </div>
          </section>

          {/* Location */}
          <section>
            <SectionHeader>{t("settings.preferences.location")}</SectionHeader>
            <div className="space-y-1">
              <FormField
                label={t("settings.preferences.city")}
                value={formState.city}
                onChange={(v) => updateField('city', v)}
                placeholder={t("settings.preferences.cityPlaceholder")}
              />
              <FormField
                label={t("settings.preferences.country")}
                value={formState.country}
                onChange={(v) => updateField('country', v)}
                placeholder={t("settings.preferences.countryPlaceholder")}
              />
            </div>
          </section>

          {/* Notes */}
          <section>
            <SectionHeader>{t("settings.preferences.notes")}</SectionHeader>
            <Textarea
              value={formState.notes}
              onChange={(e) => updateField('notes', e.target.value)}
              placeholder={t("settings.preferences.notesPlaceholder")}
              className="min-h-[120px] text-sm resize-y"
            />
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}
