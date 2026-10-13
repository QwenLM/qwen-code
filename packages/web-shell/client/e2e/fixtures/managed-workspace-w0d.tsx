import { createRoot } from 'react-dom/client';
import { createJavaManagedAgentProvider } from '../../components/managed/java-managed-agent-provider';
import { ManagedSessionsPage } from '../../components/managed/ManagedSessionsPage';
import { useState } from 'react';
import '../../styles/globals.css';
import { ThemeProvider, WebShellThemeId } from '../../themeContext';
import { WebShellPortalRootContext } from '../../portalRoot';
import { I18nProvider } from '../../i18n';

const provider = createJavaManagedAgentProvider({
  baseUrl: window.location.origin,
  productScope: 'w0d-browser:browser-actor',
  getHeaders: () => ({ 'X-Qwen-Tenant-Id': 'w0d-browser' }),
  enableWorkspaceBinding: true,
});
// Keep the Spring/SQL W0D gate on its original empty-only provider contract.
const legacyProvider = {
  ...provider,
  workspaceBinding: { ...provider.workspaceBinding!, createSession: undefined },
};

function EmptyWorkspaceFixture() {
  const [sessionId, setSessionId] = useState<string>();
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  return (
    <ThemeProvider value={WebShellThemeId.Dark}>
      <I18nProvider language="en">
        <WebShellPortalRootContext.Provider value={portalRoot}>
          <div
            ref={setPortalRoot}
            className="dark"
            data-web-shell-root
            data-web-shell-shadcn
          >
            <ManagedSessionsPage
              sessionId={sessionId}
              onSelectSession={setSessionId}
              managedAgentProvider={legacyProvider}
            />
          </div>
        </WebShellPortalRootContext.Provider>
      </I18nProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(<EmptyWorkspaceFixture />);
