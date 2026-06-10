/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
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
  /** The extension to manage. A fresh mount is expected per detail open. */
  extension: Extension;
  isActive: boolean;
  /** Current update state for this extension, if known. */
  updateState?: string;
  /** Whether to offer the favorite toggle (hidden in the Sources tab). */
  showFavorite?: boolean;
  onStatus: (status: StatusMessage | null) => void;
  /** Ask the parent list to reload (state changed). */
  onReload: () => void;
  /** Leave the detail and return to the list. */
  onExit: () => void;
}

const SCOPE_LABEL: Record<ExtensionScope, string> = {
  user: 'User',
  project: 'Project',
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
      label: t('Project (Workspace)'),
      value: 'project',
    },
  ];
}

export const ExtensionActionsView = ({
  config,
  extension,
  isActive,
  updateState,
  showFavorite = true,
  onStatus,
  onReload,
  onExit,
}: ExtensionActionsViewProps) => {
  const manager = config.getExtensionManager();
  const [sub, setSub] = useState<SubView>('detail');
  // Authoritative local state. Initialised once on mount and updated
  // optimistically after each action — we do NOT read enablement back through
  // the manager's cache, which is briefly empty during refreshCache().
  const [enabled, setEnabled] = useState(extension.isActive);
  const [isFavorite, setIsFavorite] = useState(
    () => manager?.isFavorite(extension.name) ?? false,
  );
  const [scope, setScope] = useState<ExtensionScope>(
    () => manager?.getExtensionScope(extension.name) ?? 'user',
  );

  const hasUpdate = updateState === ExtensionUpdateState.UPDATE_AVAILABLE;

  const settingScopeFor = (s: ExtensionScope) =>
    s === 'user' ? SettingScope.User : SettingScope.Workspace;

  const handleAction = useCallback(
    async (action: PluginDetailAction) => {
      if (!manager) return;
      const name = extension.name;
      try {
        switch (action) {
          case 'toggle':
            if (enabled) {
              await manager.disableExtension(name, settingScopeFor(scope));
            } else {
              await manager.enableExtension(name, settingScopeFor(scope));
            }
            setEnabled(!enabled);
            onStatus({
              type: 'success',
              text: t('"{{name}}" {{state}}.', {
                name,
                state: enabled ? t('disabled') : t('enabled'),
              }),
            });
            onReload();
            break;
          case 'favorite': {
            const now = manager.toggleFavorite(name);
            setIsFavorite(now);
            onStatus({
              type: 'info',
              text: now
                ? t('Added "{{name}}" to favorites.', { name })
                : t('Removed "{{name}}" from favorites.', { name }),
            });
            onReload();
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
              extension,
              ExtensionUpdateState.UPDATE_AVAILABLE,
              () => {},
            );
            onStatus({
              type: 'success',
              text: t('Updated "{{name}}".', { name }),
            });
            onReload();
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
    [manager, extension, enabled, scope, onStatus, onReload],
  );

  const handleScope = useCallback(
    async (newScope: ExtensionScope) => {
      if (!manager) return;
      const name = extension.name;
      try {
        manager.setExtensionScope(name, newScope);
        // Apply enablement: Global -> User; Project/Local -> workspace only.
        if (newScope === 'user') {
          await manager.enableExtension(name, SettingScope.User);
        } else {
          await manager.disableExtension(name, SettingScope.User);
          await manager.enableExtension(name, SettingScope.Workspace);
        }
        setScope(newScope);
        setEnabled(true);
        onStatus({
          type: 'success',
          text: t('Set "{{name}}" scope to {{scope}}.', {
            name,
            scope: t(SCOPE_LABEL[newScope]),
          }),
        });
        onReload();
      } catch (error) {
        onStatus({ type: 'error', text: getErrorMessage(error) });
      }
      setSub('detail');
    },
    [manager, extension, onStatus, onReload],
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
    const items = scopeItems();
    // Default the cursor to the extension's current scope so the user can see
    // what is in effect (and that a prior change took hold).
    const currentIndex = Math.max(
      0,
      items.findIndex((item) => item.value === scope),
    );
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color={theme.text.primary}>
            {t('Change scope for "{{name}}":', { name: extension.name })}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Current: {{scope}}', { scope: items[currentIndex].label })}
          </Text>
        </Box>
        <RadioButtonSelect
          items={items}
          initialIndex={currentIndex}
          isFocused={isActive}
          showNumbers={false}
          onSelect={(value) => void handleScope(value)}
        />
      </Box>
    );
  }

  if (sub === 'uninstall-confirm') {
    return (
      <UninstallConfirmStep
        selectedExtension={extension}
        onConfirm={handleUninstall}
        onNavigateBack={() => setSub('detail')}
      />
    );
  }

  return (
    <PluginDetailView
      extension={{ ...extension, isActive: enabled }}
      scope={t(SCOPE_LABEL[scope])}
      isFavorite={isFavorite}
      showFavorite={showFavorite}
      hasUpdateAvailable={hasUpdate}
      isFocused={isActive && sub === 'detail'}
      onAction={handleAction}
    />
  );
};
