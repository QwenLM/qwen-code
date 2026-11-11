/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { HookAttachment } from '@qwen-code/core';
import { HookEventName, truncateString } from '@qwen-code/core';
import type { HistoryItemCustomContent } from '../../types.js';

/**
 * Whether a hook event is a Stop-like event (Stop or SubagentStop).
 * Used to gate rendering (stop events go to summary) and accumulation.
 */
export function isStopHookEvent(hookEvent: string): boolean {
  return (
    hookEvent === HookEventName.Stop ||
    hookEvent === HookEventName.SubagentStop
  );
}

function udoFormat(stderr: string, stdout: string): string {
  const raw = stderr.trim() || stdout.trim();
  if (!raw) return '';
  const nl = raw.indexOf('\n');
  const firstBlock = nl === -1 ? raw : raw.substring(0, nl).trim();
  return truncateString(firstBlock, 200, '\u2026');
}

/**
 * Convert a HookAttachment into a custom_content HistoryItem.
 *
 * Returns null when the attachment should not be rendered (Stop events
 * routed to the summary, hook_success, hook_cancelled).
 */
export function buildHookAttachmentHistoryItem(
  att: HookAttachment,
): HistoryItemCustomContent | null {
  const isStop = isStopHookEvent(att.hookEvent);

  if (
    isStop &&
    (att.type === 'hook_non_blocking_error' ||
      att.type === 'hook_error_during_execution' ||
      att.type === 'hook_blocking_error' ||
      att.type === 'hook_stopped_continuation')
  ) {
    return null;
  }

  if (att.type === 'hook_non_blocking_error') {
    const body = udoFormat(att.stderr, att.stdout);
    return wrap([
      <Text key="title" color={theme.status.error} dimColor>
        {att.hookName} hook error
      </Text>,
      body ? (
        <Text key="body" color={theme.status.error} dimColor>
          {body}
        </Text>
      ) : null,
    ]);
  }

  if (att.type === 'hook_error_during_execution') {
    return wrap(<Text dimColor>{att.hookName} hook warning</Text>);
  }

  if (att.type === 'hook_blocking_error') {
    const stderr = att.blockingError.blockingError.trim();
    return wrap([
      <Text key="title" color={theme.status.error} dimColor>
        {att.hookName} hook returned blocking error
      </Text>,
      stderr ? (
        <Text key="body" color={theme.status.error} dimColor>
          {stderr}
        </Text>
      ) : null,
    ]);
  }

  if (att.type === 'hook_stopped_continuation') {
    return wrap(
      <Text color={theme.status.warning} dimColor>
        {att.hookName} hook stopped continuation: {att.message}
      </Text>,
    );
  }

  if (att.type === 'hook_system_message') {
    return wrap(
      <Text dimColor>
        {att.hookName} says: {att.content}
      </Text>,
    );
  }

  if (att.type === 'hook_permission_decision') {
    const action = att.decision === 'allow' ? 'Allowed' : 'Denied';
    return wrap(
      <Text dimColor>
        {action} by{' '}
        <Text bold dimColor>
          {att.hookEvent}
        </Text>{' '}
        hook
      </Text>,
    );
  }

  return null;
}

/**
 * Wrap one or more lines with per-line dim `⎿  ` connectors, matching CC's
 * `xP` component which is invoked per text block. Falsy entries (e.g. empty
 * body line) are skipped so the connector count tracks visible lines.
 */
function wrap(
  lines: React.ReactNode | Array<React.ReactNode | null | false>,
): HistoryItemCustomContent {
  const arr = Array.isArray(lines) ? lines : [lines];
  return {
    type: 'custom_content',
    content: (
      <Box flexDirection="column">
        {arr.map((line, i) =>
          line ? (
            <Box key={i} flexDirection="row">
              <Text dimColor>{'⎿  '}</Text>
              <Box flexShrink={1}>{line}</Box>
            </Box>
          ) : null,
        )}
      </Box>
    ),
  };
}
