/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { CronResult } from '@qwen-code/core';
import { theme } from '../../semantic-colors.js';

/** Max prompt length in full-width display (create result). */
const PROMPT_MAX_FULL = 80;
/** Max prompt length in compact list display. */
const PROMPT_MAX_LIST = 60;

interface CronResultDisplayProps {
  result: CronResult;
}

function CronCreateDisplay({
  result,
}: {
  result: Extract<CronResult, { cronResultType: 'create' }>;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.status.success}>✓ Scheduled cron job</Text>
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.text.secondary}>ID: </Text>
          <Text color={theme.text.primary} bold>
            {result.id}
          </Text>
        </Text>
        <Text>
          <Text color={theme.text.secondary}>Schedule: </Text>
          <Text color={theme.text.primary}>
            {result.humanSchedule}
          </Text>
          <Text color={theme.text.secondary}> ({result.cron})</Text>
        </Text>
        <Text>
          <Text color={theme.text.secondary}>Prompt: </Text>
          <Text color={theme.text.primary}>
            {result.prompt.length > PROMPT_MAX_FULL
              ? result.prompt.slice(0, PROMPT_MAX_FULL - 3) + '...'
              : result.prompt}
          </Text>
        </Text>
        <Text>
          <Text color={theme.text.secondary}>Type: </Text>
          <Text color={theme.text.primary}>
            {result.recurring ? 'Recurring' : 'One-shot'}
          </Text>
          <Text color={theme.text.secondary}>
            {result.durable ? '' : ' [session-only]'}
          </Text>
        </Text>
      </Box>
    </Box>
  );
}

function CronDeleteDisplay({
  result,
}: {
  result: Extract<CronResult, { cronResultType: 'delete' }>;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.status.success}>
        ✓ Cancelled job{' '}
        <Text bold>{result.id}</Text>
      </Text>
    </Box>
  );
}

/**
 * Display a list of scheduled cron jobs with human-readable schedules.
 * Shows "No scheduled jobs" when the list is empty.
 */
function CronListDisplay({
  result,
}: {
  result: Extract<CronResult, { cronResultType: 'list' }>;
}): React.ReactElement {
  if (result.jobs.length === 0) {
    return (
      <Text color={theme.text.secondary} italic>
        No scheduled jobs.
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.text.primary}>
        {result.jobs.length} scheduled{' '}
        {result.jobs.length === 1 ? 'job' : 'jobs'}:
      </Text>
      <Box flexDirection="column" paddingTop={1}>
        {result.jobs.map((job) => (
          <Box key={job.id} flexDirection="row">
            <Text>
              <Text color={theme.text.accent} bold>
                {job.id}
              </Text>
              <Text color={theme.text.secondary}> — </Text>
              <Text color={theme.text.primary}>{job.humanSchedule}</Text>
              <Text color={theme.text.secondary}>
                {job.recurring ? ' (recurring)' : ' (one-shot)'}
              </Text>
              {!job.durable && (
                <Text color={theme.status.warning}> [session-only]</Text>
              )}
              <Text color={theme.text.secondary}>: </Text>
              <Text color={theme.text.primary}>
                {job.prompt.length > PROMPT_MAX_LIST
                  ? job.prompt.slice(0, PROMPT_MAX_LIST - 3) + '...'
                  : job.prompt}
              </Text>
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/**
 * Render cron operation results (create, delete, list) with appropriate UI.
 * Dispatches to specialized display components based on result type.
 * Returns null for unknown result types.
 */
export const CronResultDisplay: React.FC<CronResultDisplayProps> = ({
  result,
}) => {
  switch (result.cronResultType) {
    case 'create':
      return <CronCreateDisplay result={result} />;
    case 'delete':
      return <CronDeleteDisplay result={result} />;
    case 'list':
      return <CronListDisplay result={result} />;
    default:
      return null;
  }
};
