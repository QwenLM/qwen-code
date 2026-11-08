/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Text } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { ICON } from '../constants.js';
import { theme } from '../semantic-colors.js';

const POLL_INTERVAL_MS = 1000;

function getScheduledTaskCount(config: Config | undefined): number {
  if (!config?.isCronEnabled?.()) return 0;
  return config.getCronScheduler?.()?.size ?? 0;
}

function useScheduledTaskCount(config: Config | undefined): number {
  const [count, setCount] = useState(() => getScheduledTaskCount(config));

  useEffect(() => {
    const id = setInterval(() => {
      setCount(getScheduledTaskCount(config));
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [config]);

  return count;
}

export function useFooterCronTaskCount(): number {
  return useScheduledTaskCount(useConfig());
}

type CronPillProps = {
  count: number;
};

export const CronPill: React.FC<CronPillProps> = ({ count }) => {
  if (count <= 0) return null;

  const noun = count === 1 ? 'scheduled task' : 'scheduled tasks';
  return (
    <Text color={theme.text.accent}>
      {ICON.BULLSEYE} {count} {noun}
    </Text>
  );
};
