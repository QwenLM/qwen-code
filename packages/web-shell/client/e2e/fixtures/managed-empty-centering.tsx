import { createRoot } from 'react-dom/client';
import { ManagedAgentWebShell } from '../../ManagedAgentWebShell';

// A host slot outside the shell container, which is what puts the conversation
// in the `home` layout the empty-state rule targets.
const navigation = document.createElement('div');
document.body.insertBefore(navigation, document.getElementById('root'));

createRoot(document.getElementById('root')!).render(
  <ManagedAgentWebShell
    sessionId={
      new URLSearchParams(window.location.search).get('session') ?? undefined
    }
    baseUrl={window.location.origin}
    productScope="managed-centering-test:actor"
    navigationTarget={navigation}
    language="en"
    style={{ height: '100%' }}
  />,
);
