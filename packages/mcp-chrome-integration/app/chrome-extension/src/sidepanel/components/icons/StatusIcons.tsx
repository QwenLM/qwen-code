/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Status and state related icons
 */

import type React from 'react';
import type { IconProps } from './types.js';

/**
 * Plan completed icon (14x14)
 * Used for completed plan items
 */
export const PlanCompletedIcon: React.FC<IconProps> = ({
  size = 14,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 14 14"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <circle cx="7" cy="7" r="6" fill="currentColor" opacity="0.2" />
    <path
      d="M4 7.5L6 9.5L10 4.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Plan in progress icon (14x14)
 * Used for in-progress plan items
 */
export const PlanInProgressIcon: React.FC<IconProps> = ({
  size = 14,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 14 14"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <circle
      cx="7"
      cy="7"
      r="5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    />
  </svg>
);

/**
 * Plan pending icon (14x14)
 * Used for pending plan items
 */
export const PlanPendingIcon: React.FC<IconProps> = ({
  size = 14,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 14 14"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <circle
      cx="7"
      cy="7"
      r="5.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    />
  </svg>
);

/**
 * Warning triangle icon (20x20)
 * Used for warning messages
 */
export const WarningTriangleIcon: React.FC<IconProps> = ({
  size = 20,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * User profile icon (16x16)
 * Used for login command
 */
export const UserIcon: React.FC<IconProps> = ({
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
    <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12.735 14c.618 0 1.093-.561.872-1.139a6.002 6.002 0 0 0-11.215 0c-.22.578.254 1.139.872 1.139h9.47Z" />
  </svg>
);

export const SymbolIcon: React.FC<IconProps> = ({
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
    <path d="M8 1a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 7.293V1.5A.5.5 0 0 1 8 1Z" />
  </svg>
);

export const SelectionIcon: React.FC<IconProps> = ({
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
    <path d="M2 3.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5Zm0 4a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5Zm0 4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5Z" />
  </svg>
);
