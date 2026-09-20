import React from 'react';
import ReactDOM from 'react-dom/client';
import { ManagedAgentWebShell } from '../../../../web-shell/client/ManagedAgentWebShell';

const params = new URLSearchParams(window.location.search);
const tenantId = params.get('tenant') || 'local-java-demo';
const sessionId = params.get('managedSession') || undefined;

function selectSession(nextSessionId: string | undefined): void {
  const url = new URL(window.location.href);
  if (nextSessionId) url.searchParams.set('managedSession', nextSessionId);
  else url.searchParams.delete('managedSession');
  window.history.replaceState(null, '', url);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ManagedAgentWebShell
      baseUrl={window.location.origin}
      getHeaders={() => ({ 'X-Qwen-Tenant-Id': tenantId })}
      language="zh-CN"
      onSessionChange={selectSession}
      productScope={tenantId}
      sessionId={sessionId}
      style={{ height: '100%' }}
    />
  </React.StrictMode>,
);
