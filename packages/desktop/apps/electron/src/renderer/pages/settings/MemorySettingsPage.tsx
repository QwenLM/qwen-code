import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { routes } from '@/lib/navigate';
import type { DetailsPageMeta } from '@/lib/navigation-registry';
import { useAppShellContext } from '@/context/AppShellContext';
import type {
  QwenMemoryPathTarget,
  QwenMemoryPaths,
  QwenMemorySettings,
} from '@craft-agent/shared/config';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from '@/components/settings';

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'memory',
};

const DEFAULT_MEMORY_SETTINGS: QwenMemorySettings = {
  enableManagedAutoMemory: true,
  enableManagedAutoDream: false,
  enableAutoSkill: false,
};

export default function MemorySettingsPage() {
  const { t } = useTranslation();
  const { activeWorkspaceId } = useAppShellContext();
  const [settings, setSettings] = useState<QwenMemorySettings>(
    DEFAULT_MEMORY_SETTINGS,
  );
  const [memoryPaths, setMemoryPaths] = useState<QwenMemoryPaths | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) {
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        const [loadedSettings, loadedPaths] = await Promise.all([
          window.electronAPI.getQwenMemorySettings(
            activeWorkspaceId ?? undefined,
          ),
          window.electronAPI.getQwenMemoryPaths(activeWorkspaceId ?? undefined),
        ]);
        setSettings(loadedSettings);
        setMemoryPaths(loadedPaths);
      } catch {
        toast.error(t('settings.memory.failedToLoad'));
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [activeWorkspaceId, t]);

  const openMemoryPath = useCallback(
    async (target: QwenMemoryPathTarget) => {
      try {
        await window.electronAPI.openQwenMemoryPath(
          target,
          activeWorkspaceId ?? undefined,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t('common.unknown');
        toast.error(t('settings.memory.failedToOpen'), {
          description: message,
        });
      }
    },
    [activeWorkspaceId, t],
  );

  const updateMemorySetting = useCallback(
    async <K extends keyof QwenMemorySettings>(
      key: K,
      value: QwenMemorySettings[K],
    ) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
      try {
        const saved = await window.electronAPI.setQwenMemorySettings(
          {
            [key]: value,
          },
          activeWorkspaceId ?? undefined,
        );
        setSettings(saved);
      } catch (error) {
        setSettings((prev) => ({ ...prev, [key]: !value }));
        const message =
          error instanceof Error ? error.message : t('common.unknown');
        toast.error(t('settings.memory.failedToSave'), {
          description: message,
        });
      }
    },
    [activeWorkspaceId, t],
  );

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.memory.title')}
        actions={<HeaderMenu route={routes.view.settings('memory')} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  <SettingsSection
                    title={t('settings.memory.autoMemory')}
                    description={t('settings.memory.autoMemoryDesc')}
                  >
                    <SettingsCard>
                      <SettingsToggle
                        label={t('settings.memory.enableManagedAutoMemory')}
                        description={t(
                          'settings.memory.enableManagedAutoMemoryDesc',
                        )}
                        checked={settings.enableManagedAutoMemory}
                        onCheckedChange={(checked) =>
                          updateMemorySetting(
                            'enableManagedAutoMemory',
                            checked,
                          )
                        }
                      />
                      <SettingsToggle
                        label={t('settings.memory.enableManagedAutoDream')}
                        description={t(
                          'settings.memory.enableManagedAutoDreamDesc',
                        )}
                        checked={settings.enableManagedAutoDream}
                        onCheckedChange={(checked) =>
                          updateMemorySetting('enableManagedAutoDream', checked)
                        }
                      />
                      <SettingsToggle
                        label={t('settings.memory.enableAutoSkill')}
                        description={t('settings.memory.enableAutoSkillDesc')}
                        checked={settings.enableAutoSkill}
                        onCheckedChange={(checked) =>
                          updateMemorySetting('enableAutoSkill', checked)
                        }
                      />
                    </SettingsCard>
                  </SettingsSection>

                  <SettingsSection
                    title={t('settings.memory.management')}
                    description={t('settings.memory.managementDesc')}
                  >
                    <SettingsCard>
                      <SettingsRow
                        label={t('settings.memory.userMemoryFile')}
                        description={
                          memoryPaths?.userMemoryFile ||
                          t('settings.memory.pathUnavailable')
                        }
                        action={
                          <button
                            type="button"
                            onClick={() => openMemoryPath('user')}
                            disabled={!memoryPaths?.userMemoryFile}
                            className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors disabled:opacity-50"
                          >
                            {t('common.open')}
                          </button>
                        }
                      />
                      <SettingsRow
                        label={t('settings.memory.projectMemoryFile')}
                        description={
                          memoryPaths?.projectMemoryFile ||
                          t('settings.memory.pathUnavailable')
                        }
                        action={
                          <button
                            type="button"
                            onClick={() => openMemoryPath('project')}
                            disabled={!memoryPaths?.projectMemoryFile}
                            className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors disabled:opacity-50"
                          >
                            {t('common.open')}
                          </button>
                        }
                      />
                      <SettingsRow
                        label={t('settings.memory.autoMemoryFolder')}
                        description={
                          memoryPaths?.autoMemoryDir ||
                          t('settings.memory.pathUnavailable')
                        }
                        action={
                          <button
                            type="button"
                            onClick={() => openMemoryPath('auto')}
                            disabled={!memoryPaths?.autoMemoryDir}
                            className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors disabled:opacity-50"
                          >
                            {t('common.open')}
                          </button>
                        }
                      />
                    </SettingsCard>
                  </SettingsSection>
                </>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
