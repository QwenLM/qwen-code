import type { PlatformContextValue } from './types.js';
import { useModalState } from './TempFileModal.js';

const React = window.React;

/**
 * Hook to provide platform context for the export HTML viewer
 */
export const usePlatformContext = () => {
  const { modalState, openModal, closeModal } = useModalState();

  const platformContext = React.useMemo(
    () =>
      ({
        platform: 'web' as PlatformContextValue['platform'],
        postMessage: (message: unknown) => {
          console.log('Posted message:', message);
        },
        onMessage: (handler: (event: MessageEvent) => void) => {
          window.addEventListener('message', handler);
          return () => window.removeEventListener('message', handler);
        },
        openFile: (path: string) => {
          console.log('Opening file:', path);
        },
        openTempFile: openModal,
        getResourceUrl: () => undefined,
        features: {
          canOpenFile: false,
          canOpenTempFile: true,
          canCopy: true,
        },
      }) satisfies PlatformContextValue,
    [openModal],
  );

  return { platformContext, modalState, closeModal };
};
