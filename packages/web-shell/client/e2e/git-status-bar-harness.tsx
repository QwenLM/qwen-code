import '../styles/globals.css';
import '../styles/standalone.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DaemonWorkspaceGitStatus } from '@qwen-code/sdk/daemon';
import { WebShellWithProviders } from '../index';
import appStyles from '../App.module.css';
import {
  ChatEditor,
  type ComposerToolbarAction,
} from '../components/ChatEditor';
import type { SessionGitIntent } from '../components/GitModePopover';
import { WebShellCustomizationProvider } from '../customization';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import { ThemeProvider, WebShellThemeId } from '../themeContext';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') === 'app' ? 'app' : 'chatEditor';
const theme =
  params.get('theme') === 'light'
    ? WebShellThemeId.Light
    : WebShellThemeId.Dark;
const language = params.get('language') === 'zh-CN' ? 'zh-CN' : 'en';
const showcase = params.get('showcase') === '1';
const widthParam = Number(params.get('width') ?? 360);
const width = Number.isFinite(widthParam) && widthParam > 0 ? widthParam : 360;
const placementParam = params.get('placement');
const placement: 'toolbar' | 'below' | 'header' =
  placementParam === 'below' || placementParam === 'header'
    ? placementParam
    : 'toolbar';
const statusKind = params.get('status') ?? 'conflicted';
const intentKind = params.get('intent') ?? 'current';
const branchName = params.get('branch') ?? 'feat/compact-git-status';

document.documentElement.classList.remove('theme-dark', 'theme-light', 'dark');
if (theme === WebShellThemeId.Light) {
  document.documentElement.classList.add('theme-light');
} else {
  document.documentElement.classList.add('theme-dark', 'dark');
}

function buildStatus(kind: string, branch: string): DaemonWorkspaceGitStatus {
  const base: DaemonWorkspaceGitStatus = {
    v: 2,
    workspaceCwd: '/tmp/qwen-web-shell-e2e',
    branch,
    computedAt: 1_760_000_000_000,
  };
  switch (kind) {
    case 'conflicted':
      return { ...base, conflicted: 2, staged: 1, ahead: 1 };
    case 'rebase':
      return { ...base, operation: 'rebase', ahead: 2 };
    case 'detached':
      return { ...base, branch: null, detached: true };
    case 'dirty':
      return { ...base, staged: 3, unstaged: 2, ahead: 2, behind: 1 };
    case 'rich':
      return {
        ...base,
        operation: 'rebase',
        conflicted: 2,
        staged: 1,
        ahead: 3,
        behind: 1,
        stashCount: 2,
      };
    case 'clean':
    default:
      return base;
  }
}

function buildIntent(kind: string): SessionGitIntent {
  if (kind === 'branch') {
    return {
      mode: 'branch',
      name: params.get('intentName') ?? 'feat/status-bar',
    };
  }
  if (kind === 'worktree') {
    return { mode: 'worktree' };
  }
  return { mode: 'current' };
}

const TOOLBAR_ACTIONS: readonly ComposerToolbarAction[] = [
  'addMenu',
  'approvalMode',
  'contextUsage',
  'gitBranch',
  'model',
];

function ComposerHarness({
  composerWidth,
  initialStatus,
  initialIntent,
  initialBranch = branchName,
  testId,
}: {
  composerWidth: number;
  initialStatus: string;
  initialIntent: string;
  initialBranch?: string;
  testId?: string;
}) {
  const [intent, setIntent] = useState<SessionGitIntent>(() =>
    buildIntent(initialIntent),
  );
  const [currentMode, setCurrentMode] = useState('default');
  const [currentModel, setCurrentModel] = useState('qwen3.8-max');

  return (
    <div
      data-testid={testId}
      style={{
        width: `${composerWidth}px`,
        maxWidth: '100%',
      }}
    >
      <ChatEditor
        onSubmit={() => undefined}
        commands={[]}
        attachmentsEnabled={false}
        workspaceFeaturesEnabled
        currentMode={currentMode}
        availableModes={['default', 'auto-edit', 'yolo']}
        onSelectMode={setCurrentMode}
        currentModel={currentModel}
        availableModels={[{ id: 'qwen3.8-max', label: 'Qwen 3.8 Max' }]}
        onSelectModel={setCurrentModel}
        visibleToolbarActions={TOOLBAR_ACTIONS}
        contextChipPlacement={placement}
        showChatWidthToggle={false}
        tokenCount={42_000}
        contextWindow={100_000}
        contextUsageKnown
        contextUsageAlwaysVisible
        onOpenContextUsage={() => undefined}
        gitBranch={initialBranch}
        gitStatus={buildStatus(initialStatus, initialBranch)}
        gitModeIntent={intent}
        onGitModeIntentChange={setIntent}
      />
    </div>
  );
}

function ShowcaseBoard() {
  const narrowCases = [
    {
      id: 'conflicted',
      title: 'Narrow Toolbar · Conflicted (error dot)',
      status: 'conflicted',
      intent: 'current',
      branch: 'feat/merge-conflict',
    },
    {
      id: 'rebase',
      title: 'Narrow Toolbar · Rebasing (warning dot)',
      status: 'rebase',
      intent: 'current',
      branch: 'feat/rebase-branch',
    },
    {
      id: 'detached',
      title: 'Narrow Toolbar · Detached HEAD (warning dot)',
      status: 'detached',
      intent: 'current',
      branch: 'a1b2c3d',
    },
    {
      id: 'dirty',
      title: 'Narrow Toolbar · Dirty Tree (accent dot)',
      status: 'dirty',
      intent: 'current',
      branch: 'feat/working-changes',
    },
  ];

  const wideCases = [
    {
      id: 'wide-rich',
      title:
        'Wide Toolbar · Current Branch (Rebase + Conflicted + Ahead/Behind + Stash)',
      status: 'rich',
      intent: 'current',
      branch: 'feat/status-polish',
    },
    {
      id: 'wide-branch',
      title: 'Wide Toolbar · Armed New Branch Intent',
      status: 'dirty',
      intent: 'branch',
      branch: 'main',
    },
    {
      id: 'wide-worktree',
      title: 'Wide Toolbar · Armed Worktree Intent',
      status: 'conflicted',
      intent: 'worktree',
      branch: 'main',
    },
  ];

  const labelStyle: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 600,
    marginBottom: '6px',
    color: 'var(--muted-foreground)',
    fontFamily: 'var(--font-sans)',
  };

  return (
    <div
      data-testid="git-status-showcase"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '20px',
        maxWidth: '860px',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '16px',
        }}
      >
        {narrowCases.map((entry) => (
          <div key={entry.id}>
            <div style={labelStyle}>{entry.title}</div>
            <ComposerHarness
              testId={`showcase-${entry.id}`}
              composerWidth={360}
              initialStatus={entry.status}
              initialIntent={entry.intent}
              initialBranch={entry.branch}
            />
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {wideCases.map((entry) => (
          <div key={entry.id}>
            <div style={labelStyle}>{entry.title}</div>
            <ComposerHarness
              testId={`showcase-${entry.id}`}
              composerWidth={760}
              initialStatus={entry.status}
              initialIntent={entry.intent}
              initialBranch={entry.branch}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function HarnessRoot() {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const rootClassName = [
    appStyles.app,
    theme === WebShellThemeId.Light
      ? appStyles.themeLight
      : appStyles.themeDark,
    theme === WebShellThemeId.Dark ? 'dark' : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    document.body.style.background =
      theme === WebShellThemeId.Light ? '#ffffff' : '#0d0d0d';
  }, []);

  if (mode === 'app') {
    return (
      <WebShellWithProviders
        baseUrl={window.location.origin}
        sessionId={params.get('sessionId') ?? undefined}
        workspaceCwd={params.get('workspaceCwd') ?? undefined}
        sidebar={false}
        theme={theme}
        header={{
          items: [
            'title',
            'environment',
            'rightPanel',
            'artifacts',
            'tokenUsage',
          ],
        }}
        composerToolbarAdditionalActions={['gitBranch']}
      />
    );
  }

  return (
    <ThemeProvider value={theme}>
      <I18nProvider language={language}>
        <WebShellPortalRootContext.Provider value={portalRoot}>
          <WebShellCustomizationProvider value={{ composerGlowEnabled: false }}>
            <div
              className={rootClassName}
              data-web-shell-root
              data-web-shell-shadcn
              style={{
                minHeight: '100vh',
                height: 'auto',
                overflow: 'visible',
                padding: showcase ? '0' : '24px',
              }}
            >
              {showcase ? (
                <ShowcaseBoard />
              ) : (
                <ComposerHarness
                  testId="harness-composer"
                  composerWidth={width}
                  initialStatus={statusKind}
                  initialIntent={intentKind}
                />
              )}
              <div
                ref={setPortalRoot}
                data-web-shell-portal-root
                data-web-shell-shadcn
                className={rootClassName}
                style={{
                  position: 'relative',
                  height: 0,
                  minHeight: 0,
                  overflow: 'visible',
                  padding: 0,
                  background: 'transparent',
                }}
              />
            </div>
          </WebShellCustomizationProvider>
        </WebShellPortalRootContext.Provider>
      </I18nProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HarnessRoot />
  </StrictMode>,
);
