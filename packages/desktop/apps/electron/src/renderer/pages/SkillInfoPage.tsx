/**
 * SkillInfoPage
 *
 * Displays comprehensive skill details including metadata,
 * permission modes, and instructions.
 * Uses the Info_ component system for consistent styling with SourceInfoPage.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useEffect, useState, useCallback } from 'react';
import { Check, X, Minus } from 'lucide-react';
import {
  EditPopover,
  EditButton,
  getEditConfig,
} from '@/components/ui/EditPopover';
import { toast } from 'sonner';
import { SkillMenu } from '@/components/app-shell/SkillMenu';
import { SkillAvatar } from '@/components/ui/skill-avatar';
import { routes, navigate } from '@/lib/navigate';
import { useActiveWorkspace } from '@/context/AppShellContext';
import {
  Info_Page,
  Info_Section,
  Info_Table,
  Info_Markdown,
} from '@/components/info';
import type { LoadedSkill } from '../../shared/types';

interface SkillInfoPageProps {
  skillSlug: string;
  workspaceId: string;
  workingDirectory?: string;
  activeSessionId?: string | null;
}

type Translate = ReturnType<typeof useTranslation>['t'];

function getSkillSourceLabel(skill: LoadedSkill, t: Translate): string {
  if (skill.source === 'provider') {
    if (skill.providerLevel === 'bundled') {
      return t('skillInfo.sourceBuiltIn', 'Built-in');
    }
    if (skill.providerLevel === 'user') return t('skillInfo.sourceGlobal');
    if (skill.providerLevel === 'project') return t('skillInfo.sourceProject');
    return 'Qwen Code';
  }
  if (skill.source === 'project') return t('skillInfo.sourceProject');
  if (skill.source === 'global') return t('skillInfo.sourceGlobal');
  return t('skillInfo.sourceWorkspace');
}

function getSkillLocationLabel(skill: LoadedSkill, t: Translate): string {
  if (skill.source === 'provider' && skill.providerLevel === 'bundled') {
    return t('skillInfo.locationBuiltIn', 'Built-in');
  }
  if (!skill.path) return '';

  const skillFile = `${skill.path.replace(/[\\/]+$/, '')}/SKILL.md`;
  if (
    skill.source === 'global' ||
    (skill.source === 'provider' && skill.providerLevel === 'user')
  ) {
    return formatGlobalSkillPath(skillFile);
  }
  return skillFile;
}

function formatGlobalSkillPath(path: string): string {
  for (const marker of ['/.qwen/skills/', '/.agents/skills/']) {
    const index = path.indexOf(marker);
    if (index >= 0) return `~${path.slice(index)}`;
  }
  return path;
}

export default function SkillInfoPage({
  skillSlug,
  workspaceId,
  workingDirectory,
  activeSessionId,
}: SkillInfoPageProps) {
  const { t } = useTranslation();
  const [skill, setSkill] = useState<LoadedSkill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeWorkspace = useActiveWorkspace();
  const canRevealLocally = !activeWorkspace?.remoteServer;

  // Load skill data
  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    const loadSkill = async () => {
      try {
        const skills = await window.electronAPI.getSkills(
          workspaceId,
          workingDirectory,
          activeSessionId ?? undefined,
        );

        if (!isMounted) return;

        // Find the skill by slug
        const found = skills.find((s) => s.slug === skillSlug);
        if (found) {
          setSkill(found);
        } else {
          setError(t('skillInfo.notFound'));
        }
      } catch (err) {
        if (!isMounted) return;
        setError(
          err instanceof Error ? err.message : t('skillInfo.failedToLoad'),
        );
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    loadSkill();

    // Subscribe to skill changes
    const unsubscribe = window.electronAPI.onSkillsChanged?.(
      (changedWorkspaceId, skills) => {
        if (changedWorkspaceId !== workspaceId) return;
        const updated = skills.find((s) => s.slug === skillSlug);
        if (updated) {
          setSkill(updated);
        }
      },
    );

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [workspaceId, skillSlug, workingDirectory, activeSessionId, t]);

  // Handle open in finder
  const handleOpenInFinder = useCallback(async () => {
    if (!skill) return;

    try {
      if (!canRevealLocally || !skill.path) return;
      await window.electronAPI.showInFolder(`${skill.path}/SKILL.md`);
    } catch (err) {
      console.error('Failed to open skill in finder:', err);
    }
  }, [canRevealLocally, skill]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!skill) return;

    try {
      if (skill.source !== 'workspace') return;
      await window.electronAPI.deleteSkill(
        workspaceId,
        skillSlug,
        workingDirectory,
        activeSessionId ?? undefined,
      );
      toast.success(t('skillInfo.deletedSkill', { name: skill.metadata.name }));
      navigate(routes.view.skills());
    } catch (err) {
      toast.error(t('skillInfo.failedToDelete'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [activeSessionId, skill, skillSlug, t, workingDirectory, workspaceId]);

  // Handle opening in new window
  const handleOpenInNewWindow = useCallback(() => {
    window.electronAPI.openUrl(
      `craftagents://skills/skill/${skillSlug}?window=focused`,
    );
  }, [skillSlug]);

  // Get skill name for header
  const skillName = skill?.metadata.name || skillSlug;
  const canDeleteSkill = skill?.source === 'workspace';
  const canEditSkill = Boolean(skill?.path) && skill?.source !== 'provider';

  const sourceLabel = skill ? getSkillSourceLabel(skill, t) : '';
  const locationLabel = skill ? getSkillLocationLabel(skill, t) : '';
  const canOpenLocation =
    Boolean(skill?.path) &&
    canRevealLocally &&
    skill?.providerLevel !== 'bundled';

  // Open the skill folder in Finder with SKILL.md selected
  const handleLocationClick = () => {
    if (!skill) return;
    if (!canOpenLocation || !skill.path) return;
    window.electronAPI.showInFolder(`${skill.path}/SKILL.md`);
  };

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!skill && !loading && !error ? t('skillInfo.notFound') : undefined}
    >
      <Info_Page.Header
        title={skillName}
        titleMenu={
          <SkillMenu
            skillSlug={skillSlug}
            skillName={skillName}
            onOpenInNewWindow={handleOpenInNewWindow}
            onShowInFinder={handleOpenInFinder}
            canShowInFinder={canRevealLocally && Boolean(skill?.path)}
            onDelete={canDeleteSkill ? handleDelete : undefined}
            canDelete={canDeleteSkill}
            deleteLabel={t('skillInfo.deleteSkill')}
          />
        }
      />

      {skill && (
        <Info_Page.Content>
          {/* Hero: Avatar, title, and description */}
          <Info_Page.Hero
            avatar={
              <SkillAvatar skill={skill} fluid workspaceId={workspaceId} />
            }
            title={skill.metadata.name}
            tagline={skill.metadata.description}
          />

          {/* Metadata */}
          <Info_Section
            title={t('skillInfo.metadata')}
            actions={
              canEditSkill ? (
                // EditPopover for AI-assisted metadata editing (name, description in frontmatter)
                <EditPopover
                  trigger={<EditButton />}
                  {...getEditConfig('skill-metadata', skill.path)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: `${skill.path}/SKILL.md`,
                  }}
                />
              ) : undefined
            }
          >
            <Info_Table>
              <Info_Table.Row label={t('common.slug')} value={skill.slug} />
              <Info_Table.Row label={t('common.name')}>
                {skill.metadata.name}
              </Info_Table.Row>
              <Info_Table.Row label={t('common.description')}>
                {skill.metadata.description}
              </Info_Table.Row>
              <Info_Table.Row label={t('common.source')}>
                {sourceLabel}
              </Info_Table.Row>
              {locationLabel && (
                <Info_Table.Row label={t('common.location')}>
                  {canOpenLocation ? (
                    <button
                      onClick={handleLocationClick}
                      className="hover:underline cursor-pointer text-left"
                    >
                      {locationLabel}
                    </button>
                  ) : (
                    locationLabel
                  )}
                </Info_Table.Row>
              )}
              {skill.metadata.requiredSources &&
                skill.metadata.requiredSources.length > 0 && (
                  <Info_Table.Row label={t('skillInfo.requiredSources')}>
                    {skill.metadata.requiredSources.join(', ')}
                  </Info_Table.Row>
                )}
            </Info_Table>
          </Info_Section>

          {/* Permission Modes */}
          {skill.metadata.alwaysAllow &&
            skill.metadata.alwaysAllow.length > 0 && (
              <Info_Section title={t('skillInfo.permissionModes')}>
                <div className="space-y-2 px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-3">
                    {t('skillInfo.permissionModesDesc')}
                  </p>
                  <div className="rounded-[8px] border border-border/50 overflow-hidden">
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-b border-border/30">
                          <td className="px-3 py-2 font-medium text-muted-foreground w-[140px]">
                            {t('skillInfo.explore')}
                          </td>
                          <td className="px-3 py-2 flex items-center gap-2">
                            <X className="h-3.5 w-3.5 text-destructive shrink-0" />
                            <span className="text-foreground/80">
                              {t('skillInfo.exploreDesc')}
                            </span>
                          </td>
                        </tr>
                        <tr className="border-b border-border/30">
                          <td className="px-3 py-2 font-medium text-muted-foreground">
                            {t('skillInfo.askToEdit')}
                          </td>
                          <td className="px-3 py-2 flex items-center gap-2">
                            <Check className="h-3.5 w-3.5 text-success shrink-0" />
                            <span className="text-foreground/80">
                              {t('skillInfo.askToEditDesc')}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td className="px-3 py-2 font-medium text-muted-foreground">
                            {t('skillInfo.auto')}
                          </td>
                          <td className="px-3 py-2 flex items-center gap-2">
                            <Minus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="text-foreground/80">
                              {t('skillInfo.autoDesc')}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </Info_Section>
            )}

          {/* Instructions */}
          <Info_Section
            title={t('skillInfo.instructions')}
            actions={
              canEditSkill ? (
                // EditPopover for AI-assisted editing with "Edit File" as secondary action
                <EditPopover
                  trigger={<EditButton />}
                  {...getEditConfig('skill-instructions', skill.path)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: `${skill.path}/SKILL.md`,
                  }}
                />
              ) : undefined
            }
          >
            <Info_Markdown maxHeight={540} fullscreen>
              {skill.content || t('skillInfo.noInstructions')}
            </Info_Markdown>
          </Info_Section>
        </Info_Page.Content>
      )}
    </Info_Page>
  );
}
