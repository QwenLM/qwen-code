import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Download,
  ExternalLink,
  Loader2,
  Presentation,
  RefreshCw,
  Store,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { SkillMarketplaceItem } from '../../../shared/types'

export interface SkillMarketplacePanelProps {
  workspaceId?: string
  workingDirectory?: string
  onInstalled?: () => Promise<void> | void
  className?: string
}

function sourceHost(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).host
  } catch {
    return sourceUrl
  }
}

export function SkillMarketplacePanel({
  workspaceId,
  workingDirectory,
  onInstalled,
  className,
}: SkillMarketplacePanelProps) {
  const { t } = useTranslation()
  const [skills, setSkills] = React.useState<SkillMarketplaceItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [installingSkillId, setInstallingSkillId] = React.useState<
    string | null
  >(null)

  const loadSkills = React.useCallback(async () => {
    if (!workspaceId) {
      setSkills([])
      return
    }

    setLoading(true)
    setError(null)
    try {
      const items = await window.electronAPI.listSkillMarketplace(
        workspaceId,
        workingDirectory,
      )
      setSkills(items)
    } catch (loadError) {
      console.error(
        '[SkillMarketplacePanel] Failed to load skill marketplace:',
        loadError,
      )
      setError(
        t('skillMarketplace.loadFailed', 'Could not load the skill market.'),
      )
    } finally {
      setLoading(false)
    }
  }, [t, workingDirectory, workspaceId])

  React.useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const handleInstall = React.useCallback(
    async (skill: SkillMarketplaceItem) => {
      if (!workspaceId) return

      setInstallingSkillId(skill.id)
      try {
        await window.electronAPI.installSkillFromMarketplace(
          workspaceId,
          skill.id,
          workingDirectory,
        )
        setSkills((items) =>
          items.map((item) =>
            item.id === skill.id ? { ...item, installed: true } : item,
          ),
        )
        await onInstalled?.()
        await loadSkills()
        toast.success(
          t('skillMarketplace.installedToast', {
            name: skill.name,
            defaultValue: '{{name}} installed',
          }),
        )
      } catch (installError) {
        console.error(
          '[SkillMarketplacePanel] Failed to install marketplace skill:',
          installError,
        )
        toast.error(
          t('skillMarketplace.installFailed', {
            name: skill.name,
            defaultValue: 'Failed to install {{name}}',
          }),
        )
      } finally {
        setInstallingSkillId(null)
      }
    },
    [loadSkills, onInstalled, t, workingDirectory, workspaceId],
  )

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex items-center justify-between border-b border-foreground/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Store className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {t('skillMarketplace.title', 'Skill Market')}
          </span>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          disabled={loading || !workspaceId}
          onClick={() => void loadSkills()}
          title={t('common.refresh', 'Refresh')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {error && (
          <div className="mx-3 mt-3 rounded-[8px] border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && !error && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('skillMarketplace.loading', 'Loading skills...')}
          </div>
        )}

        {!loading && !error && skills.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-muted-foreground">
            <Store className="h-5 w-5" />
            <p className="text-sm">
              {t('skillMarketplace.empty', 'No skills are available yet.')}
            </p>
          </div>
        )}

        {!error &&
          skills.map((skill) => {
            const isInstalling = installingSkillId === skill.id
            return (
              <div
                key={skill.id}
                className="flex min-h-[84px] items-center gap-3 border-b border-foreground/10 px-3 py-3"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-foreground/5">
                  <Presentation className="h-4 w-4 text-muted-foreground" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-medium">
                      {skill.name}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        void window.electronAPI.openUrl(skill.sourceUrl)
                      }
                      title={sourceHost(skill.sourceUrl)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {skill.description}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground/70">
                    {sourceHost(skill.sourceUrl)}
                  </div>
                </div>

                <Button
                  size="sm"
                  className="w-24 shrink-0"
                  variant={skill.installed ? 'secondary' : 'default'}
                  disabled={skill.installed || Boolean(installingSkillId)}
                  onClick={() => void handleInstall(skill)}
                >
                  {isInstalling ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : skill.installed ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {skill.installed
                    ? t('skillMarketplace.installed', 'Installed')
                    : t('skillMarketplace.install', 'Install')}
                </Button>
              </div>
            )
          })}
      </ScrollArea>
    </div>
  )
}
