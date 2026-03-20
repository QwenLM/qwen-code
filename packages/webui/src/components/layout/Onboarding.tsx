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
  buttonText,
  errorMessage,
}) => {
  const defaultButtonText = 'Get Started with Qwen Code';
  const finalButtonText = buttonText ?? defaultButtonText;

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
      region: codingPlanRegion,
    });
  };

  const isSafeIcon = (url?: string) => {
    if (!url) return false;
    try {
      if (url.startsWith('data:') || url.startsWith('vscode-webview-resource:'))
        return true;
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  };

  const trustedIconUrl = isSafeIcon(iconUrl)
    ? encodeURI(iconUrl as string)
    : undefined;

  return (
    <div className="flex flex-col min-h-full p-6 text-[var(--vscode-editor-foreground)] font-sans">
      <div className="flex flex-col w-full max-w-[460px] m-auto pt-4 pb-10">
        <div className="flex flex-col gap-6 w-full">
          {trustedIconUrl && (
            <div className="flex flex-col items-center w-full">
              <img
                src={trustedIconUrl}
                alt={`${appName} Logo`}
                className="w-[72px] h-[72px] object-contain mb-5"
              />
              <div className="w-full border-b border-dashed border-[var(--vscode-widget-border,var(--vscode-editorGroup-border,rgba(255,255,255,0.15)))] opacity-60"></div>
            </div>
          )}

          {!selectedMethodId && (
            <div className="text-[14px] leading-relaxed text-[var(--vscode-editor-foreground)] mb-2 mt-2">
              <p>
                {appName === 'Qwen Code' ? 'Qwen Code' : appName} can be used
                with Qwen OAuth for free daily requests, or you can configure
                custom API providers and Coding Plan usage.
              </p>
            </div>
          )}

          {errorMessage && (
            <div className="w-full p-3 bg-[var(--vscode-inputValidation-errorBackground,rgba(255,0,0,0.1))] border border-[var(--vscode-inputValidation-errorBorder,rgba(255,0,0,0.3))] rounded-md text-[var(--vscode-errorForeground,#f48771)] text-[13px] break-words">
              {errorMessage === 'Login failed. Please try again.'
                ? 'Login failed. Please try again.'
                : errorMessage}
            </div>
          )}

          <div className="w-full flex flex-col">
            {!authMethods || authMethods.length === 0 ? (
              <button
                onClick={() => onGetStarted('qwen-oauth')}
                className="w-full py-2.5 px-4 bg-[var(--vscode-button-background,var(--app-button-background))] text-[var(--vscode-button-foreground,#ffffff)] font-medium rounded-md text-[13px] shadow-sm hover:bg-[var(--vscode-button-hoverBackground,var(--app-button-hover-background))] transition-colors duration-200 border border-transparent"
              >
                {finalButtonText}
              </button>
            ) : selectedMethodId === 'coding-plan' ? (
              <div className="flex flex-col gap-6 w-full text-left mt-2">
                <h3 className="font-semibold text-[16px] text-[var(--vscode-editor-foreground)] mb-1">
                  Configure Alibaba Cloud Coding Plan
                </h3>
                <div className="flex flex-col gap-2">
                  <label className="text-[13px] text-[var(--vscode-editor-foreground)]">
                    Enter your API Key:
                  </label>
                  <input
                    type="password"
                    value={codingPlanKey}
                    onChange={(e) => setCodingPlanKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full px-3 py-2.5 bg-[var(--vscode-input-background)] border border-[var(--vscode-inputBorder,rgba(255,255,255,0.1))] text-[var(--vscode-input-foreground)] rounded-md outline-none focus:border-[var(--vscode-focusBorder)] text-[13px]"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-[13px] text-[var(--vscode-editor-foreground)]">
                    Select Region:
                  </label>
                  <select
                    value={codingPlanRegion}
                    onChange={(e) => setCodingPlanRegion(e.target.value)}
                    className="w-full px-3 py-2.5 bg-[var(--vscode-dropdown-background)] border border-[var(--vscode-dropdownBorder,rgba(255,255,255,0.1))] text-[var(--vscode-dropdown-foreground)] rounded-md outline-none focus:border-[var(--vscode-focusBorder)] text-[13px] cursor-pointer"
                  >
                    <option value="china">Alibaba Cloud (aliyun.com)</option>
                    <option value="global">
                      Alibaba Cloud (alibabacloud.com)
                    </option>
                  </select>
                </div>
                <div className="flex flex-col gap-3 mt-2">
                  <button
                    onClick={handleCodingPlanSubmit}
                    disabled={!codingPlanKey.trim()}
                    className="w-full py-2.5 px-4 bg-[var(--vscode-button-background,var(--app-button-background))] text-[var(--vscode-button-foreground,#ffffff)] border border-transparent font-medium rounded-md text-[13px] transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--vscode-button-hoverBackground,var(--app-button-hover-background))]"
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => setSelectedMethodId('')}
                    className="w-full py-2.5 px-4 bg-[var(--vscode-button-secondaryBackground,rgba(255,255,255,0.08))] text-[var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground))] border border-transparent font-medium rounded-md text-[13px] transition-colors duration-200 hover:bg-[var(--vscode-button-secondaryHoverBackground,rgba(255,255,255,0.15))]"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : selectedMethodId === 'openai' ? (
              <div className="flex flex-col gap-6 w-full text-left mt-2">
                <h3 className="font-semibold text-[16px] text-[var(--vscode-editor-foreground)] mb-1">
                  Custom Configuration
                </h3>
                <div className="text-[14px] leading-relaxed text-[var(--vscode-descriptionForeground,#aaa)] flex flex-col gap-4">
                  <p>
                    You can configure your API key and models in the{' '}
                    <code className="bg-[var(--vscode-textCodeBlock-background,rgba(128,128,128,0.2))] text-[var(--vscode-textPreformat-foreground)] px-1.5 py-0.5 rounded font-mono text-[12px]">
                      settings.json
                    </code>{' '}
                    file.
                  </p>
                  <p>Refer to the documentation for setup instructions:</p>
                  <a
                    href="https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] underline break-all inline-block"
                  >
                    https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
                  </a>
                </div>
                <div className="flex flex-col gap-3 mt-4">
                  <button
                    onClick={() => setSelectedMethodId('')}
                    className="w-full py-2.5 px-4 bg-[var(--vscode-button-secondaryBackground,rgba(255,255,255,0.08))] text-[var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground))] border border-transparent font-medium rounded-md text-[13px] transition-colors duration-200 hover:bg-[var(--vscode-button-secondaryHoverBackground,rgba(255,255,255,0.15))]"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col w-full mt-2">
                <div className="text-[14px] font-medium text-[var(--vscode-editor-foreground)] mb-4">
                  How do you want to log in?
                </div>
                <div className="flex flex-col gap-5">
                  {authMethods.map((method) => {
                    const isPrimary = method.id === 'qwen-oauth';
                    return (
                      <div
                        key={method.id}
                        className="flex flex-col gap-2 w-full"
                      >
                        <button
                          onClick={() => handleLogin(method.id)}
                          className={`w-full py-2.5 px-4 font-medium rounded-md text-[13px] transition-colors duration-200 border border-transparent flex justify-center items-center ${
                            isPrimary
                              ? 'bg-[var(--vscode-button-background,var(--app-button-background))] text-[var(--vscode-button-foreground,#ffffff)] hover:bg-[var(--vscode-button-hoverBackground,var(--app-button-hover-background))] shadow-sm'
                              : 'bg-[var(--vscode-button-secondaryBackground,rgba(255,255,255,0.08))] text-[var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground))] hover:bg-[var(--vscode-button-secondaryHoverBackground,rgba(255,255,255,0.15))]'
                          }`}
                        >
                          {method.name}
                        </button>
                        <div className="text-[13px] text-[var(--vscode-descriptionForeground,#aaa)] leading-relaxed text-left">
                          {method.description}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
