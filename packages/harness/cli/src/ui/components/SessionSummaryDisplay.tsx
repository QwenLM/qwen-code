/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { StatsDisplay } from './StatsDisplay.js';
import { useSessionSummaryProps } from '../hooks/useSessionSummaryProps.js';

export const SessionSummaryDisplay: React.FC<{ duration: string }> = ({
  duration,
}) => <StatsDisplay {...useSessionSummaryProps(duration)} />;
