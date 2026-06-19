import { useMemo, useState } from 'react';
import { useSettings } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSettingDescriptor } from '@qwen-code/webui/daemon-react-sdk';
import {
  errorMessage,
  formatUnknown,
  ResourceState,
} from '../common/ResourceState';

export function SettingsPanel() {
  const settings = useSettings({ autoLoad: true });
  const [query, setQuery] = useState('');
  const [draftByKey, setDraftByKey] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();

  const filteredSettings = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return settings.settings;
    return settings.settings.filter((setting) =>
      `${setting.key} ${setting.label} ${setting.category} ${
        setting.description ?? ''
      }`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [query, settings.settings]);

  async function saveSetting(setting: DaemonSettingDescriptor) {
    setSavingKey(setting.key);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      const draft = getDraft(setting, draftByKey[setting.key]);
      const value = parseDraft(setting, draft);
      const result = await settings.setValue('workspace', setting.key, value);
      await settings.reload();
      setActionMessage(
        result.requiresRestart
          ? `${setting.label} saved. Restart required.`
          : `${setting.label} saved.`,
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSavingKey(undefined);
    }
  }

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>Settings</h2>
          <p>
            {filteredSettings.length} / {settings.settings.length} setting
            {settings.settings.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void settings.reload()}>
          Refresh
        </button>
      </div>
      <div className="web-filter-bar">
        <input
          aria-label="Search settings"
          name="settings-search"
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {settings.status?.warnings?.length ? (
        <div className="web-error">
          {settings.status.warnings.map((warning) => warning.type).join(' · ')}
        </div>
      ) : null}
      {actionError ? <div className="web-error">{actionError}</div> : null}
      {actionMessage ? (
        <div className="web-action-result">{actionMessage}</div>
      ) : null}
      <ResourceState
        loading={settings.loading}
        error={settings.error}
        empty={filteredSettings.length === 0}
        emptyText="No settings match the current filters."
      >
        <div className="web-list">
          {filteredSettings.map((setting) => {
            const draft = getDraft(setting, draftByKey[setting.key]);
            const savedDraft = formatDraft(
              setting.values.workspace ?? setting.values.effective,
            );
            const dirty = draft !== savedDraft;
            const saving = savingKey === setting.key;
            return (
              <article className="web-card" key={setting.key}>
                <div className="web-card-main">
                  <h3>{setting.label}</h3>
                  <p>{setting.description ?? setting.key}</p>
                  <div className="web-meta">
                    <span>{setting.category}</span>
                    <span>{setting.type}</span>
                    {setting.requiresRestart ? (
                      <span>restart required</span>
                    ) : null}
                  </div>
                  <div className="settings-grid">
                    <span>Key</span>
                    <code>{setting.key}</code>
                    <span>Effective</span>
                    <code>{formatUnknown(setting.values.effective)}</code>
                    <span>Workspace</span>
                    <code>{formatUnknown(setting.values.workspace)}</code>
                    <span>Default</span>
                    <code>{formatUnknown(setting.default)}</code>
                  </div>
                  <SettingInput
                    draft={draft}
                    setting={setting}
                    onChange={(value) =>
                      setDraftByKey((prev) => ({
                        ...prev,
                        [setting.key]: value,
                      }))
                    }
                  />
                </div>
                <div className="web-card-actions">
                  <button
                    type="button"
                    disabled={!dirty || saving}
                    onClick={() => void saveSetting(setting)}
                  >
                    {saving ? 'Saving' : 'Save workspace'}
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || saving}
                    onClick={() =>
                      setDraftByKey((prev) => ({
                        ...prev,
                        [setting.key]: savedDraft,
                      }))
                    }
                  >
                    Reset
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </ResourceState>
    </div>
  );
}

function SettingInput({
  draft,
  onChange,
  setting,
}: {
  draft: string;
  onChange: (value: string) => void;
  setting: DaemonSettingDescriptor;
}) {
  if (setting.options?.length) {
    return (
      <select
        className="web-select"
        aria-label={`Workspace value for ${setting.label}`}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
      >
        {setting.options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (setting.type === 'boolean') {
    return (
      <select
        className="web-select"
        aria-label={`Workspace value for ${setting.label}`}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (setting.type === 'number' || setting.type === 'integer') {
    return (
      <input
        className="web-input"
        aria-label={`Workspace value for ${setting.label}`}
        type="number"
        value={draft}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (isStructuredDraft(draft)) {
    return (
      <textarea
        className="web-textarea settings-editor"
        aria-label={`Workspace value for ${setting.label}`}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <input
      className="web-input"
      aria-label={`Workspace value for ${setting.label}`}
      value={draft}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function getDraft(setting: DaemonSettingDescriptor, draft?: string) {
  return (
    draft ?? formatDraft(setting.values.workspace ?? setting.values.effective)
  );
}

function formatDraft(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value ?? '', null, 2);
}

function parseDraft(setting: DaemonSettingDescriptor, draft: string): unknown {
  const option = setting.options?.find(
    (candidate) => String(candidate.value) === draft,
  );
  if (option) return option.value;
  if (setting.type === 'boolean') return draft === 'true';
  if (setting.type === 'number' || setting.type === 'integer') {
    return Number(draft);
  }
  if (isStructuredDraft(draft)) return JSON.parse(draft);
  return draft;
}

function isStructuredDraft(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}
