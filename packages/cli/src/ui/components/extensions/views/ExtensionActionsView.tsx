/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { t } from '../../../../i18n/index.js';
import {
  type Config,
  type Extension,
  type ExtensionScope,
  SettingScope,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../../../utils/errors.js';
import { ExtensionUpdateState } from '../../../state/extensions.js';
import {
  PluginDetailView,
  type PluginDetailAction,
} from './PluginDetailView.js';
import { UninstallConfirmStep } from '../steps/UninstallConfirmStep.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

type SubView = 'detail' | 'scope-select' | 'uninstall-confirm';

interface ExtensionActionsViewProps {
  config: Config;
  /** The extension to manage (identified by name; live state is re-read). */
  extension: Extension;
  isActive: boolean;
  /** Current update state for this extension, if known. */
  updateState?: string;
  onStatus: (status: StatusMessage | null) => void;
  /** Ask the parent list to reload (state changed). */
  onReload: () => void;
  /** Leave the detail and return to the list. */
  onExit: () => void;
}

const SCOPE_LABEL: Record<ExtensionScope, string> = {
  user: 'User',
  project: 'Project',
  local: 'Local',
};

function scopeItems(): Array<{
  key: string;
  label: string;
  value: ExtensionScope;
}> {
  return [
    { key: 'user', label: t('Global (User Scope)'), value: 'user' },
    {
      key: 'project',
      label: t('Project (All Collaborators)'),
      value: 'project',
    },
    { key: 'local', label: t('Local (Only You)'), value: 'local' },
  ];
}

export const ExtensionActionsView = ({
  config,
  extension,
  isActive,
  updateState,
  onStatus,
  onReload,
  onExit,
}: ExtensionActionsViewProps) => {
  const manager = config.getExtensionManager();
  const [sub, setSub] = useState<SubView>('detail');
  // Bumped after a mutation to re-read live favorite/scope/active state.
  const [tick, setTick] = useState(0);

  const live = useMemo(() => {
    const current =
      manager?.getLoadedExtensions().find((e) => e.name === extension.name) ??
      extension;
    return {
      ext: current,
      isFavorite: manager?.isFavorite(current.name) ?? false,
      scope: (manager?.getExtensionScope(current.name) ??
        'user') as ExtensionScope,
    };
    // tick forces a re-read after mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, extension, tick]);

  const hasUpdate = updateState === ExtensionUpdateState.UPDATE_AVAILABLE;

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
    onReload();
  }, [onReload]);

  const handleAction = useCallback(
    async (action: PluginDetailAction) => {
      if (!manager) return;
      const name = live.ext.name;
      const settingScope =
        live.scope === 'user' ? SettingScope.User : SettingScope.Workspace;
      try {
        switch (action) {
          case 'toggle':
            if (live.ext.isActive) {
              await manager.disableExtension(name, settingScope);
            } else {
              await manager.enableExtension(name, settingScope);
            }
            onStatus({
              type: 'success',
              text: t('"{{name}}" {{state}}.', {
                name,
                state: live.ext.isActive ? t('disabled') : t('enabled'),
              }),
            });
            refresh();
            break;
          case 'favorite': {
            const now = manager.toggleFavorite(name);
            onStatus({
              type: 'info',
              text: now
                ? t('Added "{{name}}" to favorites.', { name })
                : t('Removed "{{name}}" from favorites.', { name }),
            });
            refresh();
            break;
          }
          case 'change-scope':
            setSub('scope-select');
            break;
          case 'mark-update':
            await manager.checkForAllExtensionUpdates(() => {});
            onStatus({
              type: 'info',
              text: t('Checked "{{name}}" for updates.', { name }),
            });
            break;
          case 'update':
            await manager.updateExtension(
              live.ext,
              ExtensionUpdateState.UPDATE_AVAILABLE,
              () => {},
            );
            onStatus({
              type: 'success',
              text: t('Updated "{{name}}".', { name }),
            });
            refresh();
            break;
          case 'uninstall':
            setSub('uninstall-confirm');
            break;
          default:
            break;
        }
      } catch (error) {
        onStatus({ type: 'error', text: getErrorMessage(error) });
      }
    },
    [manager, live, onStatus, refresh],
  );

  const handleScope = useCallback(
    async (scope: ExtensionScope) => {
      if (!manager) return;
      const name = live.ext.name;
      try {
        manager.setExtensionScope(name, scope);
        // Apply enablement: Global -> User; Project/Local -> workspace only.
        if (scope === 'user') {
          await manager.enableExtension(name, SettingScope.User);
        } else {
          await manager.disableExtension(name, SettingScope.User);
          await manager.enableExtension(name, SettingScope.Workspace);
        }
        onStatus({
          type: 'success',
          text: t('Set "{{name}}" scope to {{scope}}.', {
            name,
            scope: t(SCOPE_LABEL[scope]),
          }),
        });
        refresh();
      } catch (error) {
        onStatus({ type: 'error', text: getErrorMessage(error) });
      }
      setSub('detail');
    },
    [manager, live, onStatus, refresh],
  );

  const handleUninstall = useCallback(
    async (ext: Extension) => {
      if (!manager) return;
      try {
        await manager.uninstallExtension(ext.name, false);
        onStatus({
          type: 'success',
          text: t('Uninstalled "{{name}}".', { name: ext.name }),
        });
        onReload();
      } catch (error) {
        onStatus({ type: 'error', text: getErrorMessage(error) });
      }
      onExit();
    },
    [manager, onStatus, onReload, onExit],
  );

  // Escape: from the detail leaves; from a sub-view returns to the detail.
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (sub === 'detail') onExit();
        else setSub('detail');
      }
    },
    { isActive: isActive && sub !== 'uninstall-confirm' },
  );

  if (sub === 'scope-select') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary}>
          {t('Change scope for "{{name}}":', { name: live.ext.name })}
        </Text>
        <RadioButtonSelect
          items={scopeItems()}
          isFocused={isActive}
          showNumbers={false}
          onSelect={(scope) => void handleScope(scope)}
        />
      </Box>
    );
  }

  if (sub === 'uninstall-confirm') {
    return (
      <UninstallConfirmStep
        selectedExtension={live.ext}
        onConfirm={handleUninstall}
        onNavigateBack={() => setSub('detail')}
      />
    );
  }

  return (
    <PluginDetailView
      extension={live.ext}
      scope={t(SCOPE_LABEL[live.scope])}
      isFavorite={live.isFavorite}
      hasUpdateAvailable={hasUpdate}
      isFocused={isActive && sub === 'detail'}
      onAction={handleAction}
    />
  );
};
