import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { WebShellProps } from '../App';
import '../styles/standalone.css';

const indexEntry = '../index.tsx';
const { WebShellWithProviders } = await import(/* @vite-ignore */ indexEntry);
const params = new URLSearchParams(window.location.search);
const splitSessionIds = params.get('split')?.split(',');
document.documentElement.classList.add('theme-dark', 'dark');

function ApprovalModeHarness() {
  const [allowedApprovalModes, setAllowedApprovalModes] = useState<
    WebShellProps['allowedApprovalModes']
  >(
    params.has('allowed')
      ? (params.get('allowed')!.split(',').filter(Boolean) as NonNullable<
          WebShellProps['allowedApprovalModes']
        >)
      : undefined,
  );
  useEffect(() => {
    const update = (event: Event) => {
      setAllowedApprovalModes(
        (event as CustomEvent<WebShellProps['allowedApprovalModes']>).detail,
      );
    };
    window.addEventListener('approval-modes-change', update);
    return () => window.removeEventListener('approval-modes-change', update);
  }, []);
  return (
    <WebShellWithProviders
      baseUrl={window.location.origin}
      sessionId={params.get('sessionId') ?? 'approval-mode-harness-e2e'}
      workspaceCwd={params.get('workspaceCwd') ?? '/tmp/qwen-web-shell-e2e'}
      theme="dark"
      allowedApprovalModes={allowedApprovalModes}
      splitSessionIds={splitSessionIds}
      composerToolbarActions={
        params.has('plan') ? ['approvalMode', 'plan', 'addMenu'] : undefined
      }
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApprovalModeHarness />
  </React.StrictMode>,
);
