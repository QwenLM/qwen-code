import { useEffect, useState } from 'react';

function readInitialValue(): boolean {
  return document.body.dataset.webShellTranscript === 'enabled';
}

export function useWebShellTranscriptEnabled(): boolean {
  const [enabled, setEnabled] = useState(readInitialValue);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: unknown;
        data?: { enabled?: unknown };
      };
      if (
        message.type === 'webShellTranscriptSettingChanged' &&
        typeof message.data?.enabled === 'boolean'
      ) {
        setEnabled(message.data.enabled);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return enabled;
}
