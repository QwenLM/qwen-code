import { createRoot } from 'react-dom/client';
import { ManagedAgentWebShell } from '../../ManagedAgentWebShell';
import { WebShellThemeId } from '../../themeContext';

const params = new URLSearchParams(window.location.search);

createRoot(document.getElementById('root')!).render(
  <ManagedAgentWebShell
    sessionId={params.get('session') ?? undefined}
    baseUrl={window.location.origin}
    productScope="managed-ui-test:actor"
    getHeaders={() => ({ 'X-Qwen-Tenant-Id': 'managed-ui-test' })}
    enableWorkspaceBinding
    modelPresets={[
      { agentId: 'agent-a', label: 'Model A' },
      { agentId: 'agent-b', label: 'Model B' },
    ]}
    language={params.get('language') === 'zh-CN' ? 'zh-CN' : 'en'}
    theme={
      params.get('theme') === 'light'
        ? WebShellThemeId.Light
        : WebShellThemeId.Dark
    }
    style={{ height: '100%' }}
  />,
);
