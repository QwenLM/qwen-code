/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Navigation and action icons
 */

import type React from 'react';
import type { IconProps } from './types.js';

/**
 * Chevron down icon (20x20)
 * Used for dropdown arrows
 */
export const ChevronDownIcon: React.FC<IconProps> = ({
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
      d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * Plus icon (20x20)
 * Used for new session button
 */
export const PlusIcon: React.FC<IconProps> = ({
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
    <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
  </svg>
);

/**
 * Small plus icon (16x16)
 * Used for default attachment type
 */
export const PlusSmallIcon: React.FC<IconProps> = ({
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
    <path d="M8 2a.5.5 0 0 1 .5.5V5h2.5a.5.5 0 0 1 0 1H8.5v2.5a.5.5 0 0 1-1 0V6H5a.5.5 0 0 1 0-1h2.5V2.5A.5.5 0 0 1 8 2Z" />
  </svg>
);

/**
 * Arrow up icon (20x20)
 * Used for send message button
 */
export const ArrowUpIcon: React.FC<IconProps> = ({
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
      d="M10 17a.75.75 0 0 1-.75-.75V5.612L5.29 9.77a.75.75 0 0 1-1.08-1.04l5.25-5.5a.75.75 0 0 1 1.08 0l5.25 5.5a.75.75 0 1 1-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0 1 10 17Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * Close X icon (14x14)
 * Used for close buttons in banners and dialogs
 */
export const CloseIcon: React.FC<IconProps> = ({
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
    <path
      d="M1 1L13 13M1 13L13 1"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

export const CloseSmallIcon: React.FC<IconProps> = ({
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
    <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708Z" />
  </svg>
);

/**
 * Search/magnifying glass icon (20x20)
 * Used for search input
 */
export const SearchIcon: React.FC<IconProps> = ({
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
      d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * Refresh/reload icon (16x16)
 * Used for refresh session list
 */
export const RefreshIcon: React.FC<IconProps> = ({
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
    <path d="M13.3333 8C13.3333 10.9455 10.9455 13.3333 8 13.3333C5.05451 13.3333 2.66663 10.9455 2.66663 8C2.66663 5.05451 5.05451 2.66663 8 2.66663" />
    <path d="M10.6666 8L13.3333 8M13.3333 8L13.3333 5.33333M13.3333 8L10.6666 10.6667" />
  </svg>
);
