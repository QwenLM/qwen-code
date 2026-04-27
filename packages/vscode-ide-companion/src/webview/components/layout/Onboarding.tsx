/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * VSCode-specific Onboarding page.
 * Vertically centered welcome card with provider setup trigger.
 */

import type { FC } from 'react';
// eslint-disable-next-line import/no-internal-modules -- bundle the webview logo as a data URL
import iconUrl from '../../../../assets/icon.png';
import { ProviderSetupForm } from './ProviderSetupForm.js';

/**
 * VSCode Onboarding page.
 */
export const Onboarding: FC = () => (
  <div
    className="flex flex-col flex-1 min-h-0 px-6"
    style={{
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
    }}
  >
    {/* Logo + title block — sits above the card for visual breathing room */}
    <div className="flex flex-col items-center gap-3 mb-6">
      <img src={iconUrl} alt="Qwen Code" className="w-12 h-12 object-contain" />
      <div className="text-center">
        <h1
          className="text-base font-semibold"
          style={{ color: 'var(--app-primary-foreground)' }}
        >
          Qwen Code
        </h1>
        <p
          className="text-xs mt-1"
          style={{ color: 'var(--app-secondary-foreground)' }}
        >
          AI-powered coding assistant for your editor
        </p>
      </div>
    </div>

    {/* Setup card */}
    <div
      className="w-full max-w-[300px] rounded-lg border p-4"
      style={{
        backgroundColor: 'var(--app-input-secondary-background)',
        borderColor: 'var(--app-input-border)',
      }}
    >
      <p
        className="text-xs mb-3 text-center"
        style={{ color: 'var(--app-secondary-foreground)' }}
      >
        Connect a model provider to get started
      </p>
      <ProviderSetupForm />
    </div>

    {/* Subtle hint below the card */}
    <p
      className="text-[10px] mt-4 text-center max-w-[260px]"
      style={{ color: 'var(--app-secondary-foreground)', opacity: 0.6 }}
    >
      Supports Alibaba Cloud Coding Plan, ModelStudio API Key, and
      OpenAI-compatible endpoints
    </p>
  </div>
);
