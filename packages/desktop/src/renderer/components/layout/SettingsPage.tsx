/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dispatch } from 'react';
import type { ChatState } from '../../stores/chatStore.js';
import type { ModelState } from '../../stores/modelStore.js';
import type {
  SettingsAction,
  SettingsState,
} from '../../stores/settingsStore.js';
import type { DesktopApprovalMode } from '../../../shared/desktopProtocol.js';
import type { LoadState } from './types.js';

export function SettingsPage({
  activeSessionId,
  chatState,
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
  return (
    <section
      className="panel settings-page"
      aria-label="Settings"
      data-testid="settings-page"
    >
      <div className="panel-header settings-page-header">
        <h3>Settings</h3>
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>
      </div>
      <div className="settings-page-content">
        <SettingsPanel
          state={settingsState}
          onAuthenticate={onAuthenticate}
          onDispatch={onSettingsDispatch}
          onSave={onSaveSettings}
        />
        <div className="settings-page-meta">
          <SessionDetails
            activeSessionId={activeSessionId}
            chatState={chatState}
            modelState={modelState}
            sessionError={sessionError}
            onModeChange={onModeChange}
            onModelChange={onModelChange}
          />
          <RuntimeDetails loadState={loadState} />
        </div>
      </div>
    </section>
  );
}

function SettingsPanel({
  onAuthenticate,
  onDispatch,
  onSave,
  state,
}: {
  onAuthenticate: (methodId: string) => void;
  onDispatch: Dispatch<SettingsAction>;
  onSave: () => void;
  state: SettingsState;
}) {
  const provider = state.form.provider;

  return (
    <section
      className="settings-section settings-panel"
      data-testid="model-config"
    >
      <div className="panel-header panel-header-inline">
        <h3>Auth & Model</h3>
      </div>
      <div className="settings-form">
        <label>
          <span>Provider</span>
          <select
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
          <button
            className="secondary-button"
            type="button"
            onClick={() => onAuthenticate('qwen-oauth')}
          >
            OAuth
          </button>
          <button
            className="primary-button"
            disabled={state.loading || state.saving}
            type="button"
            onClick={onSave}
          >
            {state.saving ? 'Saving' : 'Save'}
          </button>
        </div>

        {state.settings ? (
          <p className="settings-summary">
            {state.settings.selectedAuthType || 'No auth'} ·{' '}
            {state.settings.model.name || 'No model'}
          </p>
        ) : null}
        {state.error ? <p className="error-text">{state.error}</p> : null}
      </div>
    </section>
  );
}

function SessionDetails({
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

  return (
    <section className="settings-section session-details">
      <div className="panel-header panel-header-inline">
        <h3>Session</h3>
      </div>
      <dl className="runtime-details">
        <div>
          <dt>Active</dt>
          <dd>{activeSessionId || 'None'}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>
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
              currentMode || 'Unknown'
            )}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            {modelState.models ? (
              <select
                disabled={!activeSessionId || modelState.savingModel}
                value={currentModel}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {modelState.models.availableModels.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              currentModel || 'Unknown'
            )}
          </dd>
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
      <section className="settings-section">
        <div className="panel-header panel-header-inline">
          <h3>Runtime</h3>
        </div>
        <div className="runtime-row muted">Checking service</div>
      </section>
    );
  }

  if (loadState.state === 'error') {
    return (
      <section className="settings-section">
        <div className="panel-header panel-header-inline">
          <h3>Runtime</h3>
        </div>
        <div className="runtime-row error-text">{loadState.message}</div>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <div className="panel-header panel-header-inline">
        <h3>Runtime</h3>
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
