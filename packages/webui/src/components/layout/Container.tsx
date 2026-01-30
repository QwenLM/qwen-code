/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';

interface ContainerProps {
  children: React.ReactNode;
  className?: string;
}

const Container: FC<ContainerProps> = ({ children, className = '' }) => (
  <div className={`container mx-auto px-4 ${className}`}>{children}</div>
);

export default Container;
