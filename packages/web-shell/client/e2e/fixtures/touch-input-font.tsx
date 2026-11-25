/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRoot } from 'react-dom/client';
import { AddRuntimeDialog } from '../../components/workspace-agents/add-runtime-dialog';
import { SkillInstallDialog } from '../../components/skills/SkillInstallDialog';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { installWebShellShadowStyles } from '../../shadowDom';
import '../../styles/globals.css';

async function mount() {
  const options = new URLSearchParams(window.location.search);
  if (options.get('entry') === 'standalone') {
    await import('../../styles/standalone.css');
  }

  const root = document.getElementById('root')!;
  const app = document.createElement('div');
  const portal = document.createElement('div');
  app.dataset.webShellRoot = '';
  app.dataset.webShellShadcn = '';
  portal.dataset.webShellPortalRoot = '';
  portal.dataset.webShellShadcn = '';
  root.append(app);
  if (options.has('shadow')) {
    const host = document.createElement('div');
    host.dataset.webShellShadowHost = 'portals';
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    installWebShellShadowStyles(shadow);
    shadow.append(portal);
  } else {
    document.body.append(portal);
  }

  createRoot(app).render(
    <I18nProvider language="en">
      <WebShellPortalRootContext.Provider value={portal}>
        <input type="search" aria-label="App search" className="text-sm" />
        <textarea aria-label="App textarea" className="text-sm" />
        <div data-composer className="text-sm touch-input-font-composer">
          <div contentEditable className="cm-content" aria-label="App editor">
            <div className="cm-line">Text</div>
          </div>
        </div>
        {options.get('dialog') === 'runtime' ? (
          <AddRuntimeDialog
            open
            onOpenChange={() => {}}
            runtimes={[]}
            serverUrl={window.location.origin}
            onCreateJoinToken={async () => {
              throw new Error('Not used in this fixture');
            }}
          />
        ) : (
          <SkillInstallDialog
            open
            onOpenChange={() => {}}
            onInstall={async () => {}}
          />
        )}
      </WebShellPortalRootContext.Provider>
    </I18nProvider>,
  );
}

void mount();
