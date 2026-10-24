import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';

const indexEntry = '../index.tsx';
const { WebShellWithProviders } = await import(/* @vite-ignore */ indexEntry);
const params = new URLSearchParams(window.location.search);
document.documentElement.classList.add('theme-dark', 'dark');

interface PickerResult {
  id: number;
  path?: string;
  error?: string;
}

function HostDirectoryPickerHarness() {
  const pending = useRef(
    new Map<
      number,
      { resolve: (path?: string) => void; reject: (error: Error) => void }
    >(),
  );
  const sequence = useRef(0);
  const [calls, setCalls] = useState(0);
  const [aborted, setAborted] = useState<number[]>([]);
  const [activePicker, setActivePicker] = useState<number>();
  const [hostPath, setHostPath] = useState('/srv/');
  useEffect(() => {
    const complete = (event: Event) => {
      const result = (event as CustomEvent<PickerResult>).detail;
      const request = pending.current.get(result.id);
      if (!request) return;
      pending.current.delete(result.id);
      setActivePicker((active) => (active === result.id ? undefined : active));
      if (result.error) request.reject(new Error(result.error));
      else request.resolve(result.path);
    };
    window.addEventListener('host-picker-result', complete);
    return () => window.removeEventListener('host-picker-result', complete);
  }, []);

  return (
    <>
      <output data-testid="host-picker-calls" hidden>
        {calls}
      </output>
      <output data-testid="host-picker-aborted" hidden>
        {JSON.stringify(aborted)}
      </output>
      {params.get('interactiveHost') === 'true' &&
        activePicker !== undefined && (
          <div
            role="dialog"
            aria-label="Host directory browser"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 120,
              zIndex: 100000,
              padding: 32,
              color: '#eee',
              background: '#202020',
              border: '1px solid #777',
            }}
          >
            <h2>Host directory browser</h2>
            <label htmlFor="host-directory-path">
              Directory on connected daemon
            </label>
            <input
              id="host-directory-path"
              autoFocus
              value={hostPath}
              onChange={(event) => setHostPath(event.target.value)}
              style={{ display: 'block', width: '100%', margin: '24px 0' }}
            />
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('host-picker-result', {
                    detail: { id: activePicker, path: hostPath },
                  }),
                )
              }
            >
              Select host directory
            </button>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('host-picker-result', {
                    detail: { id: activePicker },
                  }),
                )
              }
            >
              Cancel host selection
            </button>
          </div>
        )}
      <WebShellWithProviders
        baseUrl={params.get('daemon') ?? window.location.origin}
        sessionId={params.get('sessionId') ?? undefined}
        theme="dark"
        language="en"
        onPickWorkspaceDirectory={
          params.get('hostPicker') === 'false'
            ? undefined
            : (opts?: { signal?: AbortSignal }) => {
                const id = ++sequence.current;
                setCalls(id);
                setActivePicker(id);
                opts?.signal?.addEventListener(
                  'abort',
                  () => {
                    setAborted((previous) => [...previous, id]);
                    setActivePicker((active) =>
                      active === id ? undefined : active,
                    );
                  },
                  { once: true },
                );
                // Deliberately ignore abort when settling, so the public shell
                // must reject stale results independently of host cooperation.
                return new Promise<string | undefined>((resolve, reject) => {
                  pending.current.set(id, { resolve, reject });
                });
              }
        }
      />
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HostDirectoryPickerHarness />
  </React.StrictMode>,
);
