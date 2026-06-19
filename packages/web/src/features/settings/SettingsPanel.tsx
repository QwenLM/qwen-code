import { useSettings } from '@qwen-code/webui/daemon-react-sdk';
import { formatUnknown, ResourceState } from '../common/ResourceState';

export function SettingsPanel() {
  const settings = useSettings({ autoLoad: true });

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>Settings</h2>
          <p>
            {settings.settings.length} setting
            {settings.settings.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void settings.reload()}>
          Refresh
        </button>
      </div>
      <ResourceState
        loading={settings.loading}
        error={settings.error}
        empty={settings.settings.length === 0}
        emptyText="No settings reported by the daemon."
      >
        <div className="web-list">
          {settings.settings.map((setting) => (
            <article className="web-card" key={setting.key}>
              <div className="web-card-main">
                <h3>{setting.label}</h3>
                <p>{setting.description ?? setting.key}</p>
                <div className="settings-grid">
                  <span>Key</span>
                  <code>{setting.key}</code>
                  <span>Category</span>
                  <code>{setting.category}</code>
                  <span>Effective</span>
                  <code>{formatUnknown(setting.values.effective)}</code>
                  <span>Workspace</span>
                  <code>{formatUnknown(setting.values.workspace)}</code>
                </div>
              </div>
            </article>
          ))}
        </div>
      </ResourceState>
    </div>
  );
}
