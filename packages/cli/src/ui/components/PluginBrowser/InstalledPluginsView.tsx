/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { BRAND_CLI_BIN } from '@qwen-code/core';
import { theme } from '../../semantic-colors.js';
import { InputFrame } from '../shared/InputFrame.js';
import { PluginComponentsDisplay } from './PluginComponentsDisplay.js';
import { UnifiedInstalledCell } from './UnifiedInstalledCell.js';
import type { InstalledPluginsController } from './useInstalledPluginsController.js';

interface DetailRowProps {
  label: string;
  value: string;
  isActive?: boolean;
  isAction?: boolean;
  isDanger?: boolean;
  disabled?: boolean;
}

const DetailRow = ({
  label,
  value,
  isActive,
  isAction,
  isDanger,
  disabled,
}: DetailRowProps): React.JSX.Element => {
  const labelColor = disabled
    ? theme.text.secondary
    : isActive
      ? theme.ui.focus
      : theme.text.primary;
  const valueColor = disabled
    ? theme.text.secondary
    : isAction
      ? isActive
        ? isDanger
          ? theme.status.error
          : theme.ui.focus
        : theme.text.secondary
      : isActive
        ? theme.ui.focus
        : theme.text.secondary;
  const prefix = isActive ? '❯ ' : '  ';
  return (
    <Box flexDirection="row">
      <Text color={labelColor}>{prefix}</Text>
      <Box width={18}>
        <Text color={labelColor} bold={isActive}>
          {label}
        </Text>
      </Box>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
};

export function InstalledPluginsView({
  controller,
}: {
  controller: InstalledPluginsController;
}): React.JSX.Element {
  const {
    selectableItems,
    viewMode,
    detailPlugin,
    detailItem,
    detailFields,
    detailFieldIndex,
    processing,
    statusMessage,
    isSearching,
    searchQuery,
    filteredItems,
    pagination,
    visibleItems,
    selectedIndex,
    scopeGroupBoundaries,
    presentation,
  } = controller;
  // --- Empty state ---
  if (selectableItems.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No plugins installed.</Text>
        <Text dimColor>
          Use &quot;{BRAND_CLI_BIN} plugins install &lt;path&gt; --scope
          user|project|local&quot; to install a local plugin.
        </Text>
      </Box>
    );
  }

  // --- Confirm Uninstall ---
  if (viewMode === 'confirm-uninstall' && detailPlugin) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.error} bold>
          Uninstall Plugin
        </Text>
        <Box marginTop={1}>
          <Text>
            Are you sure you want to uninstall{' '}
            <Text bold>{detailPlugin.displayName ?? detailPlugin.name}</Text>?
          </Text>
        </Box>
        {detailPlugin.mcpServers &&
          Object.keys(detailPlugin.mcpServers).length > 0 && (
            <Text dimColor>
              This will also remove{' '}
              {Object.keys(detailPlugin.mcpServers).length} MCP server(s).
            </Text>
          )}
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text color={theme.status.error}>y</Text>
          <Text dimColor> to confirm, </Text>
          <Text>n</Text>
          <Text dimColor> to cancel</Text>
        </Box>
        {processing && (
          <Box marginTop={1}>
            <Text color="cyan">Uninstalling...</Text>
          </Box>
        )}
      </Box>
    );
  }

  // --- Confirm Data Cleanup ---
  if (viewMode === 'confirm-data-cleanup' && detailPlugin) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.warning} bold>
          Delete Plugin Data?
        </Text>
        <Box marginTop={1}>
          <Text>
            Also delete stored configuration and options for{' '}
            <Text bold>{detailPlugin.displayName ?? detailPlugin.name}</Text>?
          </Text>
        </Box>
        <Text dimColor>
          This includes any API keys or settings you configured for this plugin.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text color={theme.status.warning}>y</Text>
          <Text dimColor> to delete data, </Text>
          <Text>n</Text>
          <Text dimColor> to keep data</Text>
        </Box>
        {processing && (
          <Box marginTop={1}>
            <Text color="cyan">Uninstalling...</Text>
          </Box>
        )}
      </Box>
    );
  }

  // --- Plugin Detail View ---
  if (viewMode === 'plugin-details' && detailPlugin) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            {detailPlugin.displayName ?? detailPlugin.name}
          </Text>
          {detailPlugin.manifest?.version && (
            <Text dimColor> v{detailPlugin.manifest.version}</Text>
          )}
        </Box>

        {detailFields.map((field, idx) => {
          const isActive = idx === detailFieldIndex;
          return (
            <DetailRow
              key={field.label}
              label={field.label}
              value={field.value}
              isActive={isActive}
              isAction={field.kind === 'action' || !!field.action}
              isDanger={field.action === 'uninstall'}
              disabled={field.disabled}
            />
          );
        })}

        <PluginComponentsDisplay plugin={detailPlugin} />

        {statusMessage && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{statusMessage}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>↑↓ navigate · Enter: select · Esc: back</Text>
        </Box>
      </Box>
    );
  }

  // --- Failed Plugin Detail View ---
  if (
    viewMode === 'failed-plugin-details' &&
    detailItem?.type === 'failed-plugin'
  ) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.error} bold>
          ✖ Failed Plugin: {detailItem.name}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <DetailRow
            label="Errors"
            value={`${detailItem.errorCount} error${detailItem.errorCount !== 1 ? 's' : ''}`}
            isActive={false}
          />
          <DetailRow
            label="Source"
            value={detailItem.marketplace || 'unknown'}
            isActive={false}
          />
        </Box>

        {detailItem.errors.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.text.primary} bold>
              Error Details:
            </Text>
            {detailItem.errors.slice(0, 5).map((err, idx) => (
              <Box key={idx} marginLeft={1}>
                <Text color={theme.status.error}>
                  •{' '}
                  {presentation.get(detailItem.id)?.errorMessages[idx] ??
                    'Plugin failed to load.'}
                </Text>
              </Box>
            ))}
            {detailItem.errors.length > 5 && (
              <Text dimColor>... and {detailItem.errors.length - 5} more</Text>
            )}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Esc: back</Text>
        </Box>
      </Box>
    );
  }

  // --- MCP Server Detail View ---
  if (viewMode === 'mcp-detail' && detailItem?.type === 'mcp-server') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan" bold>
          MCP Server: {detailItem.name}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <DetailRow
            label="Status"
            value={detailItem.status}
            isActive={false}
          />
          {detailItem.parentPlugin && (
            <DetailRow
              label="Parent Plugin"
              value={detailItem.parentPlugin}
              isActive={false}
            />
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc: back</Text>
        </Box>
      </Box>
    );
  }

  // --- Pending Plugin Detail View ---
  if (
    viewMode === 'pending-plugin-details' &&
    detailItem?.type === 'pending-plugin'
  ) {
    const scopeLabel =
      presentation.get(detailItem.id)?.scopeLabel ?? detailItem.scope;
    const statusText = detailItem.isEnabled ? '✓ Enabled' : '○ Disabled';
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            {detailItem.name}
          </Text>
          <Text dimColor> (not yet loaded)</Text>
        </Box>

        <DetailRow label="Status" value={statusText} isActive={false} />
        <DetailRow label="Scope" value={scopeLabel} isActive={false} />
        {presentation.get(detailItem.id)?.showPath !== false && (
          <DetailRow
            label="Path"
            value={detailItem.installPath}
            isActive={false}
          />
        )}

        {detailItem.shadowed && (
          <Box marginTop={1}>
            <Text color={theme.status.warning}>
              ⚠ This installation is shadowed by{' '}
              {presentation.get(detailItem.id)?.shadowedByLabel ??
                detailItem.shadowedBy}{' '}
              scope.
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            This plugin is installed but not yet loaded. Run /plugins reload to
            activate it.
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Esc: back</Text>
        </Box>
      </Box>
    );
  }

  // --- List View ---
  return (
    <Box flexDirection="column">
      {/* Search bar */}
      <Box marginBottom={1}>
        {isSearching ? (
          <InputFrame active>
            <Text color="cyan">Search: </Text>
            <Text>{searchQuery}</Text>
            <Text>█</Text>
          </InputFrame>
        ) : searchQuery ? (
          <Box>
            <Text dimColor>
              Filter: {searchQuery} ({filteredItems.length} result
              {filteredItems.length !== 1 ? 's' : ''})
            </Text>
          </Box>
        ) : null}
      </Box>

      {/* Item list */}
      <Box flexDirection="column" paddingX={1}>
        {filteredItems.length === 0 ? (
          <Text dimColor>No plugins match &apos;{searchQuery}&apos;.</Text>
        ) : (
          <>
            {/* Scroll-up indicator */}
            {pagination.scrollPosition.canScrollUp && (
              <Text dimColor> ↑ more above</Text>
            )}

            {visibleItems.map((item, visIdx) => {
              const actualIdx = pagination.toActualIndex(visIdx);
              const isSelected = actualIdx === selectedIndex;
              // Show scope group header if this is the start of a new group
              const groupHeader = !searchQuery
                ? scopeGroupBoundaries.get(actualIdx)
                : undefined;
              return (
                <Box key={item.id} flexDirection="column">
                  {groupHeader && (
                    <Box marginTop={visIdx > 0 ? 1 : 0} marginBottom={0}>
                      <Text color={theme.text.secondary} bold dimColor>
                        {groupHeader}
                      </Text>
                    </Box>
                  )}
                  <UnifiedInstalledCell
                    item={item}
                    isSelected={isSelected}
                    scopeLabel={presentation.get(item.id)?.scopeLabel}
                    shadowedByLabel={presentation.get(item.id)?.shadowedByLabel}
                  />
                </Box>
              );
            })}

            {/* Scroll-down indicator */}
            {pagination.scrollPosition.canScrollDown && (
              <Text dimColor> ↓ more below</Text>
            )}
          </>
        )}
      </Box>

      {/* Status message */}
      {statusMessage && (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.text.secondary}>{statusMessage}</Text>
        </Box>
      )}

      {/* Position indicator */}
      {pagination.needsPagination && (
        <Box paddingX={1}>
          <Text dimColor>
            {pagination.scrollPosition.current}/
            {pagination.scrollPosition.total}
          </Text>
        </Box>
      )}
    </Box>
  );
}
