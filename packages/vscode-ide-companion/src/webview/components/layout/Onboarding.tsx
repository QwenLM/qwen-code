/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * VSCode-specific Onboarding page.
 * Compact welcome + settings guide in a single card layout.
 */

import type { FC } from 'react';
import { generateIconUrl } from '../../utils/resourceUrl.js';
import { ProviderSetupForm } from './ProviderSetupForm.js';

/**
 * VSCode Onboarding page — Welcome + provider setup in a single card.
 */
export const Onboarding: FC = () => {
  const iconUri = generateIconUrl('icon.png');

  return (
    <div className="flex items-center justify-center h-full p-4">
      <div
        className="w-full max-w-[340px] rounded-xl border overflow-hidden"
        style={{
          backgroundColor: 'var(--app-input-secondary-background)',
          borderColor: 'var(--app-input-border)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4 border-b"
          style={{ borderColor: 'var(--app-input-border)' }}
        >
          {iconUri && (
            <img
              src={iconUri}
              alt="Qwen Code"
              className="w-8 h-8 object-contain shrink-0"
            />
          )}
          <div>
            <div
              className="text-sm font-semibold leading-tight"
              style={{ color: 'var(--app-primary-foreground)' }}
            >
              Qwen Code
            </div>
            <div
              className="text-[11px] leading-tight mt-0.5"
              style={{ color: 'var(--app-secondary-foreground)' }}
            >
              Configure a provider to get started
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          <ProviderSetupForm />
        </div>
      </div>
    </div>
  );
};
