/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Onboarding component - Pure UI welcome screen
 * Platform-specific logic (icon URL) passed via props
 */

import type { FC } from 'react';

export interface OnboardingProps {
  /** URL of the application icon */
  iconUrl?: string;
  /** Callback when user clicks the get started button */
  onGetStarted: () => void;
  /** Application name (defaults to "Qwen Code") */
  appName?: string;
  /** Welcome message subtitle */
  subtitle?: string;
  /** Button text (defaults to "Get Started with Qwen Code") */
  buttonText?: string;
}

/**
 * Onboarding - Welcome screen for new users
 * Pure presentational component
 */
export const Onboarding: FC<OnboardingProps> = ({
  iconUrl,
  onGetStarted,
  appName = 'Qwen Code',
  subtitle = 'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.',
  buttonText = 'Get Started with Qwen Code',
}) => (
  <div className="flex flex-col items-center justify-center h-full p-5 md:p-10">
    <div className="flex flex-col items-center gap-8 w-full max-w-md mx-auto">
      <div className="flex flex-col items-center gap-6">
        {/* Application icon container */}
        {iconUrl && (
          <div className="relative">
            <img
              src={iconUrl}
              alt={`${appName} Logo`}
              className="w-[80px] h-[80px] object-contain"
            />
          </div>
        )}

        <div className="text-center">
          <h1 className="text-2xl font-bold text-[var(--app-primary-foreground)] mb-2">
            Welcome to {appName}
          </h1>
          <p className="text-[var(--app-secondary-foreground)] max-w-sm">
            {subtitle}
          </p>
        </div>

        <button
          onClick={onGetStarted}
          className="w-full px-4 py-3 bg-[var(--app-primary,var(--app-button-background))] text-[var(--app-button-foreground,#ffffff)] font-medium rounded-lg shadow-sm hover:bg-[var(--app-primary-hover,var(--app-button-hover-background))] transition-colors duration-200"
        >
          {buttonText}
        </button>
      </div>
    </div>
  </div>
);

export default Onboarding;
