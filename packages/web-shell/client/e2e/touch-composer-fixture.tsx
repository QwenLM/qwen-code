import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatEditor } from '../components/ChatEditor';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../themeContext';
import { WebShellCustomizationProvider } from '../customization';
import { ManagedWorktreePopover } from '../components/managed/ManagedWorktreePopover';
import '../styles/globals.css';
import '../styles/standalone.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario');
const primaryCwd = '/tmp/qwen-code-x1-mobile-demo';
const longWorkspaceName = 'long-workspace-name-'.repeat(15);
const longCwd = `/tmp/${longWorkspaceName}`;

function Fixture() {
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState(
    scenario === 'wide-git' ||
      scenario === 'interactive-git' ||
      scenario === 'managed-worktree'
      ? longCwd
      : primaryCwd,
  );
  const [gitModeIntent, setGitModeIntent] = useState<
    | { mode: 'current' }
    | { mode: 'branch'; name: string }
    | { mode: 'worktree' }
  >({ mode: 'current' });
  const [managedOpen, setManagedOpen] = useState(false);
  const [managedWorktree, setManagedWorktree] = useState(false);
  if (scenario === 'managed-worktree') {
    return (
      <ChatEditor
        onSubmit={() => undefined}
        commands={[]}
        attachmentsEnabled={false}
        visibleToolbarActions={['workspace']}
        gitContextControl={
          <ManagedWorktreePopover
            worktree={managedWorktree}
            currentBranch={`feature/${'long-branch-'.repeat(6)}`}
            open={managedOpen}
            onOpenChange={setManagedOpen}
            disabled={false}
            onWorktreeChange={setManagedWorktree}
            onManage={() => undefined}
          />
        }
        workspaces={[
          {
            id: 'primary',
            label: longWorkspaceName,
            cwd: longCwd,
            primary: true,
            trusted: true,
          },
          {
            id: 'other',
            label: 'another-project',
            cwd: '/tmp/another-project',
            primary: false,
            trusted: true,
          },
        ]}
        selectedWorkspaceCwd={selectedWorkspaceCwd}
        onSelectWorkspace={(cwd) => setSelectedWorkspaceCwd(cwd ?? longCwd)}
      />
    );
  }
  if (scenario === 'wide-git' || scenario === 'interactive-git') {
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
          workspaceCwd: longCwd,
          branch: 'feature/mobile-single-row',
          staged: 2,
          computedAt: Date.now(),
        }}
        workspaces={[
          {
            id: 'primary',
            label: longWorkspaceName,
            cwd: longCwd,
            primary: true,
            trusted: true,
          },
          {
            id: 'other',
            label: 'another-project',
            cwd: '/tmp/another-project',
            primary: false,
            trusted: true,
          },
        ]}
        scratchWorkspaceSupported={scenario === 'interactive-git'}
        existingFolderWorkspaceSupported={scenario === 'interactive-git'}
        selectedWorkspaceCwd={selectedWorkspaceCwd}
        onSelectWorkspace={(cwd) => setSelectedWorkspaceCwd(cwd ?? longCwd)}
        gitModeIntent={gitModeIntent}
        onGitModeIntentChange={setGitModeIntent}
      />
    );
  }
  if (scenario === 'long-model' || scenario === 'long-mode') {
    const longMode =
      'An unnecessarily long approval mode label for narrow screen verification';
    return (
      <ChatEditor
        onSubmit={() => undefined}
        commands={[]}
        attachmentsEnabled={false}
        workspaceFeaturesEnabled
        shellModeEnabled
        currentMode={scenario === 'long-mode' ? longMode : 'default'}
        availableModes={
          scenario === 'long-mode' ? [longMode, 'default'] : ['default']
        }
        currentModel={
          scenario === 'long-model' ? 'deliberately-long-model' : 'short'
        }
        availableModels={
          scenario === 'long-model'
            ? [
                {
                  id: 'deliberately-long-model',
                  label:
                    'An unnecessarily long model label for narrow screen verification',
                },
              ]
            : [{ id: 'short', label: 'Short' }]
        }
        visibleToolbarActions={
          scenario === 'long-mode' ? ['approvalMode'] : ['model']
        }
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
