/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';

interface IconProps {
  name: string;
  size?: number;
  color?: string;
  className?: string;
}

const Icon: FC<IconProps> = ({
  name,
  size = 24,
  color = 'currentColor',
  className = '',
}) => (
  // This is a placeholder - in a real implementation you might use an icon library
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={color}
    className={className}
  >
    <text
      x="50%"
      y="50%"
      dominantBaseline="middle"
      textAnchor="middle"
      fontSize="10"
    >
      {name}
    </text>
  </svg>
);
export default Icon;
