import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';
import { WebShellWithProviders } from '../index';

const params = new URLSearchParams(location.search);
function Harness() {
  const custom = params.has('custom');
  return (
    <div style={{ padding: 24, height: '100vh', boxSizing: 'border-box' }}>
      <div
        data-testid="host-shell"
        style={{
          width: params.has('narrow')
            ? 560
            : params.has('split-only')
              ? 800
              : '100%',
          height: '100%',
          maxWidth: '100%',
        }}
      >
        <WebShellWithProviders
          language="en-US"
          theme={params.has('light') ? 'light' : 'dark'}
          lockWorkspaceCwd={
            params.has('locked') ? '/tmp/qwen-web-shell-e2e' : undefined
          }
          sidebar={
            params.has('disabled')
              ? false
              : params.has('default')
                ? undefined
                : {
                    branding: params.has('hide-branding')
                      ? false
                      : params.has('hide-compact-branding')
                        ? { hideWhenCompact: true }
                        : undefined,
                    primaryNav: {
                      items:
                        params.has('single') || params.has('split-only')
                          ? ['newTask']
                          : params.has('plugin-only')
                            ? ['newTask', 'plugins']
                            : [
                                'newTask',
                                'plugins',
                                'channels',
                                'live',
                                'scheduledTasks',
                                'workflows',
                                'goals',
                                'managed',
                              ],
                    },
                    footer: {
                      items: params.has('split-only')
                        ? ['splitView', 'collapse']
                        : params.has('single') || params.has('plugin-only')
                          ? ['collapse']
                          : [
                              'settings',
                              'update',
                              'version',
                              'theme',
                              'sessionsOverview',
                              'splitView',
                              'daemonStatus',
                              'localFiles',
                              'collapse',
                            ],
                    },
                    showLive: params.has('live'),
                    showSessionSourceSwitch: !params.has('hide-source-switch'),
                    ...(custom
                      ? {
                          branding: { render: () => <div>Host brand</div> },
                          primaryNav: {
                            items: params.has('single')
                              ? ['newTask']
                              : ['newTask', 'plugins'],
                            render: () => <button>Host navigation</button>,
                          },
                          footer: {
                            items: params.has('single')
                              ? ['collapse']
                              : ['settings', 'collapse'],
                            render: () => <button>Host footer</button>,
                          },
                        }
                      : {}),
                  }
          }
        />
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
