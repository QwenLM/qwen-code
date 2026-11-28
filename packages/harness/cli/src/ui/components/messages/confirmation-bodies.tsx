/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Body rendering functions for each confirmation type.
 *
 * Each function returns `{ question, body }` which the main
 * ToolConfirmationMessage component consumes uniformly.
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { DiffRenderer } from './DiffRenderer.js';
import { RenderInline } from '../../utils/InlineMarkdownRenderer.js';
import {
  type SerializableConfirmationDetails,
  type Config,
  hasRedirection,
} from '@qwen-code/core';
import {
  sanitizeForDisplay,
  stripUnsafeCharacters,
} from '../../utils/textUtils.js';
import { theme } from '../../semantic-colors.js';
import { colorizeCode } from '../../utils/CodeColorizer.js';
import { getBorderStyle } from '../../utils/borderStyles.js';
import { toUnicodeUrl } from '../../utils/urlSecurityUtils.js';
import type { LoadedSettings } from '../../../config/settings.js';
import type { Theme } from '../../themes/theme.js';

export interface BodyRenderResult {
  question: React.ReactNode;
  body: React.ReactNode;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Border box steals 2 lines (top+bottom); cap at minimum 2 visible lines. */
function contentHeight(bh: number | undefined): number | undefined {
  return bh !== undefined ? Math.max(bh - 2, 2) : undefined;
}

/** Inner width after subtracting border + padding. */
function innerWidth(tw: number, padding: number): number {
  return Math.max(tw, 1) - padding;
}

/**
 * Returns the commands list to display in exec confirmations.
 * Uses the full `commands` array when it contains multiple entries,
 * falls back to a single-element array of `command` otherwise.
 */
function getExecCommandsToDisplay(
  details: Extract<SerializableConfirmationDetails, { type: 'exec' }>,
): string[] {
  return details.commands && details.commands.length > 1
    ? details.commands
    : [details.command];
}

// ─── Edit ────────────────────────────────────────────────────────────────────

export function renderEditBody(
  details: Extract<SerializableConfirmationDetails, { type: 'edit' }>,
  terminalWidth: number,
): BodyRenderResult {
  return {
    question: 'Apply this change?',
    body: (
      <Box
        borderStyle={getBorderStyle('dialog')}
        borderColor={theme.border.default}
        paddingX={1}
        paddingY={0}
        marginBottom={0}
      >
        <DiffRenderer
          diffContent={stripUnsafeCharacters(details.fileDiff)}
          filePath={sanitizeForDisplay(details.displayPath ?? details.fileName)}
          terminalWidth={innerWidth(terminalWidth, 4)}
        />
      </Box>
    ),
  };
}

export function renderExecBody(
  details: Extract<SerializableConfirmationDetails, { type: 'exec' }>,
  toolName: string,
  config: Config,
): BodyRenderResult {
  const commandsToDisplay = getExecCommandsToDisplay(details);
  const containsRedirection = commandsToDisplay.some((cmd) =>
    hasRedirection(cmd),
  );
  const isAutoEdit =
    config.getPermissionMode() === 'yolo' ||
    config.getPermissionMode() === 'acceptEdits';

  const question = (
    <Box flexDirection="column">
      <Text>
        Allow this command to run?
        {containsRedirection && !isAutoEdit && (
          <>
            {' '}
            <Text color={theme.status.warning}>Redirection detected.</Text>
          </>
        )}
      </Text>
    </Box>
  );

  return { question, body: null };
}

// ─── Info ────────────────────────────────────────────────────────────────────

export function renderInfoBody(
  details: Extract<SerializableConfirmationDetails, { type: 'info' }>,
): BodyRenderResult {
  // Auto-mode circuit breaker: surface the breaker notice (consecutive-block
  // warning + latest blocked action) so the user sees why they are asked.
  if (details.kind === 'auto_mode_breaker') {
    return {
      question: 'Do you want to proceed?',
      body: (
        <Box flexDirection="column">
          {details.prompt.split('\n').map((line, i) => (
            <Text key={i} color={theme.text.primary}>
              {line}
            </Text>
          ))}
        </Box>
      ),
    };
  }

  const displayUrls =
    details.urls &&
    !(details.urls.length === 1 && details.urls[0] === details.prompt);

  return {
    question: 'Do you want to proceed?',
    body:
      displayUrls && details.urls && details.urls.length > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.text.primary}>URLs to fetch:</Text>
          {details.urls.map((urlString) => (
            <Text key={urlString}>
              {' '}
              - <RenderInline text={toUnicodeUrl(urlString)} />
            </Text>
          ))}
        </Box>
      ) : null,
  };
}

// ─── File Read ──────────────────────────────────────────────────────────────

export function renderFileReadBody(
  _details: Extract<SerializableConfirmationDetails, { type: 'file_read' }>,
): BodyRenderResult {
  return {
    question: 'Allow reading this file?',
    body: null,
  };
}

// ─── Workflow ───────────────────────────────────────────────────────────────

function formatWorkflowArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function formatWorkflowInputSchema(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  const parts: string[] = [];
  const required = Array.isArray(record['required'])
    ? record['required'].filter((item): item is string => typeof item === 'string')
    : [];
  if (required.length > 0) {
    parts.push(`required: ${required.join(', ')}`);
  }
  const properties = record['properties'];
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const propertySummary = Object.entries(
      properties as Record<string, unknown>,
    )
      .slice(0, 8)
      .map(([name, value]) => {
        const type =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)['type']
            : undefined;
        return typeof type === 'string' ? `${name}:${type}` : name;
      });
    if (propertySummary.length > 0) {
      const total = Object.keys(properties).length;
      parts.push(
        `properties: ${propertySummary.join(', ')}${
          total > propertySummary.length ? `, +${total - propertySummary.length} more` : ''
        }`,
      );
    }
  }
  if (parts.length > 0) return parts.join('; ');
  const type = record['type'];
  return typeof type === 'string' ? `type: ${type}` : undefined;
}

function workflowScriptBodyHeight(
  details: Extract<SerializableConfirmationDetails, { type: 'workflow' }>,
  argsText: string | undefined,
  inputSchemaText: string | undefined,
  bodyHeight: number | undefined,
): number | undefined {
  if (bodyHeight === undefined) return undefined;
  const metadataLines =
    (details.workflowName ? 1 : 0) +
    (details.description ? 1 : 0) +
    (details.scriptPath ? 1 : 0) +
    (inputSchemaText ? Math.max(1, inputSchemaText.split('\n').length) : 0) +
    (argsText ? Math.max(1, argsText.split('\n').length) : 0);
  const metadataMargin = metadataLines > 0 ? 1 : 0;
  const phaseLines = details.meta?.phases?.length
    ? 1 + details.meta.phases.length
    : 0;
  const phaseMargin = phaseLines > 0 ? 1 : 0;
  return Math.max(
    bodyHeight - metadataLines - metadataMargin - phaseLines - phaseMargin,
    4,
  );
}

export function renderWorkflowBody(
  details: Extract<SerializableConfirmationDetails, { type: 'workflow' }>,
  terminalWidth: number,
  bodyHeight: number | undefined,
  settings: LoadedSettings,
  activeTheme: Theme | null,
  showRawScript = false,
  scriptOverride?: string,
): BodyRenderResult {
  const argsText = formatWorkflowArgs(details.args);
  const inputSchemaText = formatWorkflowInputSchema(details.meta?.inputSchema);
  const phases = details.meta?.phases ?? [];
  const script = scriptOverride ?? details.script ?? '';
  const scriptBodyHeight = workflowScriptBodyHeight(
    details,
    argsText,
    inputSchemaText,
    bodyHeight,
  );

  return {
    question: (
      <Text color={theme.status.warning}>
        Dynamic workflows can run multiple subagents in the background and may
        consume tokens quickly. Allow this workflow to run?
      </Text>
    ),
    body: (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          {details.workflowName && (
            <Text>
              <Text color={theme.text.secondary}>Name: </Text>
              {sanitizeForDisplay(details.workflowName)}
            </Text>
          )}
          {details.description && (
            <Text>
              <Text color={theme.text.secondary}>Description: </Text>
              {sanitizeForDisplay(details.description)}
            </Text>
          )}
          {details.scriptPath && (
            <Text>
              <Text color={theme.text.secondary}>Script: </Text>
              {sanitizeForDisplay(details.scriptPath)}
            </Text>
          )}
          {argsText && (
            <Text>
              <Text color={theme.text.secondary}>Args: </Text>
              {sanitizeForDisplay(argsText)}
            </Text>
          )}
          {inputSchemaText && (
            <Text>
              <Text color={theme.text.secondary}>Input schema: </Text>
              {sanitizeForDisplay(inputSchemaText)}
            </Text>
          )}
        </Box>
        {phases.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={theme.text.secondary}>Phases:</Text>
            {phases.map((phase, index) => (
              <Text key={`${phase.title}-${index}`}>
                {' '}
                {index + 1}. {sanitizeForDisplay(phase.title)}
                {phase.detail ? (
                  <Text color={theme.text.secondary}>
                    {' '}
                    - {sanitizeForDisplay(phase.detail)}
                  </Text>
                ) : null}
              </Text>
            ))}
          </Box>
        )}
        {showRawScript && script ? (
          <Box
            borderStyle={getBorderStyle('dialog')}
            borderColor={theme.border.default}
            paddingX={1}
            paddingY={0}
            marginBottom={0}
          >
            {colorizeCode({
              code: stripUnsafeCharacters(script),
              language: 'javascript',
              maxWidth: innerWidth(terminalWidth, 4),
              settings,
              theme: activeTheme,
              hideLineNumbers: true,
              availableHeight: contentHeight(scriptBodyHeight),
            })}
          </Box>
        ) : showRawScript ? (
          <Text color={theme.status.warning}>
            Script content is not available in this confirmation view.
          </Text>
        ) : null}
      </Box>
    ),
  };
}

// ─── Repeated Tool Call ─────────────────────────────────────────────────────

export function renderRepeatedToolCallBody(
  details: Extract<
    SerializableConfirmationDetails,
    { type: 'repeated_tool_call' }
  >,
): BodyRenderResult {
  return {
    question: `Continue repeated ${sanitizeForDisplay(details.toolName)} call?`,
    body: (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          Same tool and input repeated {details.repeatCount} times.
        </Text>
        <Text color={theme.text.secondary}>
          Input: {sanitizeForDisplay(details.inputPreview)}
        </Text>
      </Box>
    ),
  };
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

export function renderMcpBody(
  details: Extract<SerializableConfirmationDetails, { type: 'mcp' }>,
  terminalWidth: number,
  bodyHeight: number | undefined,
  isMcpToolDetailsExpanded: boolean,
  mcpToolDetailsText: string | null,
  expandDetailsHintKey: string,
  settings: LoadedSettings,
  activeTheme: Theme | null,
): BodyRenderResult {
  const question = `Allow execution of MCP tool "${sanitizeForDisplay(details.toolName)}" from server "${sanitizeForDisplay(details.serverName)}"?`;

  const body = (
    <Box flexDirection="column">
      {details.toolArgs !== undefined &&
        typeof details.toolArgs === 'object' &&
        details.toolArgs !== null &&
        Object.keys(details.toolArgs).length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.text.secondary} bold>
              Arguments:
            </Text>
            {Object.entries(details.toolArgs).map(([k, v]) => (
              <Text key={k}>
                <Text color={theme.text.secondary}> {k}: </Text>
                <Text color={theme.text.primary}>
                  {typeof v === 'string'
                    ? sanitizeForDisplay(v)
                    : stripUnsafeCharacters(JSON.stringify(v))}
                </Text>
              </Text>
            ))}
          </Box>
        )}
      {mcpToolDetailsText && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.primary}>MCP Tool Details:</Text>
          {isMcpToolDetailsExpanded ? (
            <>
              <Text color={theme.text.secondary}>
                (press {expandDetailsHintKey} to collapse MCP tool details)
              </Text>
              <Box
                borderStyle={getBorderStyle('dialog')}
                borderColor={theme.border.default}
                paddingX={1}
                paddingY={0}
                marginBottom={0}
              >
                {colorizeCode({
                  code: mcpToolDetailsText || '',
                  language: 'json',
                  maxWidth: innerWidth(terminalWidth, 4),
                  settings,
                  theme: activeTheme,
                  hideLineNumbers: true,
                  availableHeight: contentHeight(bodyHeight),
                })}
              </Box>
            </>
          ) : (
            <Text color={theme.text.secondary}>
              (press {expandDetailsHintKey} to expand MCP tool details)
            </Text>
          )}
        </Box>
      )}
    </Box>
  );

  return { question, body };
}

// ─── Video ──────────────────────────────────────────────────────────────────

export function renderVideoBody(
  details: Extract<SerializableConfirmationDetails, { type: 'video' }>,
): BodyRenderResult {
  const specLines = [
    `Mode: ${details.mode}`,
    `Size: ${details.size ?? 'adaptive (server default)'}`,
    details.durationSeconds !== undefined
      ? `Duration: ${details.durationSeconds}s`
      : undefined,
    details.image ? `Image: ${details.image}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return {
    question:
      'Generate this video? Generation is slow and may incur usage costs; once submitted it cannot be cancelled.',
    body: (
      <Box flexDirection="column">
        {details.prompt
          .split('\n')
          .map((line, i) => (
            <Text key={i} color={theme.text.primary}>
              {line}
            </Text>
          ))}
        <Text> </Text>
        {specLines.map((line, i) => (
          <Text key={i} color={theme.text.secondary}>
            {line}
          </Text>
        ))}
      </Box>
    ),
  };
}

// ─── Height helper ───────────────────────────────────────────────────────────

/**
 * Returns the number of extra info lines a confirmation type adds
 * outside the scrollable body (e.g. permission details,
 * redirection warning for exec). The main component subtracts this
 * from the available height to size the body correctly.
 */
export function getExtraInfoLines(
  details: SerializableConfirmationDetails,
  _config: Config,
): number {

  if (details.type === 'exec') {
    return 0;
  }

  return 0;
}
