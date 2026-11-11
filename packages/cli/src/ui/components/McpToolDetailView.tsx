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
  useRegisterActionHandlers,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

export interface McpToolDetailViewProps {
  serverName: string;
  tool: AnyDeclarativeTool;
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

interface ParamInfo {
  key: string;
  type: string;
  description?: string;
  required: boolean;
}

function isString(v: unknown): v is string {
  return Object.prototype.toString.call(v) === '[object String]';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && Object.prototype.toString.call(v) === '[object Object]';
}

function extractParams(schema: unknown): ParamInfo[] {
  if (!isPlainObject(schema)) return [];
  const properties = schema['properties'];
  if (!isPlainObject(properties)) return [];
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as string[])
    : [];
  return Object.entries(properties).map(([key, value]) => {
    let typeStr = 'unknown';
    let description: string | undefined;
    if (isPlainObject(value)) {
      const rawType = value['type'];
      if (isString(rawType)) {
        typeStr = rawType;
      } else if (Array.isArray(rawType)) {
        typeStr = (rawType as unknown[]).join(' | ');
      }
      const rawDesc = value['description'];
      if (isString(rawDesc)) {
        description = rawDesc;
      }
    }
    return {
      key,
      type: typeStr,
      description,
      required: required.includes(key),
    };
  });
}

export function McpToolDetailView({
  serverName,
  tool,
  onBack,
  isActive,
}: McpToolDetailViewProps): React.JSX.Element {
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

  const shortName = getToolShortName(tool);
  const fullName = tool.name;
  const displayName = tool.displayName || shortName;

  const t = tool as McpToolLike;
  const isReadOnly = t.isReadOnly === true;
  const ta =
    t.toolAnnotations && typeof t.toolAnnotations === 'object'
      ? (t.toolAnnotations as Record<string, unknown>)
      : undefined;
  const isDestructive = ta?.['destructiveHint'] === true;
  const isOpenWorld = ta?.['openWorldHint'] === true;

  const params = useMemo(
    () => extractParams(tool.parameterSchema),
    [tool.parameterSchema],
  );

  const title = `MCP > ${serverName} > ${shortName}`;

  return (
    <BaseTabDialog
      title={title}
      isActive={isActive}
      extraHints={[{ label: SHORTCUT_HINTS.GO_BACK, order: 10 }]}
    >
      <Box flexDirection="column">
        <Box>
          <Text bold>{displayName}</Text>
          {isReadOnly && <Text color={theme.status.success}> [read-only]</Text>}
          {isDestructive && (
            <Text color={theme.status.error}> [destructive]</Text>
          )}
          {isOpenWorld && <Text color={Colors.Gray}> [open-world]</Text>}
        </Box>

        <Box marginTop={1}>
          <Box width={14}>
            <Text bold>Tool name:</Text>
          </Box>
          <Text color={theme.text.secondary}>{shortName}</Text>
        </Box>

        <Box>
          <Box width={14}>
            <Text bold>Full name:</Text>
          </Box>
          <Text color={theme.text.secondary}>{fullName}</Text>
        </Box>

        {tool.description ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Description:</Text>
            <Text color={theme.text.secondary} wrap="wrap">
              {tool.description.trim()}
            </Text>
          </Box>
        ) : null}

        {params.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Parameters:</Text>
            <Box flexDirection="column" marginLeft={2}>
              {params.map((p) => (
                <Box key={p.key} flexDirection="column">
                  <Text>
                    • <Text color={theme.text.primary}>{p.key}</Text>
                    {p.required ? (
                      <Text color={Colors.Gray}> (required)</Text>
                    ) : null}
                    : <Text color={theme.text.secondary}>{p.type}</Text>
                  </Text>
                  {p.description ? (
                    <Box marginLeft={2}>
                      <Text color={theme.text.secondary} wrap="wrap">
                        {p.description}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              ))}
            </Box>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color={Colors.Gray}>No parameters.</Text>
          </Box>
        )}
      </Box>
    </BaseTabDialog>
  );
}
