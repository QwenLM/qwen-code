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

// View states for the onboarding flow
type ViewState =
  | 'main'
  | 'coding-plan-region'
  | 'coding-plan-key'
  | 'custom-info';

const CODING_PLAN_API_KEY_URLS: Record<string, string> = {
  china: 'https://bailian.console.aliyun.com/?tab=model#/efm/coding_plan',
  global:
    'https://modelstudio.console.alibabacloud.com/?tab=dashboard#/efm/coding_plan',
};

// Shared button class names — Primary uses Qwen brand purple (#6366f1) from icon
const PRIMARY_BUTTON_CLASS =
  'w-full py-2.5 px-4 bg-[#6366f1] text-white font-medium rounded-md text-[13px] shadow-sm hover:bg-[#4f46e5] transition-colors duration-200 border border-transparent';
const SECONDARY_BUTTON_CLASS =
  'w-full py-2.5 px-4 bg-[var(--vscode-button-secondaryBackground,rgba(255,255,255,0.06))] text-[var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground))] font-medium rounded-md text-[13px] transition-colors duration-200 border border-[var(--vscode-widget-border,rgba(255,255,255,0.15))] hover:bg-[var(--vscode-button-secondaryHoverBackground,rgba(255,255,255,0.12))] hover:border-[var(--vscode-focusBorder,rgba(255,255,255,0.3))]';
const GHOST_BUTTON_CLASS =
  'w-full py-2 px-4 bg-transparent text-[var(--vscode-descriptionForeground,#aaa)] font-medium rounded-md text-[13px] transition-colors duration-200 border border-transparent hover:text-[var(--vscode-editor-foreground)] hover:bg-[rgba(255,255,255,0.06)]';

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

  const [viewState, setViewState] = useState<ViewState>('main');
  const [codingPlanKey, setCodingPlanKey] = useState<string>('');
  const [codingPlanRegion, setCodingPlanRegion] = useState<string>('china');
  const [apiKeyError, setApiKeyError] = useState<string>('');

  const handleLogin = (methodId: string) => {
    if (methodId === 'coding-plan') {
      setViewState('coding-plan-region');
    } else if (methodId === 'openai') {
      setViewState('custom-info');
    } else {
      onGetStarted(methodId);
    }
  };

  const handleRegionSelect = (region: string) => {
    setCodingPlanRegion(region);
    setViewState('coding-plan-key');
  };

  const handleCodingPlanSubmit = () => {
    const trimmedKey = codingPlanKey.trim();
    if (!trimmedKey) {
      setApiKeyError('API key cannot be empty.');
      return;
    }
    // Only validate sk-sp- prefix for China region (aliyun.com)
    if (codingPlanRegion === 'china' && !trimmedKey.startsWith('sk-sp-')) {
      setApiKeyError(
        'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.',
      );
      return;
    }
    setApiKeyError('');
    onGetStarted('coding-plan', {
      apiKey: trimmedKey,
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

  const apiKeyUrl =
    CODING_PLAN_API_KEY_URLS[codingPlanRegion] ??
    CODING_PLAN_API_KEY_URLS['china'];

  // Main auth selection view
  const renderMainView = () => (
    <>
      <div className="text-[14px] leading-relaxed text-[var(--vscode-editor-foreground)] mb-2 mt-2 text-center">
        <p>
          {appName === 'Qwen Code' ? 'Qwen Code' : appName} can be used with
          Qwen OAuth for free daily requests, or you can configure custom API
          providers and Coding Plan usage.
        </p>
      </div>

      {errorMessage && (
        <div className="w-full p-3 bg-[var(--vscode-inputValidation-errorBackground,rgba(255,0,0,0.1))] border border-[var(--vscode-inputValidation-errorBorder,rgba(255,0,0,0.3))] rounded-md text-[var(--vscode-errorForeground,#f48771)] text-[13px] break-words">
          {errorMessage}
        </div>
      )}

      <div className="w-full flex flex-col">
        {!authMethods || authMethods.length === 0 ? (
          <button
            onClick={() => onGetStarted('qwen-oauth')}
            className={PRIMARY_BUTTON_CLASS}
          >
            {finalButtonText}
          </button>
        ) : (
          <div className="flex flex-col w-full mt-2">
            <div className="text-[14px] font-medium text-[var(--vscode-editor-foreground)] mb-4 text-center">
              Select Authentication Method
            </div>
            <div className="flex flex-col gap-5">
              {authMethods.map((method) => {
                const isPrimary = method.id === 'qwen-oauth';
                return (
                  <div
                    key={method.id}
                    className="flex flex-col gap-2 w-full items-center"
                  >
                    <button
                      onClick={() => handleLogin(method.id)}
                      className={`flex justify-center items-center ${
                        isPrimary
                          ? PRIMARY_BUTTON_CLASS
                          : SECONDARY_BUTTON_CLASS
                      }`}
                    >
                      {method.name}
                    </button>
                    <div className="text-[13px] text-[var(--vscode-descriptionForeground,#aaa)] leading-relaxed text-center">
                      {method.description}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );

  // Region selection view for Coding Plan
  const renderRegionSelectView = () => (
    <>
      <div className="flex flex-col gap-6 w-full text-center mt-2">
        <h3 className="font-semibold text-[16px] text-[var(--vscode-editor-foreground)] mb-1">
          Select Region for Coding Plan
        </h3>
        <div className="text-[13px] text-[var(--vscode-descriptionForeground,#aaa)] leading-relaxed">
          Choose based on where your account is registered
        </div>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2 items-center">
            <button
              onClick={() => handleRegionSelect('china')}
              className={SECONDARY_BUTTON_CLASS}
            >
              阿里云百炼 (aliyun.com)
            </button>
            <a
              href="https://help.aliyun.com/zh/model-studio/coding-plan"
              target="_blank"
              rel="noreferrer"
              className="text-[12px] text-[var(--vscode-textLink-foreground,var(--app-link-foreground))] hover:text-[var(--vscode-textLink-activeForeground)] underline break-all"
            >
              https://help.aliyun.com/zh/model-studio/coding-plan
            </a>
          </div>
          <div className="flex flex-col gap-2 items-center">
            <button
              onClick={() => handleRegionSelect('global')}
              className={SECONDARY_BUTTON_CLASS}
            >
              Alibaba Cloud (alibabacloud.com)
            </button>
            <a
              href="https://www.alibabacloud.com/help/en/model-studio/coding-plan"
              target="_blank"
              rel="noreferrer"
              className="text-[12px] text-[var(--vscode-textLink-foreground,var(--app-link-foreground))] hover:text-[var(--vscode-textLink-activeForeground)] underline break-all"
            >
              https://www.alibabacloud.com/help/en/model-studio/coding-plan
            </a>
          </div>
        </div>
        <button
          onClick={() => setViewState('main')}
          className={GHOST_BUTTON_CLASS}
        >
          Back
        </button>
      </div>
    </>
  );

  // API Key input view for Coding Plan
  const renderApiKeyInputView = () => (
    <>
      <div className="flex flex-col gap-6 w-full text-center mt-2">
        <h3 className="font-semibold text-[16px] text-[var(--vscode-editor-foreground)] mb-1">
          Coding Plan API Key
        </h3>
        <div className="flex flex-col gap-2 text-left">
          <input
            type="password"
            value={codingPlanKey}
            onChange={(e) => {
              setCodingPlanKey(e.target.value);
              if (apiKeyError) setApiKeyError('');
            }}
            placeholder="sk-sp-..."
            className="w-full px-3 py-2.5 bg-[var(--vscode-input-background)] border border-[var(--vscode-inputBorder,rgba(255,255,255,0.1))] text-[var(--vscode-input-foreground)] rounded-md outline-none focus:border-[var(--vscode-focusBorder)] text-[13px]"
          />
          {apiKeyError && (
            <div className="text-[12px] text-[var(--vscode-errorForeground,#f48771)] mt-1">
              {apiKeyError}
            </div>
          )}
        </div>
        <div className="text-[13px] text-[var(--vscode-descriptionForeground,#aaa)] leading-relaxed flex flex-col gap-1 items-center">
          <span>You can get your Coding Plan API key here</span>
          <a
            href={apiKeyUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-[var(--vscode-textLink-foreground,var(--app-link-foreground))] hover:text-[var(--vscode-textLink-activeForeground)] underline break-all"
          >
            {apiKeyUrl}
          </a>
        </div>
        <div className="flex flex-col gap-3">
          <button
            onClick={handleCodingPlanSubmit}
            disabled={!codingPlanKey.trim()}
            className={`${PRIMARY_BUTTON_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Continue
          </button>
          <button
            onClick={() => setViewState('coding-plan-region')}
            className={GHOST_BUTTON_CLASS}
          >
            Back
          </button>
        </div>
      </div>
    </>
  );

  // Custom API key info view
  const renderCustomInfoView = () => (
    <>
      <div className="flex flex-col gap-6 w-full text-center mt-2">
        <h3 className="font-semibold text-[16px] text-[var(--vscode-editor-foreground)] mb-1">
          Custom Configuration
        </h3>
        <div className="text-[14px] leading-relaxed text-[var(--vscode-descriptionForeground,#aaa)] flex flex-col gap-4 items-center">
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
            className="text-[var(--vscode-textLink-foreground,var(--app-link-foreground))] hover:text-[var(--vscode-textLink-activeForeground)] underline break-all inline-block"
          >
            https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
          </a>
        </div>
        <div className="flex flex-col gap-3 mt-4">
          <button
            onClick={() => setViewState('main')}
            className={GHOST_BUTTON_CLASS}
          >
            Back
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex flex-col min-h-full p-6 text-[var(--vscode-editor-foreground)] font-sans">
      <div className="flex flex-col w-full max-w-[460px] m-auto pt-4 pb-10">
        <div className="flex flex-col gap-6 w-full items-center">
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

          {viewState === 'main' && renderMainView()}
          {viewState === 'coding-plan-region' && renderRegionSelectView()}
          {viewState === 'coding-plan-key' && renderApiKeyInputView()}
          {viewState === 'custom-info' && renderCustomInfoView()}
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
