import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Download,
  ExternalLink,
  Loader2,
  Presentation,
  Store,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { rendererLog } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { useNavigation, routes } from '@/contexts/NavigationContext';
import { dispatchFocusInputEvent } from './input/focus-input-events';
import skillMarketHero from '@/assets/skill-market-hero.webp';
import type {
  SkillMarketplaceExample,
  SkillMarketplaceItem,
} from '../../../shared/types';

export interface SkillMarketplaceDetailPanelProps {
  workspaceId?: string;
  workingDirectory?: string;
  activeSessionId?: string | null;
  selectedSkillId?: string | null;
  onInstalled?: () => Promise<void> | void;
  className?: string;
}

function sourceHost(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).host;
  } catch {
    return sourceUrl;
  }
}

function MarketplaceSkillIcon({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[8px]',
        'border border-amber-300/25 bg-[radial-gradient(circle_at_30%_20%,rgba(255,230,151,0.95),rgba(245,158,11,0.86)_48%,rgba(120,53,15,0.78))] shadow-sm',
        className,
      )}
    >
      <Presentation
        className={cn('text-white drop-shadow-sm', iconClassName)}
      />
    </div>
  );
}

function buildExamplePrompt(
  skill: SkillMarketplaceItem,
  example: SkillMarketplaceExample,
): string {
  return `[skill:${skill.slug}] ${example.prompt}`.trim();
}

export function SkillMarketplaceDetailPanel({
  workspaceId,
  workingDirectory,
  activeSessionId,
  selectedSkillId,
  onInstalled,
  className,
}: SkillMarketplaceDetailPanelProps) {
  const { t } = useTranslation();
  const { navigate } = useNavigation();
  const [skills, setSkills] = React.useState<SkillMarketplaceItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [installingSkillId, setInstallingSkillId] = React.useState<
    string | null
  >(null);

  const loadSkills = React.useCallback(async () => {
    if (!workspaceId) {
      setSkills([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const items = await window.electronAPI.listSkillMarketplace(
        workspaceId,
        workingDirectory,
        activeSessionId ?? undefined,
      );
      setSkills(items);
    } catch (loadError) {
      rendererLog.error(
        '[SkillMarketplaceDetailPanel] Failed to load skill marketplace:',
        loadError,
      );
      setError(
        t('skillMarketplace.loadFailed', 'Could not load the skill market.'),
      );
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, t, workingDirectory, workspaceId]);

  React.useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  React.useEffect(() => {
    if (!workspaceId) return;
    const cleanup = window.electronAPI.onSkillsChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        void loadSkills();
      }
    });
    return cleanup;
  }, [loadSkills, workspaceId]);

  const selectedSkill = selectedSkillId
    ? (skills.find((skill) => skill.id === selectedSkillId) ?? null)
    : null;

  const handleInstall = React.useCallback(
    async (skill: SkillMarketplaceItem) => {
      if (!workspaceId) return;

      setInstallingSkillId(skill.id);
      try {
        await window.electronAPI.installSkillFromMarketplace(
          workspaceId,
          skill.id,
          workingDirectory,
          activeSessionId ?? undefined,
        );
        setSkills((items) =>
          items.map((item) =>
            item.id === skill.id ? { ...item, installed: true } : item,
          ),
        );
        await onInstalled?.();
        await loadSkills();
        toast.success(
          t('skillMarketplace.installedToast', {
            name: skill.name,
            defaultValue: '{{name}} installed',
          }),
        );
      } catch (installError) {
        rendererLog.error(
          '[SkillMarketplaceDetailPanel] Failed to install marketplace skill:',
          installError,
        );
        toast.error(
          t('skillMarketplace.installFailed', {
            name: skill.name,
            defaultValue: 'Failed to install {{name}}',
          }),
        );
      } finally {
        setInstallingSkillId(null);
      }
    },
    [
      activeSessionId,
      loadSkills,
      onInstalled,
      t,
      workingDirectory,
      workspaceId,
    ],
  );

  const handleUseExample = React.useCallback(
    (skill: SkillMarketplaceItem, example: SkillMarketplaceExample) => {
      if (!skill.installed) {
        toast.message(
          t('skillMarketplace.installBeforeExample', {
            name: skill.name,
            defaultValue: 'Install {{name}} to use examples',
          }),
        );
        return;
      }

      void navigate(
        routes.action.newSession({
          input: buildExamplePrompt(skill, example),
        }),
      );
      window.setTimeout(() => dispatchFocusInputEvent(), 120);
    },
    [navigate, t],
  );

  if (loading && !selectedSkill && !error) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('skillMarketplace.loading', 'Loading skills...')}
        </div>
      </div>
    );
  }

  if (error || !selectedSkill) {
    const emptyMessage =
      error ??
      (skills.length === 0
        ? t('skillMarketplace.empty', 'No skills are available yet.')
        : t('skillMarketplace.title', 'Skill Market'));

    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2 text-center">
          <Store className="h-5 w-5" />
          <p className="max-w-xs text-sm">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  const heroImage = selectedSkill.heroImage ?? skillMarketHero;
  const isInstalling = installingSkillId === selectedSkill.id;

  return (
    <ScrollArea className={cn('h-full', className)}>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col px-8 py-9">
        <div className="flex items-start justify-between gap-5">
          <div className="flex min-w-0 items-start gap-4">
            <MarketplaceSkillIcon
              className="h-16 w-16"
              iconClassName="h-7 w-7"
            />
            <div className="min-w-0 pt-1">
              <h1 className="truncate text-3xl font-semibold tracking-normal">
                {selectedSkill.name}
              </h1>
              <p className="mt-2 max-w-2xl text-base leading-6 text-muted-foreground">
                {selectedSkill.tagline}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              onClick={() =>
                void window.electronAPI.openUrl(
                  selectedSkill.websiteUrl ?? selectedSkill.sourceUrl,
                )
              }
              title={sourceHost(
                selectedSkill.websiteUrl ?? selectedSkill.sourceUrl,
              )}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              className="min-w-[108px]"
              variant={selectedSkill.installed ? 'secondary' : 'default'}
              disabled={selectedSkill.installed || Boolean(installingSkillId)}
              onClick={() => void handleInstall(selectedSkill)}
            >
              {isInstalling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : selectedSkill.installed ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {selectedSkill.installed
                ? t('skillMarketplace.installed', 'Installed')
                : t('skillMarketplace.install', 'Install')}
            </Button>
          </div>
        </div>

        <div
          className="relative mt-10 min-h-[260px] overflow-hidden rounded-[8px] border border-white/10 bg-cover bg-center px-6 py-10 shadow-[0_18px_60px_rgba(0,0,0,0.22)]"
          style={{
            backgroundImage: `linear-gradient(90deg, rgba(5,10,18,0.42), rgba(5,10,18,0.16)), url(${heroImage})`,
          }}
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,0.12),transparent_42%)]" />
          <div className="relative flex min-h-[180px] flex-col items-center justify-center gap-4">
            {selectedSkill.examples.map((example, index) => (
              <button
                key={example.title}
                type="button"
                aria-disabled={!selectedSkill.installed}
                className={cn(
                  'flex max-w-full items-center gap-2 rounded-[8px] border border-white/14 bg-black/46 px-4 py-2.5 text-left text-white shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-md transition',
                  selectedSkill.installed
                    ? 'hover:-translate-y-0.5 hover:bg-black/56'
                    : 'cursor-default opacity-55',
                  index === 0 && 'sm:translate-x-[-6%]',
                  index === 1 && 'sm:translate-x-[7%]',
                  index === 2 && 'sm:translate-x-[-1%]',
                )}
                onClick={() => handleUseExample(selectedSkill, example)}
              >
                <MarketplaceSkillIcon
                  className="h-5 w-5 rounded-[6px]"
                  iconClassName="h-3 w-3"
                />
                <span className="shrink-0 text-sm font-medium text-white/55">
                  {selectedSkill.name}
                </span>
                <span className="min-w-0 truncate text-sm">
                  {example.prompt}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-10 max-w-5xl">
          <p className="text-[15px] leading-7 text-foreground/86">
            {selectedSkill.description}
          </p>
        </div>
      </div>
    </ScrollArea>
  );
}
