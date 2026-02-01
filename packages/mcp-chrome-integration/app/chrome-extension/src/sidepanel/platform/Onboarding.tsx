/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { Onboarding as BaseOnboarding } from '@qwen-code/webui';
import { generateIconUrl } from '../utils/resourceUrl.js';

interface OnboardingPageProps {
  onLogin: () => void;
}

export const Onboarding: FC<OnboardingPageProps> = ({ onLogin }) => {
  const iconUrl = generateIconUrl('icon.png');
  return <BaseOnboarding iconUrl={iconUrl} onGetStarted={onLogin} />;
};
