import { createRoot } from 'react-dom/client';
import { ManagedAgentWebShell } from '../../ManagedAgentWebShell';

createRoot(document.getElementById('root')!).render(
  <ManagedAgentWebShell
    baseUrl={window.location.origin}
    productScope="managed-ui-test:actor"
    getHeaders={() => ({ 'X-Qwen-Tenant-Id': 'managed-ui-test' })}
    enableWorkspaceBinding
    modelPresets={[
      { agentId: 'agent-a', label: 'Model A' },
      { agentId: 'agent-b', label: 'Model B' },
    ]}
    language="en"
    style={{ height: '100%' }}
  />,
);
