import type { ReactNode } from 'react';
import {
  DaemonSessionProvider,
  DaemonWorkspaceProvider,
} from '@qwen-code/webui/daemon-react-sdk';
import type { WebDaemonConfig } from '../config/daemon';

interface DaemonProvidersProps {
  config: WebDaemonConfig;
  children: ReactNode;
}

export function DaemonProviders({ config, children }: DaemonProvidersProps) {
  return (
    <DaemonWorkspaceProvider baseUrl={config.baseUrl} token={config.token}>
      <DaemonSessionProvider
        initialSessionId={config.initialSessionId}
        clientId={config.clientId}
        suppressOwnUserEcho
      >
        {children}
      </DaemonSessionProvider>
    </DaemonWorkspaceProvider>
  );
}
