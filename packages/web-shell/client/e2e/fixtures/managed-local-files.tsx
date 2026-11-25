import { createRoot } from 'react-dom/client';
import { ManagedAgentWebShell } from '../../ManagedAgentWebShell';

createRoot(document.getElementById('root')!).render(
  <ManagedAgentWebShell
    sessionId={
      new URLSearchParams(window.location.search).get('session') ?? undefined
    }
    baseUrl={
      new URLSearchParams(window.location.search).get('api') ??
      window.location.origin
    }
    productScope="managed-local-files-test:actor"
    getHeaders={() => ({ 'X-Qwen-Tenant-Id': 'managed-local-files-test' })}
    enableWorkspaceBinding
    language="en"
    style={{ height: '100%' }}
  />,
);
