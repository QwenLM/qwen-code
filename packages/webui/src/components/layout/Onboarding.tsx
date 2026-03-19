/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Core UI components mapped from VSCode UI elements
 * Platform-specific logic (icon URL) passed via props
 */

import { useState } from 'react';
import type { FC } from 'react';
import { t } from '../../utils/i18n.js';

export interface AuthMethodInfo {
  id: string;
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface OnboardingProps {
  /** URL of the application icon */
  iconUrl?: string;
  /** Callback when user clicks the get started button */
  onGetStarted: (methodId?: string, _meta?: Record<string, unknown>) => void;
  /** Available authentication methods */
  authMethods?: AuthMethodInfo[];
  /** Application name (defaults to "Qwen Code") */
  appName?: string;
  /** Welcome message subtitle */
  subtitle?: string;
  /** Button text (defaults to "Get Started with Qwen Code") */
  buttonText?: string;
  /** Error message to display when login fails */
  errorMessage?: string;
}

export const Onboarding: FC<OnboardingProps> = ({
  iconUrl,
  onGetStarted,
  authMethods = [],
  appName = 'Qwen Code',
  subtitle = 'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.',
  buttonText = 'Get Started with Qwen Code',
  errorMessage,
}) => {
  const [selectedMethodId, setSelectedMethodId] = useState<string>('');
  const [codingPlanKey, setCodingPlanKey] = useState<string>('');
  const [codingPlanRegion, setCodingPlanRegion] = useState<string>('china');

  const handleLogin = (methodId: string) => {
    if (methodId === 'coding-plan') {
      setSelectedMethodId('coding-plan');
    } else if (methodId === 'openai') {
      setSelectedMethodId('openai');
    } else {
      onGetStarted(methodId);
    }
  };

  const handleCodingPlanSubmit = () => {
    if (!codingPlanKey.trim()) return;
    onGetStarted('coding-plan', {
      apiKey: codingPlanKey.trim(),
      region: codingPlanRegion
    });
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-5 md:p-10">
      <div className="flex flex-col items-center gap-8 w-full max-w-md mx-auto">
        <div className="flex flex-col items-center gap-6 w-full">
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

          {errorMessage && (
            <div className="w-full p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-500 text-sm break-words">
              {errorMessage}
            </div>
          )}

          <div className="w-full flex flex-col gap-4 mt-4">
            {!authMethods || authMethods.length === 0 ? (
              <button
                onClick={() => onGetStarted('qwen-oauth')}
                className="w-full px-4 py-3 bg-[var(--app-primary,var(--app-button-background))] text-[var(--app-button-foreground,#ffffff)] font-medium rounded-lg shadow-sm hover:bg-[var(--app-primary-hover,var(--app-button-hover-background))] transition-colors duration-200"
              >
                {buttonText}
              </button>
            ) : (
              selectedMethodId === 'coding-plan' ? (
                <div className="flex flex-col gap-4 w-full text-left bg-[var(--app-input-background)] p-4 rounded-md border border-[var(--app-input-border)]">
                  <h3 className="font-bold text-lg mb-2">{t('Alibaba Cloud Coding Plan')}</h3>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-semibold">{t('API Key')}</label>
                    <input
                      type="password"
                      value={codingPlanKey}
                      onChange={(e) => setCodingPlanKey(e.target.value)}
                      placeholder="sk-..."
                      className="px-3 py-2 bg-[var(--vscode-input-background)] border border-[var(--vscode-input-border)] text-[var(--vscode-input-foreground)] rounded w-full outline-none focus:border-[var(--vscode-focusBorder)]"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-semibold">{t('Region')}</label>
                    <select
                      value={codingPlanRegion}
                      onChange={(e) => setCodingPlanRegion(e.target.value)}
                      className="px-3 py-2 bg-[var(--vscode-dropdown-background)] border border-[var(--vscode-dropdown-border)] text-[var(--vscode-dropdown-foreground)] rounded w-full outline-none focus:border-[var(--vscode-focusBorder)] cursor-pointer"
                    >
                      <option value="china">阿里云百炼 (aliyun.com)</option>
                      <option value="global">Alibaba Cloud (alibabacloud.com)</option>
                    </select>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => setSelectedMethodId('')}
                      className="flex-1 px-4 py-2 border border-[var(--app-button-background)] text-[var(--app-button-background)] bg-transparent font-medium rounded-lg hover:bg-[var(--app-button-background)] hover:bg-opacity-10 transition-colors duration-200"
                    >
                      {t('Back')}
                    </button>
                    <button
                      onClick={handleCodingPlanSubmit}
                      disabled={!codingPlanKey.trim()}
                      className="flex-1 px-4 py-2 bg-[var(--app-primary,var(--app-button-background))] text-[var(--app-button-foreground,#ffffff)] font-medium rounded-lg shadow-sm hover:bg-[var(--app-primary-hover,var(--app-button-hover-background))] transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t('Submit')}
                    </button>
                  </div>
                </div>
              ) : selectedMethodId === 'openai' ? (
                <div className="flex flex-col gap-4 w-full text-left bg-[var(--app-input-background)] p-4 rounded-md border border-[var(--app-input-border)]">
                    <h3 className="font-bold text-lg mb-2">
                      {t('Custom Configuration')}
                    </h3>
                  <div className="text-sm text-[var(--app-secondary-foreground)]">
                    <p className="mb-2">
                      {t('You can configure your API key and models in settings.json')}
                    </p>
                    <p className="mb-2">
                      {t('Refer to the documentation for setup instructions.')}
                    </p>
                    <a
                      href="https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] underline break-all"
                    >
                      https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
                    </a>
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => setSelectedMethodId('')}
                      className="w-full px-4 py-2 bg-[var(--app-primary,var(--app-button-background))] text-[var(--app-button-foreground,#ffffff)] font-medium rounded-lg shadow-sm hover:bg-[var(--app-primary-hover,var(--app-button-hover-background))] transition-colors duration-200"
                    >
                      {t('Back')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3 w-full">
                  <h3 className="text-sm font-semibold mb-1 text-[var(--app-secondary-foreground)] uppercase drop-shadow-sm border-b pb-1 border-[var(--app-input-border)]">
                    {t('Select Authentication Method')}
                  </h3>
                  {authMethods.map((method) => (
                    <button
                      key={method.id}
                      onClick={() => handleLogin(method.id)}
                      className="w-full flex flex-col items-start text-left px-4 py-3 bg-[var(--app-input-background)] text-[var(--app-primary-foreground)] border border-[var(--app-input-border)] hover:border-[var(--vscode-focusBorder)] rounded-lg transition-colors duration-200 relative group overflow-hidden"
                    >
                      <div className="font-medium">{method.name}</div>
                      <div className="text-xs text-[var(--app-secondary-foreground)] mt-1">{method.description}</div>
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
