import { createRoot } from 'react-dom/client';
import { installWebShellShadowStyles } from './shadowDom';
import { WebShellWithProviders } from './index';
import type { WebShellLanguage, WebShellTheme } from './index';
import type { ManagedAgentProvider } from './components/managed/managed-agent-provider';

/**
 * 整页挂载入口：供非 React 宿主直接渲染完整 WebShell（官方侧栏、欢迎页、composer）。
 * 宿主通过 baseUrl 提供 daemon 协议地址，并可选注入 managedAgentProvider 作为会话数据源；
 * 入口本身不绘制任何外壳，也不内置任何具体后端地址。
 *
 * sidebar 配置：primaryNav 走组件默认（['newTask']，不渲染 rail）；footer 用显式列表，
 * 不可用项由组件自身隐藏。
 */
export interface WebShellAppHostProps {
  baseUrl: string;
  token?: string;
  language?: WebShellLanguage;
  theme?: WebShellTheme;
  sessionId?: string;
  workspaceId?: string;
  /** 由宿主注入的托管会话数据源（列表/创建/读写/事件），daemon 只负责启动与工作区。 */
  managedAgentProvider?: ManagedAgentProvider;
}

const REFERENCE_FOOTER_ITEMS = [
  'theme',
  'version',
  'sessionsOverview',
  'workspacesOverview',
  'splitView',
  'daemonStatus',
  'localFiles',
  'collapse',
] as const;

export function renderWebShellApp(
  container: Element,
  props: WebShellAppHostProps,
): { update(next: WebShellAppHostProps): void; unmount(): void } {
  const root = createRoot(container);
  const rootNode = container.getRootNode();
  const removeStyles =
    rootNode instanceof ShadowRoot ? installWebShellShadowStyles(rootNode) : undefined;
  const render = (next: WebShellAppHostProps) =>
    root.render(
      <WebShellWithProviders
        baseUrl={next.baseUrl}
        token={next.token}
        language={next.language}
        theme={next.theme}
        sessionId={next.sessionId}
        workspaceId={next.workspaceId}
        sessionContext={{ kind: 'standalone' }}
        managedAgentProvider={next.managedAgentProvider as never}
        sidebar={{
          enabled: true,
          showLive: false,
          footer: { items: [...REFERENCE_FOOTER_ITEMS] },
        }}
        composerToolbarAdditionalActions={['addMenu', 'plan']}
        showToolCalls
      />,
    );
  render(props);
  return {
    update: render,
    unmount() {
      root.unmount();
      removeStyles?.();
    },
  };
}
