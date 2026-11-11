/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { AnyDeclarativeTool } from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { Colors } from '../colors.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import {
  useRegisterActionHandlers,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

export interface McpToolListViewProps {
  serverName: string;
  tools: AnyDeclarativeTool[];
  onSelectTool: (tool: AnyDeclarativeTool) => void;
  onBack: () => void;
  isActive: boolean;
}

interface McpToolLike {
  name: string;
  serverToolName?: unknown;
  isReadOnly?: unknown;
  toolAnnotations?: unknown;
}

function getToolShortName(tool: AnyDeclarativeTool): string {
  const t = tool as McpToolLike;
  if (typeof t.serverToolName === 'string' && t.serverToolName) {
    return t.serverToolName;
  }
  return tool.name;
}

function getToolAnnotations(tool: AnyDeclarativeTool): string[] {
  const annotations: string[] = [];
  const t = tool as McpToolLike;
  const isReadOnly = t.isReadOnly === true;
  const ta =
    t.toolAnnotations && typeof t.toolAnnotations === 'object'
      ? (t.toolAnnotations as Record<string, unknown>)
      : undefined;
  const isDestructive = ta?.['destructiveHint'] === true;
  const isOpenWorld = ta?.['openWorldHint'] === true;
  if (isReadOnly) annotations.push('read-only');
  if (isDestructive) annotations.push('destructive');
  if (isOpenWorld) annotations.push('open-world');
  return annotations;
}

export function McpToolListView({
  serverName,
  tools,
  onSelectTool,
  onBack,
  isActive,
}: McpToolListViewProps): React.JSX.Element {
  const items: Array<RadioSelectItem<number>> = useMemo(
    () =>
      tools.map((tool, index) => {
        const name = getToolShortName(tool);
        const annotations = getToolAnnotations(tool);
        return {
          label: name,
          sublabel: annotations.length > 0 ? annotations.join(', ') : undefined,
          value: index,
          key: `${tool.name}-${index}`,
        };
      }),
    [tools],
  );

  const escapeHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'dialog:escape': () => {
        onBack();
        return true;
      },
    }),
    [onBack],
  );

  useRegisterActionHandlers('Dialog', escapeHandlers, isActive);

  const title = `MCP > ${serverName} > Tools`;
  const count = tools.length;
  const subtitle = `${count} ${count === 1 ? 'tool' : 'tools'}`;

  if (tools.length === 0) {
    return (
      <BaseTabDialog title={title} isActive={isActive}>
        <Text color={Colors.Gray}>
          No tools available. The server may be disconnected or expose no tools.
        </Text>
      </BaseTabDialog>
    );
  }

  return (
    <BaseTabDialog
      title={title}
      isActive={isActive}
      extraHints={[
        { label: SHORTCUT_HINTS.GO_BACK, order: 10 },
        { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
        { label: SHORTCUT_HINTS.SELECT, order: 30 },
      ]}
    >
      <Box marginBottom={1}>
        <Text color={theme.text.secondary}>{subtitle}</Text>
      </Box>
      <RadioButtonSelect
        items={items}
        isFocused={isActive}
        maxItemsToShow={10}
        showNumbers={false}
        onSelect={(index) => {
          const tool = tools[index];
          if (tool) {
            onSelectTool(tool);
          }
        }}
      />
    </BaseTabDialog>
  );
}
