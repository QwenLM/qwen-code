/**
 * AiSettingsPage
 *
 * The local ACP backend is the only supported backend. This page focuses on the
 * settings users can still change: model and performance.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';

import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { Button } from '@/components/ui/button';
import { routes } from '@/lib/navigate';
import type { DetailsPageMeta } from '@/lib/navigation-registry';
import { useAppShellContext } from '@/context/AppShellContext';
import { ProviderConnectDialog } from '@/components/apisetup';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsMenuSelectRow,
  SettingsToggle,
} from '@/components/settings';
import type {
  LlmConnection,
  LlmConnectionWithStatus,
} from '../../../shared/types';
import { getModelShortName, type ModelDefinition } from '@config/models';

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'ai',
};

function getModelOptionsForConnection(
  connection: LlmConnectionWithStatus | undefined,
): Array<{
  value: string;
  label: string;
  description?: string;
  descriptionKey?: string;
}> {
  if (!connection) return [];

  if (connection.models && connection.models.length > 0) {
    return connection.models.map((model) => {
      if (typeof model === 'string') {
        return { value: model, label: getModelShortName(model) };
      }
      const definition = model as ModelDefinition;
      return {
        value: definition.id,
        label: definition.name,
        description: definition.description,
        descriptionKey: definition.descriptionKey,
      };
    });
  }

  if (connection.defaultModel) {
    return [
      {
        value: connection.defaultModel,
        label: getModelShortName(connection.defaultModel),
      },
    ];
  }

  return [];
}

export default function AiSettingsPage() {
  const { t } = useTranslation();
  const { llmConnections, refreshLlmConnections } = useAppShellContext();
  const [extendedPromptCache, setExtendedPromptCache] = useState(false);
  const [enable1MContext, setEnable1MContext] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return;
      try {
        const extendedCache = await window.electronAPI.getExtendedPromptCache();
        setExtendedPromptCache(extendedCache);

        const enable1M = await window.electronAPI.getEnable1MContext();
        setEnable1MContext(enable1M);
      } catch {
        // Keep the page usable if optional settings cannot be read.
      }
    };
    load();
  }, []);

  const qwenConnection = useMemo(
    () =>
      llmConnections.find((connection) => connection.providerType === 'qwen') ??
      llmConnections[0],
    [llmConnections],
  );

  const modelOptions = useMemo(
    () =>
      getModelOptionsForConnection(qwenConnection).map((option) => ({
        ...option,
        description: option.descriptionKey
          ? t(option.descriptionKey)
          : option.description,
      })),
    [qwenConnection, t],
  );

  const defaultModel =
    qwenConnection?.defaultModel || modelOptions[0]?.value || '';
  const modelCount = modelOptions.length;
  const providerConnectionLabel =
    qwenConnection?.providerType === 'qwen'
      ? t('settings.ai.providerConnectionName')
      : qwenConnection?.name || t('settings.ai.providerConnectionName');

  const handleDefaultModelChange = useCallback(
    async (model: string) => {
      if (!window.electronAPI || !qwenConnection) return;
      const {
        isAuthenticated: _isAuthenticated,
        authError: _authError,
        isDefault: _isDefault,
        ...connectionData
      } = {
        ...qwenConnection,
        defaultModel: model,
      };
      await window.electronAPI.saveLlmConnection(
        connectionData as LlmConnection,
      );
      await refreshLlmConnections();
    },
    [qwenConnection, refreshLlmConnections],
  );

  const handleExtendedPromptCacheChange = useCallback(
    async (enabled: boolean) => {
      setExtendedPromptCache(enabled);
      await window.electronAPI?.setExtendedPromptCache(enabled);
    },
    [],
  );

  const handleEnable1MContextChange = useCallback(async (enabled: boolean) => {
    setEnable1MContext(enabled);
    await window.electronAPI?.setEnable1MContext(enabled);
  }, []);

  const handleProviderConnected = useCallback(async () => {
    await refreshLlmConnections();
  }, [refreshLlmConnections]);

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.ai.title')}
        actions={<HeaderMenu route={routes.view.settings('ai')} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={t('settings.ai.defaultSection')}
                description={t('settings.ai.defaultSectionDesc')}
              >
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t('settings.ai.model')}
                    description={t('settings.ai.modelDesc')}
                    value={defaultModel}
                    onValueChange={handleDefaultModelChange}
                    options={modelOptions}
                    disabled={modelOptions.length === 0}
                    placeholder={t('common.loading')}
                    searchable={modelOptions.length > 8}
                  />
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                title={t('settings.ai.modelProvider')}
                description={t('settings.ai.modelProviderDesc')}
              >
                <SettingsCard>
                  <SettingsRow
                    label={providerConnectionLabel}
                    description={
                      modelCount > 0
                        ? t('settings.ai.modelsAvailable', {
                            count: modelCount,
                          })
                        : t('settings.ai.noProviderModels')
                    }
                    action={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setProviderDialogOpen(true)}
                      >
                        <Plus className="size-3.5" />
                        {t('auth.connect')}
                      </Button>
                    }
                  />
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                title={t('settings.ai.performance')}
                description={t('settings.ai.performanceDesc')}
              >
                <SettingsCard>
                  <SettingsToggle
                    label={t('settings.ai.extendedContext')}
                    description={t('settings.ai.extendedContextDesc')}
                    checked={enable1MContext}
                    onCheckedChange={handleEnable1MContextChange}
                  />
                  <SettingsToggle
                    label={t('settings.ai.extendedPromptCache')}
                    description={t('settings.ai.extendedPromptCacheDesc')}
                    checked={extendedPromptCache}
                    onCheckedChange={handleExtendedPromptCacheChange}
                  />
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
      <ProviderConnectDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        onConnected={handleProviderConnected}
      />
    </div>
  );
}
