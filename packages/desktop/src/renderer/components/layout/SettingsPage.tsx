/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, type Dispatch } from 'react';
import type { DesktopUserSettings } from '../../api/client.js';
import type { ChatState } from '../../stores/chatStore.js';
import type { ModelState } from '../../stores/modelStore.js';
import {
  validateSettingsForm,
  type SettingsAction,
  type SettingsFormState,
  type SettingsState,
} from '../../stores/settingsStore.js';
import type { DesktopApprovalMode } from '../../../shared/desktopProtocol.js';
import {
  formatRuntimeModelLabel,
  formatRuntimeModelOptionTitle,
  getRuntimeModelProviderStatus,
  groupRuntimeModelOptions,
} from './formatters.js';
import { CloseIcon } from './SidebarIcons.js';
import type { LoadState } from './types.js';

const settingsSections = [
  { id: 'settings-account', label: 'Account' },
  { id: 'settings-model-providers', label: 'Model Providers' },
  { id: 'settings-permissions', label: 'Permissions' },
  { id: 'settings-tools', label: 'Tools & MCP' },
  { id: 'settings-terminal', label: 'Terminal' },
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-advanced', label: 'Advanced' },
] as const;

export type SettingsSectionId = (typeof settingsSections)[number]['id'];

export function SettingsPage({
  activeSessionId,
  chatState,
  initialSectionId = 'settings-account',
  loadState,
  modelState,
  sessionError,
  settingsState,
  onAuthenticate,
  onBack,
  onModeChange,
  onModelChange,
  onSaveSettings,
  onSettingsDispatch,
}: {
  activeSessionId: string | null;
  chatState: ChatState;
  initialSectionId?: SettingsSectionId;
  loadState: LoadState;
  modelState: ModelState;
  sessionError: string | null;
  settingsState: SettingsState;
  onAuthenticate: (methodId: string) => void;
  onBack: () => void;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  onSaveSettings: () => void;
  onSettingsDispatch: Dispatch<SettingsAction>;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    const section = document.getElementById(initialSectionId);
    if (typeof section?.scrollIntoView === 'function') {
      section.scrollIntoView({ block: 'start', inline: 'nearest' });
    }

    const focusTarget =
      initialSectionId === 'settings-model-providers'
        ? document.querySelector<HTMLSelectElement>(
            '[data-testid="settings-provider-select"]',
          )
        : document.querySelector<HTMLButtonElement>(
            '[data-testid="settings-close-button"]',
          );

    focusTarget?.focus({ preventScroll: true });
  }, [initialSectionId]);

  return (
    <section
      className="panel settings-page"
      aria-label="Settings"
      aria-modal="true"
      data-initial-section={initialSectionId}
      data-testid="settings-page"
      role="dialog"
    >
      <div className="panel-header settings-page-header">
        <div>
          <h3>Settings</h3>
          <span>Account, model, permissions, and local tools</span>
        </div>
        <button
          aria-label="Close Settings"
          className="settings-close-button"
          data-testid="settings-close-button"
          title="Close Settings"
          type="button"
          onClick={onBack}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="settings-page-content">
        <nav
          aria-label="Settings sections"
          className="settings-section-nav"
          data-testid="settings-section-nav"
        >
          {settingsSections.map((section) => (
            <a
              aria-label={`Show ${section.label} settings`}
              href={`#${section.id}`}
              key={section.id}
            >
              {section.label}
            </a>
          ))}
        </nav>
        <div className="settings-page-sections" data-testid="settings-sections">
          <AccountPanel state={settingsState} onAuthenticate={onAuthenticate} />
          <ModelProvidersPanel
            state={settingsState}
            onDispatch={onSettingsDispatch}
            onSave={onSaveSettings}
          />
          <PermissionsPanel
            activeSessionId={activeSessionId}
            chatState={chatState}
            modelState={modelState}
            sessionError={sessionError}
            onModeChange={onModeChange}
            onModelChange={onModelChange}
          />
          <ToolsPanel chatState={chatState} />
          <TerminalSettingsPanel />
          <AppearancePanel />
          <AdvancedDiagnosticsPanel
            activeSessionId={activeSessionId}
            chatState={chatState}
            isOpen={advancedOpen}
            loadState={loadState}
            modelState={modelState}
            sessionError={sessionError}
            settingsState={settingsState}
            onToggle={() => setAdvancedOpen((current) => !current)}
          />
        </div>
      </div>
    </section>
  );
}

function AccountPanel({
  onAuthenticate,
  state,
}: {
  onAuthenticate: (methodId: string) => void;
  state: SettingsState;
}) {
  const authType = formatAuthType(state.settings?.selectedAuthType);
  const openAiKeyStatus = formatSecretStatus(state.settings?.openai.hasApiKey);
  const codingPlanKeyStatus = formatSecretStatus(
    state.settings?.codingPlan.hasApiKey,
  );

  return (
    <section
      className="settings-section settings-account"
      data-testid="settings-account-section"
      id="settings-account"
    >
      <div className="panel-header panel-header-inline">
        <div>
          <h3>Account</h3>
          <span>{authType}</span>
        </div>
      </div>
      <dl className="settings-kv">
        <div>
          <dt>Auth</dt>
          <dd>{authType}</dd>
        </div>
        <div>
          <dt>API key</dt>
          <dd>{openAiKeyStatus}</dd>
        </div>
        <div>
          <dt>Coding Plan key</dt>
          <dd>{codingPlanKeyStatus}</dd>
        </div>
      </dl>
      <div className="settings-card-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => onAuthenticate('qwen-oauth')}
        >
          OAuth
        </button>
      </div>
    </section>
  );
}

function ModelProvidersPanel({
  onDispatch,
  onSave,
  state,
}: {
  onDispatch: Dispatch<SettingsAction>;
  onSave: () => void;
  state: SettingsState;
}) {
  const provider = state.form.provider;
  const validation = validateSettingsForm(state.form, state.settings);
  const validationReason = validation.valid ? null : validation.reason;
  const saveStatus = getModelProviderSaveStatus(state);
  const saveDisabledReason = state.loading
    ? 'Settings are still loading.'
    : state.saving
      ? 'Saving settings.'
      : validationReason;
  const saveValidationId = validationReason
    ? 'settings-save-validation'
    : undefined;
  const saveStatusId = saveStatus ? 'settings-save-status' : undefined;
  const saveDescribedBy = saveValidationId ?? saveStatusId;

  return (
    <section
      className="settings-section settings-panel"
      data-testid="model-config"
      id="settings-model-providers"
    >
      <div className="panel-header panel-header-inline">
        <div>
          <h3>Model Providers</h3>
          <span>{formatProviderLabel(provider)}</span>
        </div>
      </div>
      <div className="settings-form">
        <label>
          <span>Provider</span>
          <select
            aria-label="Model provider"
            data-testid="settings-provider-select"
            value={provider}
            onChange={(event) =>
              onDispatch({
                type: 'set_provider',
                provider: event.target.value as 'api-key' | 'coding-plan',
              })
            }
          >
            <option value="api-key">API key</option>
            <option value="coding-plan">Coding Plan</option>
          </select>
        </label>

        {provider === 'coding-plan' ? (
          <label>
            <span>Region</span>
            <select
              aria-label="Coding Plan region"
              data-testid="settings-coding-plan-region"
              value={state.form.codingPlanRegion}
              onChange={(event) =>
                onDispatch({
                  type: 'set_coding_plan_region',
                  region: event.target.value as 'china' | 'global',
                })
              }
            >
              <option value="china">China</option>
              <option value="global">Global</option>
            </select>
          </label>
        ) : (
          <>
            <label>
              <span>Model</span>
              <input
                aria-label="Provider model"
                value={state.form.activeModel}
                onChange={(event) =>
                  onDispatch({
                    type: 'set_active_model',
                    model: event.target.value,
                  })
                }
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                aria-label="Provider base URL"
                value={state.form.baseUrl}
                onChange={(event) =>
                  onDispatch({
                    type: 'set_base_url',
                    baseUrl: event.target.value,
                  })
                }
              />
            </label>
          </>
        )}

        <label>
          <span>API key</span>
          <input
            aria-label="Provider API key"
            autoComplete="off"
            placeholder={
              provider === 'coding-plan'
                ? state.settings?.codingPlan.hasApiKey
                  ? 'Configured'
                  : ''
                : state.settings?.openai.hasApiKey
                  ? 'Configured'
                  : ''
            }
            type="password"
            value={state.form.apiKey}
            onChange={(event) =>
              onDispatch({ type: 'set_api_key', apiKey: event.target.value })
            }
          />
        </label>

        <div className="settings-actions">
          {validationReason ? (
            <p
              className="settings-validation error-text"
              data-testid="settings-save-validation"
              id="settings-save-validation"
            >
              {validationReason}
            </p>
          ) : null}
          {!validationReason && saveStatus ? (
            <p
              className={`settings-save-status settings-save-status-${saveStatus.kind}`}
              data-testid="settings-save-status"
              id="settings-save-status"
              role={saveStatus.kind === 'error' ? 'alert' : 'status'}
            >
              {saveStatus.message}
            </p>
          ) : null}
          <button
            aria-describedby={saveDescribedBy}
            className="primary-button"
            disabled={Boolean(saveDisabledReason)}
            title={saveDisabledReason ?? 'Save model provider settings'}
            type="button"
            onClick={onSave}
          >
            {state.saving ? 'Saving' : 'Save'}
          </button>
        </div>

        {state.settings ? (
          <p className="settings-summary">
            {formatAuthType(state.settings.selectedAuthType)} ·{' '}
            {state.settings.model.name || 'No model'} · API key{' '}
            {formatSecretStatus(
              provider === 'coding-plan'
                ? state.settings.codingPlan.hasApiKey
                : state.settings.openai.hasApiKey,
            ).toLowerCase()}
          </p>
        ) : null}
      </div>
    </section>
  );
}

interface ModelProviderSaveStatus {
  kind: 'saving' | 'saved' | 'error';
  message: string;
}

function getModelProviderSaveStatus(
  state: SettingsState,
): ModelProviderSaveStatus | null {
  if (state.saving || state.saveStatus.type === 'saving') {
    return {
      kind: 'saving',
      message: 'Saving model provider settings...',
    };
  }

  if (state.saveStatus.type === 'error') {
    return {
      kind: 'error',
      message: `Could not save model provider settings: ${state.saveStatus.message}`,
    };
  }

  if (state.error) {
    return {
      kind: 'error',
      message: `Could not load model provider settings: ${state.error}`,
    };
  }

  if (state.saveStatus.type === 'saved' && state.settings) {
    return {
      kind: 'saved',
      message: formatSavedProviderStatus(state.settings),
    };
  }

  return null;
}

function formatSavedProviderStatus(settings: DesktopUserSettings): string {
  if (settings.provider === 'coding-plan') {
    return [
      'Saved Coding Plan provider',
      formatCodingPlanRegion(settings.codingPlan.region),
      formatApiKeyState(settings.codingPlan.hasApiKey),
    ].join(' · ');
  }

  return [
    'Saved API key provider',
    settings.model.name || 'No model',
    formatApiKeyState(settings.openai.hasApiKey),
  ].join(' · ');
}

function formatCodingPlanRegion(
  region: DesktopUserSettings['codingPlan']['region'],
): string {
  return region === 'global' ? 'Global' : 'China';
}

function formatApiKeyState(hasApiKey: boolean): string {
  return hasApiKey ? 'API key configured' : 'API key missing';
}

function PermissionsPanel({
  activeSessionId,
  chatState,
  modelState,
  onModeChange,
  onModelChange,
  sessionError,
}: {
  activeSessionId: string | null;
  chatState: ChatState;
  modelState: ModelState;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  sessionError: string | null;
}) {
  const currentMode =
    modelState.modes?.currentModeId || chatState.mode || 'default';
  const currentModel =
    modelState.models?.currentModelId || chatState.currentModelId || '';
  const currentModelInfo = modelState.models?.availableModels.find(
    (model) => model.modelId === currentModel,
  );
  const currentModelTitle = currentModelInfo
    ? formatRuntimeModelOptionTitle(currentModelInfo)
    : currentModel || 'Unknown';
  const currentModelProviderStatus = currentModelInfo
    ? getRuntimeModelProviderStatus(currentModelInfo)
    : null;
  const modelOptionGroups = modelState.models
    ? groupRuntimeModelOptions(modelState.models.availableModels)
    : [];

  return (
    <section
      className="settings-section permissions-panel"
      data-testid="permissions-config"
      id="settings-permissions"
    >
      <div className="panel-header panel-header-inline">
        <div>
          <h3>Permissions</h3>
          <span>{activeSessionId ? 'Active thread' : 'No active thread'}</span>
        </div>
      </div>
      <div className="settings-form">
        <label>
          <span>Permission mode</span>
          {modelState.modes ? (
            <select
              disabled={!activeSessionId || modelState.savingMode}
              value={currentMode}
              onChange={(event) =>
                onModeChange(event.target.value as DesktopApprovalMode)
              }
            >
              {modelState.modes.availableModes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.name}
                </option>
              ))}
            </select>
          ) : (
            <input disabled readOnly value={currentMode || 'Unknown'} />
          )}
        </label>
        <label
          className={
            currentModelProviderStatus
              ? 'settings-thread-model-label settings-thread-model-label-with-status'
              : 'settings-thread-model-label'
          }
          data-testid="settings-thread-model-control"
          title={currentModelTitle}
        >
          <span>Thread model</span>
          {modelState.models ? (
            <span className="settings-thread-model-shell">
              <select
                aria-label="Thread model"
                disabled={!activeSessionId || modelState.savingModel}
                title={currentModelTitle}
                value={currentModel}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {modelOptionGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((model) => (
                      <option
                        key={model.modelId}
                        title={formatRuntimeModelOptionTitle(model)}
                        value={model.modelId}
                      >
                        {formatRuntimeModelLabel(model)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {currentModelProviderStatus ? (
                <span
                  aria-label={currentModelProviderStatus.title}
                  className={`settings-thread-model-status-dot settings-thread-model-status-${currentModelProviderStatus.state}`}
                  data-testid="settings-thread-model-provider-status"
                  role="img"
                  title={currentModelProviderStatus.title}
                />
              ) : null}
            </span>
          ) : (
            <input disabled readOnly value={currentModel || 'Unknown'} />
          )}
        </label>
        {sessionError || chatState.error ? (
          <p className="error-text">{sessionError || chatState.error}</p>
        ) : null}
        {modelState.error ? (
          <p className="error-text">{modelState.error}</p>
        ) : null}
      </div>
    </section>
  );
}

function ToolsPanel({ chatState }: { chatState: ChatState }) {
  return (
    <section
      className="settings-section"
      data-testid="settings-tools-section"
      id="settings-tools"
    >
      <div className="panel-header panel-header-inline">
        <div>
          <h3>Tools & MCP</h3>
          <span>{chatState.availableCommands.length} commands</span>
        </div>
      </div>
      <dl className="settings-kv">
        <div>
          <dt>Commands</dt>
          <dd>{chatState.availableCommands.length}</dd>
        </div>
        <div>
          <dt>Skills</dt>
          <dd>{chatState.availableSkills.length}</dd>
        </div>
      </dl>
    </section>
  );
}

function TerminalSettingsPanel() {
  return (
    <section
      className="settings-section"
      data-testid="settings-terminal-section"
      id="settings-terminal"
    >
      <div className="panel-header panel-header-inline">
        <div>
          <h3>Terminal</h3>
          <span>Project scoped</span>
        </div>
      </div>
      <dl className="settings-kv">
        <div>
          <dt>Shell</dt>
          <dd>Default</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>Attach to composer</dd>
        </div>
      </dl>
    </section>
  );
}

function AppearancePanel() {
  return (
    <section
      className="settings-section"
      data-testid="settings-appearance-section"
      id="settings-appearance"
    >
      <div className="panel-header panel-header-inline">
        <div>
          <h3>Appearance</h3>
          <span>Desktop dark</span>
        </div>
      </div>
      <dl className="settings-kv">
        <div>
          <dt>Theme</dt>
          <dd>Dark</dd>
        </div>
        <div>
          <dt>Density</dt>
          <dd>Compact</dd>
        </div>
      </dl>
    </section>
  );
}

function AdvancedDiagnosticsPanel({
  activeSessionId,
  chatState,
  isOpen,
  loadState,
  modelState,
  onToggle,
  sessionError,
  settingsState,
}: {
  activeSessionId: string | null;
  chatState: ChatState;
  isOpen: boolean;
  loadState: LoadState;
  modelState: ModelState;
  onToggle: () => void;
  sessionError: string | null;
  settingsState: SettingsState;
}) {
  return (
    <section
      className="settings-section settings-advanced"
      data-testid="settings-advanced-section"
      id="settings-advanced"
    >
      <div className="panel-header panel-header-inline">
        <div>
          <h3>Advanced</h3>
          <span>Diagnostics</span>
        </div>
        <button
          aria-expanded={isOpen}
          className="secondary-button"
          data-testid="settings-advanced-toggle"
          type="button"
          onClick={onToggle}
        >
          Advanced Diagnostics
        </button>
      </div>
      {isOpen ? (
        <div
          className="settings-advanced-content"
          data-testid="advanced-diagnostics"
        >
          <SessionDiagnostics
            activeSessionId={activeSessionId}
            chatState={chatState}
            modelState={modelState}
            sessionError={sessionError}
            settingsState={settingsState}
          />
          <RuntimeDetails loadState={loadState} />
        </div>
      ) : null}
    </section>
  );
}

function SessionDiagnostics({
  activeSessionId,
  chatState,
  modelState,
  sessionError,
  settingsState,
}: {
  activeSessionId: string | null;
  chatState: ChatState;
  modelState: ModelState;
  sessionError: string | null;
  settingsState: SettingsState;
}) {
  return (
    <section className="settings-diagnostics-block">
      <div className="panel-header panel-header-inline">
        <h3>Session Diagnostics</h3>
      </div>
      <dl className="runtime-details">
        <div>
          <dt>Active</dt>
          <dd>{activeSessionId || 'None'}</dd>
        </div>
        <div>
          <dt>Commands</dt>
          <dd>{chatState.availableCommands.length}</dd>
        </div>
        <div>
          <dt>Skills</dt>
          <dd>{chatState.availableSkills.length}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{chatState.latestUsage?.usage?.totalTokens ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Settings path</dt>
          <dd>{settingsState.settings?.settingsPath ?? 'Unknown'}</dd>
        </div>
        {sessionError || chatState.error ? (
          <div>
            <dt>Error</dt>
            <dd className="error-text">{sessionError || chatState.error}</dd>
          </div>
        ) : null}
        {modelState.error ? (
          <div>
            <dt>Config</dt>
            <dd className="error-text">{modelState.error}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function RuntimeDetails({ loadState }: { loadState: LoadState }) {
  if (loadState.state === 'loading') {
    return (
      <section
        className="settings-diagnostics-block"
        data-testid="runtime-diagnostics"
      >
        <div className="panel-header panel-header-inline">
          <h3>Runtime Diagnostics</h3>
        </div>
        <div className="runtime-row muted">Checking service</div>
      </section>
    );
  }

  if (loadState.state === 'error') {
    return (
      <section
        className="settings-diagnostics-block"
        data-testid="runtime-diagnostics"
      >
        <div className="panel-header panel-header-inline">
          <h3>Runtime Diagnostics</h3>
        </div>
        <div className="runtime-row error-text">{loadState.message}</div>
      </section>
    );
  }

  return (
    <section
      className="settings-diagnostics-block"
      data-testid="runtime-diagnostics"
    >
      <div className="panel-header panel-header-inline">
        <h3>Runtime Diagnostics</h3>
      </div>
      <dl className="runtime-details">
        <div>
          <dt>Server</dt>
          <dd>{loadState.status.serverUrl}</dd>
        </div>
        <div>
          <dt>Desktop</dt>
          <dd>{loadState.status.runtime.desktop.version}</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>
            {loadState.status.runtime.platform.type}-
            {loadState.status.runtime.platform.arch}
          </dd>
        </div>
        <div>
          <dt>Node</dt>
          <dd>{loadState.status.runtime.desktop.nodeVersion}</dd>
        </div>
        <div>
          <dt>ACP</dt>
          <dd>
            {loadState.status.runtime.cli.acpReady ? 'Ready' : 'Not started'}
          </dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>{loadState.status.health.uptimeMs} ms</dd>
        </div>
      </dl>
    </section>
  );
}

function formatAuthType(value: string | null | undefined): string {
  if (!value) {
    return 'Not configured';
  }

  const normalized = value.toLowerCase();
  if (normalized === 'openai' || normalized === 'use_openai') {
    return 'OpenAI';
  }

  if (normalized.includes('oauth')) {
    return 'OAuth';
  }

  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function formatProviderLabel(provider: SettingsFormState['provider']): string {
  return provider === 'coding-plan' ? 'Coding Plan' : 'API key';
}

function formatSecretStatus(value: boolean | undefined): string {
  if (value === undefined) {
    return 'Unknown';
  }

  return value ? 'Configured' : 'Missing';
}
