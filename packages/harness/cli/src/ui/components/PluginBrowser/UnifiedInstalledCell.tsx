/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UnifiedInstalledCell — Row renderer for the Installed tab unified list.
 *
 * Handles four item types from the UnifiedInstalledItem discriminated union:
 *  - plugin:         Status icon (✓/○/✖/→) + marketplace
 *  - failed-plugin:  ✖ error count + marketplace
 *  - mcp-server:     Connection status, optional └ indent for child servers
 *  - pending-plugin: Installed but not yet loaded
 *
 * Selection state controls pointer prefix and color highlighting.
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { UnifiedInstalledItem } from './unifiedTypes.js';
import { SCOPE_LABELS } from './pluginDetailsHelpers.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface UnifiedInstalledCellProps {
  item: UnifiedInstalledItem;
  isSelected: boolean;
  scopeLabel?: string;
  shadowedByLabel?: string;
}

// ---------------------------------------------------------------------------
// Status resolution helpers
// ---------------------------------------------------------------------------

interface StatusInfo {
  icon: string;
  color: string;
  text: string;
}

function getPluginStatus(
  item: Extract<UnifiedInstalledItem, { type: 'plugin' }>,
): StatusInfo {
  if (item.pendingRemoval) {
    return {
      icon: '⟳',
      color: theme.ui.focus,
      text: 'uninstalled (reload to apply)',
    };
  }
  if (item.needsReload) {
    const base = item.isEnabled ? 'enabled' : 'disabled';
    return {
      icon: '⟳',
      color: theme.ui.focus,
      text: `${base} (pending reload)`,
    };
  }
  if (item.errorCount > 0) {
    return {
      icon: '✖',
      color: theme.status.error,
      text: `${item.errorCount} error${item.errorCount !== 1 ? 's' : ''}`,
    };
  }
  if (!item.isEnabled) {
    return {
      icon: '○',
      color: theme.text.secondary,
      text: 'disabled',
    };
  }
  return {
    icon: '✓',
    color: theme.status.success,
    text: 'enabled',
  };
}

function getMcpStatus(
  item: Extract<UnifiedInstalledItem, { type: 'mcp-server' }>,
): StatusInfo {
  switch (item.status) {
    case 'connected':
      return { icon: '✓', color: theme.status.success, text: 'connected' };
    case 'disabled':
      return { icon: '○', color: theme.text.secondary, text: 'disabled' };
    case 'pending':
      return { icon: '○', color: theme.text.secondary, text: 'connecting…' };
    case 'needs-auth':
      return { icon: '△', color: theme.status.warning, text: 'Enter to auth' };
    case 'failed':
    default:
      return { icon: '✖', color: theme.status.error, text: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Shared shadowed row renderer
// ---------------------------------------------------------------------------

function ShadowedRow({
  pointer,
  isSelected,
  name,
  scopeLabel,
  shadowLabel,
}: {
  pointer: string;
  isSelected: boolean;
  name: string;
  scopeLabel: string;
  shadowLabel: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Text color={isSelected ? theme.ui.focus : undefined}>{pointer}</Text>
      <Text dimColor>{name}</Text>
      <Text dimColor> · {scopeLabel} scope</Text>
      <Text dimColor> · shadowed by {shadowLabel}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const UnifiedInstalledCell: React.FC<UnifiedInstalledCellProps> = ({
  item,
  isSelected,
  scopeLabel: providedScopeLabel,
  shadowedByLabel,
}) => {
  const pointer = isSelected ? '❯ ' : '  ';
  const nameColor = isSelected ? theme.ui.focus : theme.text.primary;

  const rendered = useMemo(() => {
    switch (item.type) {
      // ----- Plugin -----
      case 'plugin': {
        const status = getPluginStatus(item);
        const scopeLabel =
          providedScopeLabel ??
          SCOPE_LABELS[item.installScope ?? ''] ??
          item.installScope ??
          '';

        if (item.shadowed) {
          return (
            <ShadowedRow
              pointer={pointer}
              isSelected={isSelected}
              name={item.name}
              scopeLabel={scopeLabel}
              shadowLabel={
                shadowedByLabel ??
                SCOPE_LABELS[item.shadowedBy ?? ''] ??
                item.shadowedBy ??
                ''
              }
            />
          );
        }

        return (
          <Box flexDirection="row">
            <Text color={isSelected ? theme.ui.focus : undefined}>
              {pointer}
            </Text>
            <Text color={nameColor} bold={isSelected}>
              {item.name}
            </Text>
            <Text> </Text>
            <Text color={theme.background.message} dimColor={!isSelected}>
              Plugin
            </Text>
            {scopeLabel ? (
              <>
                <Text dimColor> · </Text>
                <Text dimColor>{scopeLabel}</Text>
              </>
            ) : null}
            <Text dimColor> · </Text>
            <Text color={status.color} dimColor={!isSelected}>
              {status.icon}
            </Text>
            <Text color={status.color} dimColor={!isSelected}>
              {' '}
              {status.text}
            </Text>
          </Box>
        );
      }

      // ----- Failed Plugin -----
      case 'failed-plugin': {
        const errText = `failed to load · ${item.errorCount} error${item.errorCount !== 1 ? 's' : ''}`;
        return (
          <Box flexDirection="row">
            <Text color={isSelected ? theme.ui.focus : undefined}>
              {pointer}
            </Text>
            <Text color={nameColor} bold={isSelected}>
              {item.name}
            </Text>
            <Text> </Text>
            <Text color={theme.background.message} dimColor={!isSelected}>
              Plugin
            </Text>
            <Text dimColor> · </Text>
            <Text color={theme.status.error} dimColor={!isSelected}>
              ✖
            </Text>
            <Text color={theme.status.error} dimColor={!isSelected}>
              {' '}
              {errText}
            </Text>
          </Box>
        );
      }

      // ----- MCP Server -----
      case 'mcp-server': {
        const status = getMcpStatus(item);
        return (
          <Box flexDirection="row">
            <Text color={isSelected ? theme.ui.focus : undefined}>
              {pointer}
            </Text>
            {item.indented && <Text dimColor={!isSelected}>└ </Text>}
            <Text color={nameColor} bold={isSelected}>
              {item.name}
            </Text>
            <Text> </Text>
            <Text color="cyan" dimColor={!isSelected}>
              MCP
            </Text>
            <Text dimColor> · </Text>
            <Text color={status.color} dimColor={!isSelected}>
              {status.icon}
            </Text>
            <Text color={status.color} dimColor={!isSelected}>
              {' '}
              {status.text}
            </Text>
          </Box>
        );
      }

      // ----- Pending Plugin (installed but not yet loaded) -----
      case 'pending-plugin': {
        if (item.shadowed) {
          return (
            <ShadowedRow
              pointer={pointer}
              isSelected={isSelected}
              name={item.name}
              scopeLabel={
                providedScopeLabel ?? SCOPE_LABELS[item.scope] ?? item.scope
              }
              shadowLabel={
                shadowedByLabel ??
                SCOPE_LABELS[item.shadowedBy ?? ''] ??
                item.shadowedBy ??
                ''
              }
            />
          );
        }

        const pendingStatusText = item.isEnabled
          ? 'enabled (needs reload)'
          : 'disabled (needs reload)';
        const pendingIcon = item.isEnabled ? '✓' : '○';
        const pendingColor = item.isEnabled
          ? theme.status.success
          : theme.text.secondary;
        return (
          <Box flexDirection="row">
            <Text color={isSelected ? theme.ui.focus : undefined}>
              {pointer}
            </Text>
            <Text color={nameColor} bold={isSelected}>
              {item.name}
            </Text>
            <Text> </Text>
            <Text color={theme.background.message} dimColor={!isSelected}>
              Plugin
            </Text>
            <Text dimColor> · </Text>
            <Text color={pendingColor} dimColor={!isSelected}>
              {pendingIcon}
            </Text>
            <Text color={pendingColor} dimColor={!isSelected}>
              {' '}
              {pendingStatusText}
            </Text>
          </Box>
        );
      }

      default:
        return null;
    }
  }, [
    item,
    isSelected,
    pointer,
    nameColor,
    providedScopeLabel,
    shadowedByLabel,
  ]);

  return rendered;
};
