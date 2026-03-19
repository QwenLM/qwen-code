/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * VSCode-specific Onboarding adapter
 * Uses webui Onboarding component with platform-specific icon URL
 */

import type { FC } from 'react';
import { Onboarding as BaseOnboarding } from '@qwen-code/webui';
import { generateIconUrl } from '../../utils/resourceUrl.js';

interface OnboardingPageProps {
  onLogin: (methodId?: string, _meta?: Record<string, unknown>) => void;
  authMethods?: any[];
  errorMessage?: string;
}

/**
 * VSCode Onboarding wrapper
 * Provides platform-specific icon URL to the webui Onboarding component
 */
export const Onboarding: FC<OnboardingPageProps> = ({ onLogin, authMethods, errorMessage }) => {
  const iconUri = generateIconUrl('icon.png');

  return <BaseOnboarding iconUrl={iconUri} onGetStarted={onLogin} authMethods={authMethods} errorMessage={errorMessage} />;
};
