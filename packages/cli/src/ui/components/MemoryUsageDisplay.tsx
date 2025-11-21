/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import process from 'node:process';
import { formatMemoryUsage } from '../utils/formatters.js';

// Increase the update interval to reduce overhead
const MEMORY_UPDATE_INTERVAL = 10000; // 10 seconds instead of 2 seconds
const HIGH_MEMORY_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2GB

export const MemoryUsageDisplay: React.FC = () => {
  const [memoryUsage, setMemoryUsage] = useState<string>('');
  const [memoryUsageColor, setMemoryUsageColor] = useState<string>(
    theme.text.secondary,
  );

  const updateMemory = useCallback(() => {
    const usage = process.memoryUsage().rss;
    const formattedUsage = formatMemoryUsage(usage);

    // Only update state if the value actually changed to prevent unnecessary re-renders
    setMemoryUsage((prev) => {
      if (prev !== formattedUsage) {
        return formattedUsage;
      }
      return prev;
    });

    // Update color based on memory usage
    const newColor =
      usage >= HIGH_MEMORY_THRESHOLD
        ? theme.status.error
        : theme.text.secondary;

    setMemoryUsageColor((prev) => {
      if (prev !== newColor) {
        return newColor;
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    // Initial update
    updateMemory();

    // Set up update interval
    const intervalId = setInterval(updateMemory, MEMORY_UPDATE_INTERVAL);

    return () => clearInterval(intervalId);
  }, [updateMemory]);

  // Only render if we have memory usage to show
  if (!memoryUsage) {
    return null;
  }

  return (
    <Box>
      <Text color={theme.text.secondary}> | </Text>
      <Text color={memoryUsageColor}>{memoryUsage}</Text>
    </Box>
  );
};
