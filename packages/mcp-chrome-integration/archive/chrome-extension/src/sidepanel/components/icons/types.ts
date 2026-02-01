/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Common icon props interface
 */

import type React from 'react';

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  /**
   * Icon size (width and height)
   * @default 16
   */
  size?: number;

  /**
   * Additional CSS classes
   */
  className?: string;
}
