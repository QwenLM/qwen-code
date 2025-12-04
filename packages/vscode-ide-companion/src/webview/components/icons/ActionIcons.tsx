/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Playback and session control icons
 */

import type React from 'react';
import type { IconProps } from './types.js';

/**
 * Play/resume icon (16x16)
 * Used for resume session
 */
export const PlayIcon: React.FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M5.33337 4L10.6667 8L5.33337 12" />
  </svg>
);

/**
 * Switch/arrow right icon (16x16)
 * Used for switch session
 */
export const SwitchIcon: React.FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M10.6666 4L13.3333 6.66667L10.6666 9.33333" />
    <path d="M2.66663 6.66667H13.3333" />
  </svg>
);
