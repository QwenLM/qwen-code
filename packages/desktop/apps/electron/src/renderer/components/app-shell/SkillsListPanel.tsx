import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MoreHorizontal, Zap } from 'lucide-react'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
} from '@/components/ui/styled-dropdown'
import { DropdownMenuProvider } from '@/components/ui/menu-context'
import { skillSelection } from '@/hooks/useEntitySelection'
import { SkillMenu } from './SkillMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import {
  useActiveWorkspace,
  useAppShellContext,
} from '@/context/AppShellContext'
import type { LoadedSkill } from '../../../shared/types'

export interface SkillsListPanelProps {
  skills: LoadedSkill[]
  onDeleteSkill: (skillSlug: string) => void
  onSetSkillEnabled?: (skillSlug: string, enabled: boolean) => Promise<void>
  onSkillClick: (skill: LoadedSkill) => void
  selectedSkillSlug?: string | null
  workspaceId?: string
  workspaceRootPath?: string
  isLoading?: boolean
  className?: string
}

export function SkillsListPanel({
  skills,
  onDeleteSkill,
  onSetSkillEnabled,
  onSkillClick,
  selectedSkillSlug,
  workspaceId,
  workspaceRootPath,
  isLoading = false,
  className,
}: SkillsListPanelProps) {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const canRevealLocally = !activeWorkspace?.remoteServer
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1
  const [updatingSkillSlug, setUpdatingSkillSlug] = React.useState<
    string | null
  >(null)

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(
    null,
  )
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  return (
    <>
      <div
        className={
          className
            ? `flex flex-col flex-1 min-h-0 ${className}`
            : 'flex flex-col flex-1 min-h-0'
        }
      >
        <EntityPanel<LoadedSkill>
          items={skills}
          getId={(s) => s.slug}
          selection={skillSelection}
          selectedId={selectedSkillSlug}
          onItemClick={onSkillClick}
          className="min-h-0"
          emptyState={
            isLoading ? (
              <EntityListEmptyScreen
                icon={<Loader2 className="animate-spin" />}
                title={t('common.loading')}
                description=""
              />
            ) : (
              <EntityListEmptyScreen
                icon={<Zap />}
                title={t('skillsList.noSkillsConfigured')}
                description={t('skillsList.emptyDescription')}
                docKey="skills"
              >
                <div className="flex items-center gap-2">
                  {workspaceRootPath && (
                    <EditPopover
                      align="center"
                      trigger={
                        <Button size="sm" variant="outline">
                          {t('skillsList.addSkill')}
                        </Button>
                      }
                      {...getEditConfig('add-skill', workspaceRootPath)}
                    />
                  )}
                </div>
              </EntityListEmptyScreen>
            )
          }
          mapItem={(skill) => {
            const canManageProviderSkill =
              skill.source === 'provider' && skill.providerLevel === 'user'
            const canDelete =
              skill.source === 'workspace' || canManageProviderSkill
            const canToggle =
              canManageProviderSkill && Boolean(onSetSkillEnabled)
            const isUpdating = updatingSkillSlug === skill.slug
            const menu = (
              <SkillMenu
                skillSlug={skill.slug}
                skillName={skill.metadata.name}
                onOpenInNewWindow={() =>
                  window.electronAPI.openUrl(
                    `craftagents://skills/skill/${skill.slug}?window=focused`,
                  )
                }
                onShowInFinder={() => {
                  if (canRevealLocally && skill.path) {
                    void window.electronAPI.showInFolder(
                      `${skill.path}/SKILL.md`,
                    )
                  }
                }}
                canShowInFinder={canRevealLocally && Boolean(skill.path)}
                onDelete={
                  canDelete ? () => onDeleteSkill(skill.slug) : undefined
                }
                canDelete={canDelete}
                deleteLabel={t('skillsList.deleteSkill')}
                onSendToWorkspace={
                  hasOtherWorkspaces && skill.source === 'workspace'
                    ? () => {
                        setSendResourceSlug(skill.slug)
                        setSendResourceLabel(skill.metadata.name)
                        setSendDialogOpen(true)
                      }
                    : undefined
                }
              />
            )

            return {
              icon: (
                <SkillAvatar
                  skill={skill}
                  size="sm"
                  workspaceId={workspaceId}
                />
              ),
              title: skill.metadata.name,
              badges: (
                <span className="flex items-center gap-1.5 min-w-0">
                  {skill.source === 'project' && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/5 text-muted-foreground">
                      {t('skillsList.projectBadge')}
                    </span>
                  )}
                  <span className="truncate">{skill.metadata.description}</span>
                </span>
              ),
              controls: canToggle ? (
                <>
                  <DropdownMenu modal={true}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('common.more', 'More')}
                        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-foreground/8 data-[state=open]:bg-foreground/8"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <StyledDropdownMenuContent align="end">
                      <DropdownMenuProvider>{menu}</DropdownMenuProvider>
                    </StyledDropdownMenuContent>
                  </DropdownMenu>
                  <Switch
                    aria-label={
                      (skill.enabled ?? true)
                        ? t('skillsList.disableSkill', 'Disable skill')
                        : t('skillsList.enableSkill', 'Enable skill')
                    }
                    checked={skill.enabled ?? true}
                    disabled={isUpdating}
                    onCheckedChange={(checked) => {
                      if (!onSetSkillEnabled) return
                      setUpdatingSkillSlug(skill.slug)
                      void onSetSkillEnabled(skill.slug, checked).finally(() =>
                        setUpdatingSkillSlug(null),
                      )
                    }}
                  />
                </>
              ) : undefined,
              menu,
              hideMoreButton: canToggle,
            }
          }}
        />
      </div>

      {/* Send to Workspace dialog */}
      {sendResourceSlug && (
        <SendResourceToWorkspaceDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType="skill"
          resourceIds={[sendResourceSlug]}
          resourceLabel={sendResourceLabel}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
    </>
  )
}
