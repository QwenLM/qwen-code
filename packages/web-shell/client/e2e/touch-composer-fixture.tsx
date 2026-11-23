import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatEditor } from '../components/ChatEditor';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../themeContext';
import { WebShellCustomizationProvider } from '../customization';
import '../styles/globals.css';
import '../styles/standalone.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario');
const primaryCwd = '/tmp/qwen-code-x1-mobile-demo';
const longCwd = `/tmp/${'long-workspace-name-'.repeat(15)}`;

function Fixture() {
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState(
    scenario === 'wide-git' ? longCwd : primaryCwd,
  );
  if (scenario === 'wide-git') {
    return (
      <ChatEditor
        onSubmit={() => undefined}
        commands={[]}
        attachmentsEnabled={false}
        workspaceFeaturesEnabled
        shellModeEnabled
        currentModel="qwen-test"
        availableModels={[{ id: 'qwen-test', label: 'Qwen Test' }]}
        visibleToolbarActions={['workspace', 'gitBranch']}
        gitBranch="feature/mobile-single-row"
        gitStatus={{
          v: 2,
          workspaceCwd: primaryCwd,
          branch: 'feature/mobile-single-row',
          staged: 2,
          computedAt: Date.now(),
        }}
        workspaces={[
          { id: 'primary', cwd: longCwd, primary: true, trusted: true },
          {
            id: 'other',
            cwd: '/tmp/another-project',
            primary: false,
            trusted: true,
          },
        ]}
        selectedWorkspaceCwd={selectedWorkspaceCwd}
        onSelectWorkspace={setSelectedWorkspaceCwd}
        gitModeIntent={{ mode: 'current' }}
        onGitModeIntentChange={() => undefined}
      />
    );
  }
  if (scenario === 'long-model') {
    return (
      <ChatEditor
        onSubmit={() => undefined}
        commands={[]}
        attachmentsEnabled={false}
        workspaceFeaturesEnabled
        shellModeEnabled
        currentModel="deliberately-long-model"
        availableModels={[
          {
            id: 'deliberately-long-model',
            label:
              'An unnecessarily long model label for narrow screen verification',
          },
        ]}
        visibleToolbarActions={['model', 'approvalMode']}
      />
    );
  }
  if (scenario === 'no-add-history' || scenario === 'no-add-running') {
    return (
      <ChatEditor
        onSubmit={() => undefined}
        commands={[]}
        attachmentsEnabled={false}
        workspaceFeaturesEnabled
        shellModeEnabled
        onCancel={() => undefined}
        composerScopeKey={`probe-${scenario}`}
        currentModel="qwen-test"
        availableModels={[{ id: 'qwen-test', label: 'Qwen Test' }]}
        visibleToolbarActions={['contextUsage']}
        contextUsageAlwaysVisible
        contextWindow={100}
        tokenCount={60}
        isRunning={scenario === 'no-add-running'}
      />
    );
  }
  throw new Error(`Unknown touch composer fixture: ${scenario}`);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider language="en">
      <ThemeProvider value="dark">
        <main
          data-web-shell-root
          data-web-shell-shadcn
          className="theme-dark"
          style={{ minHeight: '100vh', padding: 24 }}
        >
          <WebShellCustomizationProvider value={{ composerGlowEnabled: false }}>
            <Fixture />
          </WebShellCustomizationProvider>
        </main>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
