/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Stop icon for canceling operations
 */

import type React from 'react';
import type { IconProps } from './types.js';

/**
 * Stop/square icon (16x16)
 * Used for stop/cancel operations
 */
export const StopIcon: React.FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </svg>
);
