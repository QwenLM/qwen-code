import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PermissionRequest } from '../../adapters/types';
import { ToolApproval } from '../../components/messages/ToolApproval';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import '../../styles/globals.css';

const options: PermissionRequest['options'] = [
  { id: 'once', label: 'Allow once', kind: 'allow_once' },
  { id: 'proceed_always_project', label: 'Project', kind: 'allow_always' },
  { id: 'reject', label: 'Reject', kind: 'reject_once' },
];

function InlineApproval() {
  const [requestId, setRequestId] = useState('first');
  const [decision, setDecision] = useState('');

  return (
    <I18nProvider language="en">
      <WebShellPortalRootContext.Provider
        value={document.getElementById('portal')}
      >
        <button type="button" onClick={() => setRequestId('second')}>
          Replace request
        </button>
        <div style={{ overflow: 'hidden' }}>
          <ToolApproval
            request={{ id: requestId, content: [], options }}
            onConfirm={(id, optionId) => setDecision(`${id}/${optionId}`)}
          />
        </div>
        <output aria-label="Decision">{decision}</output>
      </WebShellPortalRootContext.Provider>
    </I18nProvider>
  );
}

createRoot(document.getElementById('root')!).render(<InlineApproval />);
