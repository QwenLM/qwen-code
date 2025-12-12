/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { generateIconUrl } from '../../utils/resourceUrl.js';

export const EmptyState: React.FC = () => {
  // Generate icon URL using the utility function
  const iconUri = generateIconUrl('icon.png');

  return (
    <div className="flex flex-col items-center justify-center h-full p-5 md:p-10">
      <div className="flex flex-col items-center gap-8 w-full">
        {/* Qwen Logo */}
        <div className="flex flex-col items-center gap-6">
          <img
            src={iconUri}
            alt="Qwen Logo"
            className="w-[60px] h-[60px] object-contain"
          />
          <div className="text-center">
            <div className="text-[15px] text-app-primary-foreground leading-normal font-normal max-w-[400px]">
              What to do first? Ask about this codebase or we can start writing
              code.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
