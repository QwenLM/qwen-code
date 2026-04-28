/**
 * AiSettingsPage
 *
 * Qwen Code is the only supported backend. This page therefore focuses on the
 * settings users can still change: model, thinking level, and performance.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { toast } from 'sonner'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { cn } from '@/lib/utils'
import { useWorkspaceIcon } from '@/hooks/useWorkspaceIcon'
import { useAppShellContext } from '@/context/AppShellContext'
import {
  SettingsSection,
  SettingsCard,
  SettingsMenuSelectRow,
  SettingsToggle,
} from '@/components/settings'
import type { LlmConnection, LlmConnectionWithStatus, ThinkingLevel, Workspace, WorkspaceSettings } from '../../../shared/types'
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from '@craft-agent/shared/agent/thinking-levels'
import { getModelShortName, type ModelDefinition } from '@config/models'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'ai',
}

function getModelOptionsForConnection(
  connection: LlmConnectionWithStatus | undefined,
): Array<{ value: string; label: string; description?: string; descriptionKey?: string }> {
  if (!connection) return []

  if (connection.models && connection.models.length > 0) {
    return connection.models.map((model) => {
      if (typeof model === 'string') {
        return { value: model, label: getModelShortName(model) }
      }
      const definition = model as ModelDefinition
      return {
        value: definition.id,
        label: definition.name,
        description: definition.description,
        descriptionKey: definition.descriptionKey,
      }
    })
  }

  if (connection.defaultModel) {
    return [{
      value: connection.defaultModel,
      label: getModelShortName(connection.defaultModel),
    }]
  }

  return []
}

const WORKSPACE_SETTING_LABELS: Partial<Record<keyof WorkspaceSettings, string>> = {
  model: 'workspace model override',
  thinkingLevel: 'workspace thinking override',
}

interface WorkspaceOverrideCardProps {
  workspace: Workspace
  modelOptions: Array<{ value: string; label: string; description?: string }>
  onSettingsChange: () => void
}

function WorkspaceOverrideCard({ workspace, modelOptions, onSettingsChange }: WorkspaceOverrideCardProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const iconUrl = useWorkspaceIcon(workspace)

  useEffect(() => {
    const loadSettings = async () => {
      if (!window.electronAPI) return
      setIsLoading(true)
      try {
        const workspaceSettings = await window.electronAPI.getWorkspaceSettings(workspace.id)
        setSettings(workspaceSettings)
      } catch (error) {
        console.error('Failed to load workspace settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadSettings()
  }, [workspace.id])

  const updateSetting = useCallback(async <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
    if (!window.electronAPI) return

    const previousValue = settings?.[key]
    setSettings(prev => prev ? { ...prev, [key]: value } : prev)

    try {
      await window.electronAPI.updateWorkspaceSetting(workspace.id, key, value)
      onSettingsChange()
    } catch (error) {
      setSettings(prev => prev ? { ...prev, [key]: previousValue } : prev)

      const message = error instanceof Error ? error.message : 'Unknown error'
      const settingLabel = WORKSPACE_SETTING_LABELS[key] ?? String(key)
      console.error(`Failed to save ${String(key)}:`, error)
      toast.error(t("toast.failedToSaveSetting", { setting: settingLabel }), {
        description: message,
      })
    }
  }, [workspace.id, onSettingsChange, settings, t])

  const handleModelChange = useCallback((model: string) => {
    updateSetting('model', model === 'global' ? undefined : model)
  }, [updateSetting])

  const handleThinkingChange = useCallback((level: string) => {
    updateSetting('thinkingLevel', level === 'global' ? undefined : level as ThinkingLevel)
  }, [updateSetting])

  const hasOverrides = !!(settings?.model || settings?.thinkingLevel)
  const currentModel = settings?.model || 'global'
  const currentThinking = settings?.thinkingLevel || 'global'

  const getSummary = () => {
    if (!hasOverrides) return t("settings.ai.usingDefaults")
    const parts: string[] = []
    if (settings?.model) parts.push(getModelShortName(settings.model))
    if (settings?.thinkingLevel) {
      const level = THINKING_LEVELS.find(item => item.id === settings.thinkingLevel)
      parts.push(level ? t(level.nameKey) : settings.thinkingLevel)
    }
    return parts.join(' · ')
  }

  return (
    <SettingsCard>
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between py-3 px-4 hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              'w-6 h-6 rounded-full overflow-hidden bg-foreground/5 flex items-center justify-center shrink-0',
              'ring-1 ring-border/50'
            )}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-muted-foreground">
                {workspace.name?.charAt(0)?.toUpperCase() || 'W'}
              </span>
            )}
          </div>
          <div className="text-left min-w-0">
            <div className="text-sm font-medium truncate">{workspace.name}</div>
            <div className="text-xs text-muted-foreground truncate">
              {isLoading ? t("common.loading") : getSummary()}
            </div>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 px-4 py-2">
              <SettingsMenuSelectRow
                label={t("settings.ai.model")}
                description={t("settings.ai.modelDesc")}
                value={currentModel}
                onValueChange={handleModelChange}
                options={[
                  { value: 'global', label: t("settings.ai.useDefault"), description: t("settings.ai.inheritFromApp") },
                  ...modelOptions,
                ]}
                searchable={modelOptions.length > 8}
              />
              <SettingsMenuSelectRow
                label={t("settings.ai.thinking")}
                description={t("settings.ai.thinkingDesc")}
                value={currentThinking}
                onValueChange={handleThinkingChange}
                options={[
                  { value: 'global', label: t("settings.ai.useDefault"), description: t("settings.ai.inheritFromApp") },
                  ...THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => ({
                    value: id,
                    label: t(nameKey),
                    description: t(descriptionKey),
                  })),
                ]}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SettingsCard>
  )
}

export default function AiSettingsPage() {
  const { t } = useTranslation()
  const { llmConnections, refreshLlmConnections, activeWorkspaceId } = useAppShellContext()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [defaultThinking, setDefaultThinking] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)
  const [extendedPromptCache, setExtendedPromptCache] = useState(false)
  const [enable1MContext, setEnable1MContext] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const ws = await window.electronAPI.getWorkspaces()
        setWorkspaces(ws)

        const defaultThinkingLevel = await window.electronAPI.getDefaultThinkingLevel()
        setDefaultThinking(defaultThinkingLevel)

        const extendedCache = await window.electronAPI.getExtendedPromptCache()
        setExtendedPromptCache(extendedCache)

        const enable1M = await window.electronAPI.getEnable1MContext()
        setEnable1MContext(enable1M)
      } catch (error) {
        console.error('Failed to load settings:', error)
      }
    }
    load()
  }, [activeWorkspaceId])

  const qwenConnection = useMemo(() => (
    llmConnections.find(connection => connection.providerType === 'qwen') ?? llmConnections[0]
  ), [llmConnections])

  const modelOptions = useMemo(() => (
    getModelOptionsForConnection(qwenConnection).map(option => ({
      ...option,
      description: option.descriptionKey ? t(option.descriptionKey) : option.description,
    }))
  ), [qwenConnection, t])

  const defaultModel = qwenConnection?.defaultModel || modelOptions[0]?.value || ''

  const handleDefaultModelChange = useCallback(async (model: string) => {
    if (!window.electronAPI || !qwenConnection) return
    const { isAuthenticated: _isAuthenticated, authError: _authError, isDefault: _isDefault, ...connectionData } = {
      ...qwenConnection,
      defaultModel: model,
    }
    await window.electronAPI.saveLlmConnection(connectionData as LlmConnection)
    await refreshLlmConnections()
  }, [qwenConnection, refreshLlmConnections])

  const handleDefaultThinkingChange = useCallback(async (level: ThinkingLevel) => {
    if (!window.electronAPI) return

    const previous = defaultThinking
    setDefaultThinking(level)

    try {
      const result = await window.electronAPI.setDefaultThinkingLevel(level)
      if (!result.success) {
        console.error('Failed to set default thinking level:', result.error)
        setDefaultThinking(previous)
      }
    } catch (error) {
      console.error('Failed to set default thinking level:', error)
      setDefaultThinking(previous)
    }
  }, [defaultThinking])

  const handleExtendedPromptCacheChange = useCallback(async (enabled: boolean) => {
    setExtendedPromptCache(enabled)
    await window.electronAPI?.setExtendedPromptCache(enabled)
  }, [])

  const handleEnable1MContextChange = useCallback(async (enabled: boolean) => {
    setEnable1MContext(enabled)
    await window.electronAPI?.setEnable1MContext(enabled)
  }, [])

  const handleWorkspaceSettingsChange = useCallback(() => {
    refreshLlmConnections?.()
  }, [refreshLlmConnections])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.ai.title")} actions={<HeaderMenu route={routes.view.settings('ai')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection title={t("settings.ai.defaultSection")} description={t("settings.ai.defaultSectionDesc")}>
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t("settings.ai.model")}
                    description={t("settings.ai.modelDesc")}
                    value={defaultModel}
                    onValueChange={handleDefaultModelChange}
                    options={modelOptions}
                    disabled={modelOptions.length === 0}
                    placeholder={t("common.loading")}
                    searchable={modelOptions.length > 8}
                  />
                  <SettingsMenuSelectRow
                    label={t("settings.ai.thinking")}
                    description={t("settings.ai.thinkingDesc")}
                    value={defaultThinking}
                    onValueChange={(value) => handleDefaultThinkingChange(value as ThinkingLevel)}
                    options={THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => ({
                      value: id,
                      label: t(nameKey),
                      description: t(descriptionKey),
                    }))}
                  />
                </SettingsCard>
              </SettingsSection>

              {workspaces.length > 0 && (
                <SettingsSection title={t("settings.ai.workspaceOverrides")} description={t("settings.ai.workspaceOverridesDesc")}>
                  <div className="space-y-2">
                    {workspaces.map((workspace) => (
                      <WorkspaceOverrideCard
                        key={workspace.id}
                        workspace={workspace}
                        modelOptions={modelOptions}
                        onSettingsChange={handleWorkspaceSettingsChange}
                      />
                    ))}
                  </div>
                </SettingsSection>
              )}

              <SettingsSection title={t("settings.ai.performance")} description={t("settings.ai.performanceDesc")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.ai.extendedContext")}
                    description={t("settings.ai.extendedContextDesc")}
                    checked={enable1MContext}
                    onCheckedChange={handleEnable1MContextChange}
                  />
                  <SettingsToggle
                    label={t("settings.ai.extendedPromptCache")}
                    description={t("settings.ai.extendedPromptCacheDesc")}
                    checked={extendedPromptCache}
                    onCheckedChange={handleExtendedPromptCacheChange}
                  />
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
