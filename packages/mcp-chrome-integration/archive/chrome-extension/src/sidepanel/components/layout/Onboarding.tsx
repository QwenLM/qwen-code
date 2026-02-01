/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { generateIconUrl } from '../../utils/resourceUrl.js';

interface OnboardingPageProps {
  onLogin: () => void;
}

export const Onboarding: React.FC<OnboardingPageProps> = ({ onLogin }) => {
  const iconUri = generateIconUrl('icon.png');

  return (
    <div className="flex flex-col items-center justify-center h-full p-5 md:p-10">
      <div className="flex flex-col items-center gap-8 w-full max-w-md mx-auto">
        <div className="flex flex-col items-center gap-6">
          {/* Application icon container */}
          <div className="relative">
            <img
              src={iconUri}
              alt="Qwen Code Logo"
              className="w-[80px] h-[80px] object-contain"
            />
          </div>

          <div className="text-center">
            <h1 className="text-2xl font-bold text-app-primary-foreground mb-2">
              Welcome to Qwen Code
            </h1>
            <p className="text-app-secondary-foreground max-w-sm">
              Unlock the power of AI to understand, navigate, and transform your
              codebase faster than ever before.
            </p>
          </div>

          <button
            onClick={onLogin}
            className="w-full px-4 py-3 bg-[#4f46e5] text-white font-medium rounded-lg shadow-sm hover:bg-[#4338ca] transition-colors duration-200"
          >
            Get Started with Qwen Code
          </button>
        </div>
      </div>
    </div>
  );
};
