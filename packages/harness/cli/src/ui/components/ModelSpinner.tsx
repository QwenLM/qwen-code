/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect, useMemo } from 'react';
import { Text, useIsScreenReaderEnabled } from 'ink';
import { CliSpinner } from './CliSpinner.js';
import type { SpinnerName } from 'cli-spinners';
import { themeManager } from '../themes/theme-manager.js';
import { useThemeRevision } from '../hooks/useThemeRevision.js';
import tinygradient from 'tinygradient';

const COLOR_CYCLE_DURATION_MS = 4000;

interface ModelSpinnerProps {
  spinnerType?: SpinnerName;
  altText?: string;
}

export const ModelSpinner: React.FC<ModelSpinnerProps> = ({
  spinnerType = 'dots',
  altText,
}) => {
  useThemeRevision();
  const colors = themeManager.getColors();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const [time, setTime] = useState(0);

  const googleGradient = useMemo(() => {
    if (colors.type === 'ansi') return undefined;
    const brandColors = [
      colors.AccentPurple,
      colors.AccentBlue,
      colors.AccentCyan,
      colors.AccentGreen,
      colors.AccentYellow,
      colors.AccentRed,
    ];
    return tinygradient([...brandColors, brandColors[0]]);
  }, [colors]);

  useEffect(() => {
    if (isScreenReaderEnabled || !googleGradient) {
      return;
    }

    const interval = setInterval(() => {
      setTime((prevTime) => prevTime + 30);
    }, 30); // ~33fps for smooth color transitions

    return () => clearInterval(interval);
  }, [isScreenReaderEnabled, googleGradient]);

  const progress = (time % COLOR_CYCLE_DURATION_MS) / COLOR_CYCLE_DURATION_MS;
  const currentColor =
    googleGradient?.rgbAt(progress).toHexString() ?? colors.AccentPurple;

  return isScreenReaderEnabled ? (
    <Text>{altText}</Text>
  ) : (
    <Text color={currentColor}>
      <CliSpinner type={spinnerType} />
    </Text>
  );
};
