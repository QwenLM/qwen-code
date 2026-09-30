import { createRoot } from 'react-dom/client';
import { ManagedAgentWebShell } from '../../ManagedAgentWebShell';

createRoot(document.getElementById('root')!).render(
  <ManagedAgentWebShell
    baseUrl={window.location.origin}
    productScope="w0d-browser:browser-actor"
    getHeaders={() => ({ 'X-Qwen-Tenant-Id': 'w0d-browser' })}
    enableWorkspaceBinding
    language="en"
  />,
);
