import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { createWebShellDaemonScenario } from './mockDaemon';

export const LONG_SESSION_TITLE = '优化 iPhone 会话列表标题与拉取请求审阅流程';

export function createSessionListDensityScenario() {
  const workspaceCwd = '/tmp/qwen-web-shell-mobile-sidebar';
  const sessions: DaemonSessionSummary[] = [
    {
      sessionId: 'density-long-title',
      workspaceCwd,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      displayName: LONG_SESSION_TITLE,
      clientCount: 1,
      hasActivePrompt: false,
      prs: [
        {
          number: 52484,
          state: 'open',
          url: 'https://github.com/QwenLM/qwen-code/pull/52484',
        },
      ],
    },
  ];
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'density-long-title',
    displayName: LONG_SESSION_TITLE,
    sessions,
  });
  scenario.capabilities.features.push(
    'session_organization',
    'session_archive',
    'session_archive_idle_guard',
  );
  return scenario;
}
